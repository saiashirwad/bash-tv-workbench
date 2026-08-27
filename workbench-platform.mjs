import fs from "node:fs";
import fsp from "node:fs/promises";
import path from "node:path";
import os from "node:os";
import crypto from "node:crypto";
import { spawn } from "node:child_process";
import { createReadStream } from "node:fs";
import { rgPath } from "@vscode/ripgrep";

const MAX_CAPTURE = Math.max(
  64 * 1024,
  Number(process.env.BASH_WORKBENCH_PROCESS_OUTPUT_LIMIT) || 1024 * 1024,
);
const MAX_PROCESS_RECORDS = Math.max(
  10,
  Number(process.env.BASH_WORKBENCH_PROCESS_RECORD_LIMIT) || 200,
);
const PROCESS_RETENTION_MS = Math.max(
  1_000,
  Number(process.env.BASH_WORKBENCH_PROCESS_RETENTION_MS) || 15 * 60_000,
);
const MAX_ARTIFACT_SIZE = Math.max(
  1024 * 1024,
  Number(process.env.BASH_WORKBENCH_MAX_ARTIFACT_BYTES) || 512 * 1024 * 1024,
);
const MAX_ARTIFACT_STORAGE = Math.max(
  MAX_ARTIFACT_SIZE,
  Number(process.env.BASH_WORKBENCH_ARTIFACT_STORAGE_BYTES) ||
    2 * 1024 * 1024 * 1024,
);
const MAX_ARCHIVE_ENTRIES = 5_000;
const MAX_ARCHIVE_FILE_SIZE = 256 * 1024 * 1024;
const MAX_ARCHIVE_EXPANDED_SIZE = 1024 * 1024 * 1024;
const MAX_ARCHIVE_RATIO = 1_000;
const DEFAULT_CHUNK = 64 * 1024;
const SECRET_PATTERN =
  /(^|\/)(\.env(?:\..*)?|id_[re]sa|id_ed25519|.*\.(?:pem|key)|credentials(?:\.json)?|secrets?(?:\..*)?)$/i;
const AUTO_EXCLUDES = [
  "node_modules",
  ".cache",
  ".next",
  "dist",
  "build",
  "coverage",
  ".pnpm-store",
];
const now = () => new Date().toISOString();
const id = () => crypto.randomUUID();
const safeName = (value) =>
  String(value || "artifact")
    .replace(/[^a-zA-Z0-9._-]+/g, "-")
    .replace(/^[-.]+/, "")
    .slice(0, 100) || "artifact";
const error = (tag, message, details) =>
  Object.assign(new Error(message), { _tag: tag, details });
const redactText = (value) =>
  String(value ?? "")
    .replace(
      /\b(?:sk|ghp|github_pat|xox[baprs])-?[A-Za-z0-9_-]{8,}\b/g,
      "<redacted>",
    )
    .replace(
      /((?:token|password|secret|authorization|cookie)\s*[=:]\s*)[^\s'\"]+/gi,
      "$1<redacted>",
    )
    .replace(
      /-----BEGIN [^-]*PRIVATE KEY-----[\s\S]*?-----END [^-]*PRIVATE KEY-----/g,
      "<redacted-private-key>",
    );
const SAFE_ENV_KEYS = new Set([
  "PATH",
  "HOME",
  "SHELL",
  "LANG",
  "LANGUAGE",
  "LC_ALL",
  "LC_CTYPE",
  "TERM",
  "COLORTERM",
  "TMPDIR",
  "TZ",
  "USER",
  "LOGNAME",
]);
const PROCESS_KILL_GRACE_MS = 250;
const signalProcessGroup = (child, signal) => {
  try {
    if (child.pid) process.kill(-child.pid, signal);
    else child.kill(signal);
  } catch (cause) {
    if (cause?.code !== "ESRCH") throw cause;
  }
};
const terminateProcessGroup = (child) => {
  signalProcessGroup(child, "SIGTERM");
  const force = setTimeout(() => {
    try {
      signalProcessGroup(child, "SIGKILL");
    } catch {}
  }, PROCESS_KILL_GRACE_MS);
  force.unref?.();
  return force;
};
const childEnvironment = (extra = {}) => {
  const env = {};
  for (const key of SAFE_ENV_KEYS)
    if (process.env[key] !== undefined) env[key] = process.env[key];
  const allowedExtra = new Set(
    String(process.env.BASH_WORKBENCH_CHILD_ENV_ALLOWLIST || "")
      .split(",")
      .map((x) => x.trim())
      .filter(Boolean),
  );
  for (const [key, value] of Object.entries(extra)) {
    if (!allowedExtra.has(key))
      throw error(
        "EnvironmentVariableDenied",
        `Child environment variable is not allowlisted: ${key}`,
      );
    env[key] = String(value);
  }
  return env;
};

export function makeWorkbenchPlatform({
  projects,
  stateRoot,
  clock = Date.now,
  processRetentionMs = PROCESS_RETENTION_MS,
  maxProcessRecords = MAX_PROCESS_RECORDS,
}) {
  const processes = new Map();
  const outputs = new Map();
  const processNowMs = () => Number(clock());
  const processTimestamp = () => {
    const milliseconds = processNowMs();
    return { milliseconds, iso: new Date(milliseconds).toISOString() };
  };
  const pruneProcesses = () => {
    const currentTime = processNowMs();
    for (const [key, value] of processes)
      if (
        value.status !== "running" &&
        currentTime - value.endedAtMs > processRetentionMs
      )
        processes.delete(key);
  };
  const removeOldestCompletedProcess = () => {
    let oldest;
    for (const entry of processes)
      if (
        entry[1].status !== "running" &&
        (!oldest || entry[1].endedAtMs < oldest[1].endedAtMs)
      )
        oldest = entry;
    if (oldest) processes.delete(oldest[0]);
    return !!oldest;
  };
  const artifactRoot = path.resolve(stateRoot, "artifacts-v1");
  const snapshotRoot = path.resolve(stateRoot, "snapshots-v1");
  const auditFile = path.resolve(stateRoot, "audit-v1.jsonl");
  const init = Promise.all([
    fsp.mkdir(artifactRoot, { recursive: true }),
    fsp.mkdir(snapshotRoot, { recursive: true }),
  ]);
  const project = (projectId) => {
    const selected = projects.get(String(projectId || ""));
    if (!selected)
      throw error("UnknownProject", `Unknown project: ${projectId}`);
    return selected;
  };
  const contained = async (root, relative = "") => {
    if (String(relative).includes("\0"))
      throw error("InvalidPath", "Path contains a null byte");
    if (path.isAbsolute(String(relative)))
      throw error("PathEscape", "Absolute paths are not project-scoped");
    const base = await fsp.realpath(root);
    const target = path.resolve(base, String(relative));
    if (target !== base && !target.startsWith(base + path.sep))
      throw error("PathEscape", "Path escapes project root");
    let parent = target;
    while (parent !== base) {
      try {
        parent = await fsp.realpath(parent);
        break;
      } catch (cause) {
        if (cause?.code !== "ENOENT") throw cause;
        parent = path.dirname(parent);
      }
    }
    if (parent !== base && !parent.startsWith(base + path.sep))
      throw error("SymlinkEscape", "Symlink escapes project root");
    return target;
  };
  const audit = async (operation, input, result = "ok") => {
    await init;
    const redact = (value, key = "") => {
      if (
        /authorization|cookie|token|password|secret|private.?key|signed.?url|value/i.test(
          key,
        )
      )
        return "<redacted>";
      if (key === "content" || key === "patch" || key === "text")
        return `<${String(value ?? "").length} bytes>`;
      if (Array.isArray(value)) return value.map((item) => redact(item));
      if (value && typeof value === "object")
        return Object.fromEntries(
          Object.entries(value).map(([name, item]) => [
            name,
            redact(item, name),
          ]),
        );
      if (typeof value === "string") return redactText(value);
      return value;
    };
    await fsp.appendFile(
      auditFile,
      JSON.stringify({
        at: now(),
        operation,
        input: redact(input),
        result: redact(result),
      }) + "\n",
      { mode: 0o600 },
    );
    const records = (await fsp.readFile(auditFile, "utf8"))
      .split("\n")
      .filter(Boolean);
    const limit = Math.max(
      100,
      Number(process.env.BASH_WORKBENCH_AUDIT_LIMIT) || 5_000,
    );
    if (records.length > limit)
      await fsp.writeFile(auditFile, records.slice(-limit).join("\n") + "\n", {
        mode: 0o600,
      });
  };
  const changes = async (root, before) => {
    const current = await gitStatus(root).catch(() => "");
    const left = new Set(
      String(before || "")
        .split("\n")
        .filter(Boolean),
    );
    return current
      .split("\n")
      .filter(Boolean)
      .filter((line) => !left.has(line))
      .map((line) => line.slice(3));
  };
  const gitStatus = (cwd) =>
    runRaw("git", ["status", "--porcelain=v1"], cwd, 10_000).then(
      (x) => x.stdout,
    );
  const rememberOutput = (stdout, stderr) => {
    const outputId = id();
    outputs.set(outputId, {
      stdout: Buffer.from(stdout),
      stderr: Buffer.from(stderr),
      createdAt: Date.now(),
    });
    setTimeout(() => outputs.delete(outputId), 10 * 60_000).unref?.();
    return outputId;
  };
  const pageOutput = (
    outputId,
    stdout,
    stderr,
    stdoutCursor = 0,
    stderrCursor = 0,
    maxBytes = DEFAULT_CHUNK,
  ) => {
    const limit = Math.max(
      1024,
      Math.min(512 * 1024, Number(maxBytes) || DEFAULT_CHUNK),
    );
    const out = Buffer.isBuffer(stdout) ? stdout : Buffer.from(stdout);
    const err = Buffer.isBuffer(stderr) ? stderr : Buffer.from(stderr);
    const outStart = Math.max(0, Number(stdoutCursor) || 0),
      errStart = Math.max(0, Number(stderrCursor) || 0);
    const outChunk = out.subarray(outStart, outStart + limit);
    const errChunk = err.subarray(
      errStart,
      errStart + Math.max(0, limit - outChunk.length),
    );
    const nextOut = outStart + outChunk.length,
      nextErr = errStart + errChunk.length;
    return {
      stdout: outChunk.toString("utf8"),
      stderr: errChunk.toString("utf8"),
      outputId,
      stdoutCursor: nextOut,
      stderrCursor: nextErr,
      truncated: nextOut < out.length || nextErr < err.length,
    };
  };
  const runRaw = (
    command,
    args,
    cwd,
    timeoutMs = 30_000,
    env = {},
    options = {},
  ) =>
    new Promise((resolve, reject) => {
      const started = Date.now();
      const child = spawn(command, args, {
        cwd,
        env: childEnvironment(env),
        stdio: ["ignore", "pipe", "pipe"],
        detached: true,
      });
      let stdout = "",
        stderr = "",
        timedOut = false,
        cancelled = false,
        forceTimer;
      const terminate = () => {
        if (!forceTimer) forceTimer = terminateProcessGroup(child);
      };
      const onAbort = () => {
        cancelled = true;
        terminate();
      };
      options.signal?.addEventListener("abort", onAbort, { once: true });
      if (options.signal?.aborted) onAbort();
      const timer = setTimeout(() => {
        timedOut = true;
        terminate();
      }, Math.max(100, Math.min(300_000, timeoutMs)));
      child.stdout.on("data", (chunk) => {
        if (stdout.length < MAX_CAPTURE) stdout += chunk;
      });
      child.stderr.on("data", (chunk) => {
        if (stderr.length < MAX_CAPTURE) stderr += chunk;
      });
      child.on("error", reject);
      child.on("close", (exitCode, signal) => {
        clearTimeout(timer);
        options.signal?.removeEventListener("abort", onAbort);
        if (cancelled)
          return reject(error("OperationCancelled", "Operation was cancelled"));
        resolve({
          stdout,
          stderr,
          exitCode,
          signal,
          timedOut,
          durationMs: Date.now() - started,
        });
      });
    });

  const api = {
    async contentSearch(input, options = {}) {
      const selected = project(input.project);
      const root = await contained(selected.root, "");
      const limit = Math.max(1, Math.min(500, Number(input.limit) || 100));
      const maxFileSize = Math.max(
        1,
        Math.min(
          64 * 1024 * 1024,
          Number(input.maxFileSize) || 2 * 1024 * 1024,
        ),
      );
      const contextLines = Math.max(
        0,
        Math.min(10, Number(input.contextLines) || 0),
      );
      const timeoutMs = Math.max(
        1,
        Math.min(300_000, Number(input.timeoutMs) || 30_000),
      );
      const args = [
        "--json",
        "--line-number",
        "--no-messages",
        "--max-filesize",
        String(maxFileSize),
        "--glob",
        "!.git/**",
        "--glob",
        "!node_modules/**",
      ];
      for (const pattern of input.include || [])
        args.push("--glob", String(pattern));
      for (const pattern of input.exclude || [])
        args.push("--glob", `!${String(pattern).replace(/^!+/, "")}`);
      if (!input.regex) args.push("--fixed-strings");
      if (contextLines) args.push("--context", String(contextLines));
      args.push("--", String(input.query), ".");

      const matches = [];
      let stdout = "",
        stderr = "",
        timedOut = false,
        limited = false,
        settled = false,
        forceTimer,
        before = [],
        current = null;
      const child = spawn(rgPath, args, {
        cwd: root,
        env: childEnvironment(),
        stdio: ["ignore", "pipe", "pipe"],
        detached: true,
      });
      const stop = () => {
        if (!settled && !forceTimer) forceTimer = terminateProcessGroup(child);
      };
      const onAbort = () => stop();
      options.signal?.addEventListener("abort", onAbort, { once: true });
      if (options.signal?.aborted) onAbort();
      const timer = setTimeout(() => {
        timedOut = true;
        stop();
      }, timeoutMs);
      child.stdout.on("data", (chunk) => {
        stdout += chunk.toString("utf8");
        let newline;
        while ((newline = stdout.indexOf("\n")) >= 0) {
          const line = stdout.slice(0, newline);
          stdout = stdout.slice(newline + 1);
          try {
            const event = JSON.parse(line);
            if (event.type === "begin" || event.type === "end") {
              before = [];
              current = null;
              continue;
            }
            if (
              event.type === "context" &&
              event.data?.lines?.text !== undefined
            ) {
              const context = {
                line: event.data.line_number,
                text: String(event.data.lines.text)
                  .replace(/[\r\n]+$/, "")
                  .slice(0, 500),
              };
              if (current) current.contextAfter.push(context);
              else before = [...before.slice(-(contextLines - 1)), context];
              continue;
            }
            if (event.type !== "match" || event.data?.lines?.text === undefined)
              continue;
            const relative = String(event.data.path?.text || "").replace(
              /^\.\//,
              "",
            );
            if (
              !relative ||
              path.isAbsolute(relative) ||
              relative.startsWith("../")
            )
              continue;
            current = {
              path: relative,
              line: event.data.line_number,
              text: String(event.data.lines.text)
                .replace(/[\r\n]+$/, "")
                .slice(0, 500),
              contextBefore: before,
              contextAfter: [],
            };
            before = [];
            matches.push(current);
            if (matches.length > limit) {
              limited = true;
              stop();
              break;
            }
          } catch {}
        }
      });
      child.stderr.on("data", (chunk) => {
        if (stderr.length < 16_384) stderr += chunk.toString("utf8");
      });
      const result = await new Promise((resolve, reject) => {
        child.on("error", reject);
        child.on("close", (exitCode, signal) => {
          settled = true;
          resolve({ exitCode, signal });
        });
      }).finally(() => {
        clearTimeout(timer);
        options.signal?.removeEventListener("abort", onAbort);
      });
      if (options.signal?.aborted)
        throw error("SearchCancelled", "Project content search was cancelled");
      if (timedOut)
        throw error(
          "SearchTimeout",
          `Project content search exceeded ${timeoutMs}ms`,
        );
      if (!limited && result.exitCode !== 0 && result.exitCode !== 1)
        throw error(
          "SearchFailed",
          stderr.trim() || "ripgrep content search failed",
        );
      return { matches: matches.slice(0, limit), truncated: limited };
    },
    async exec(input, options = {}) {
      const selected = project(input.project);
      const cwd = await contained(selected.root, input.cwd || "");
      const before = await gitStatus(selected.root).catch(() => "");
      const result = await runRaw(
        "/bin/bash",
        ["-lc", String(input.command)],
        cwd,
        input.timeoutMs,
        input.env || {},
        options,
      );
      const outputId = rememberOutput(result.stdout, result.stderr);
      const changedPaths = await changes(selected.root, before);
      await audit("exec", input, result.exitCode);
      return {
        ...result,
        stdout: undefined,
        stderr: undefined,
        ...pageOutput(
          outputId,
          result.stdout,
          result.stderr,
          0,
          0,
          input.maxOutputBytes,
        ),
        cwd: path.relative(selected.root, cwd) || ".",
        changedPaths,
      };
    },
    async readOutput(input) {
      const saved = outputs.get(input.outputId);
      if (!saved)
        throw error("OutputExpired", "Output is unavailable or expired");
      return pageOutput(
        input.outputId,
        saved.stdout,
        saved.stderr,
        input.stdoutCursor,
        input.stderrCursor,
        input.maxOutputBytes,
      );
    },
    async startProcess(input) {
      const selected = project(input.project);
      const cwd = await contained(selected.root, input.cwd || "");
      const processId = id();
      const startedAt = processTimestamp().iso;
      pruneProcesses();
      while (processes.size >= maxProcessRecords)
        if (!removeOldestCompletedProcess())
          throw error("ProcessLimit", "Managed process record limit reached");
      const child = spawn("/bin/bash", ["-lc", String(input.command)], {
        cwd,
        env: childEnvironment(input.env || {}),
        stdio: ["pipe", "pipe", "pipe"],
      });
      const record = {
        id: processId,
        project: input.project,
        command: input.command,
        cwd: path.relative(selected.root, cwd) || ".",
        pid: child.pid,
        startedAt,
        endedAt: null,
        endedAtMs: 0,
        exitCode: null,
        signal: null,
        status: "running",
        stdout: Buffer.alloc(0),
        stderr: Buffer.alloc(0),
        stdoutBase: 0,
        stderrBase: 0,
        child,
      };
      const append = (stream, base, data) => {
        const combined = Buffer.concat([record[stream], Buffer.from(data)]);
        const dropped = Math.max(0, combined.length - MAX_CAPTURE);
        record[stream] = combined.subarray(dropped);
        record[base] += dropped;
      };
      child.stdout.on("data", (d) => append("stdout", "stdoutBase", d));
      child.stderr.on("data", (d) => append("stderr", "stderrBase", d));
      child.on("error", () => {
        const ended = processTimestamp();
        Object.assign(record, {
          status: "failed",
          endedAt: ended.iso,
          endedAtMs: ended.milliseconds,
        });
      });
      child.on("close", (code, signal) => {
        const ended = processTimestamp();
        Object.assign(record, {
          status: signal ? "killed" : code === 0 ? "exited" : "failed",
          exitCode: code,
          signal,
          endedAt: ended.iso,
          endedAtMs: ended.milliseconds,
        });
      });
      processes.set(processId, record);
      await audit("start_process", input, processId);
      return publicProcess(record);
    },
    async readProcess(input) {
      const record = processes.get(input.id);
      if (!record)
        throw error("UnknownProcess", `Unknown process: ${input.id}`);
      const stdoutFrom = Math.max(
        record.stdoutBase,
        Number(input.stdoutCursor) || 0,
      );
      const stderrFrom = Math.max(
        record.stderrBase,
        Number(input.stderrCursor) || 0,
      );
      const max = Math.max(
        1024,
        Math.min(512 * 1024, Number(input.maxOutputBytes) || DEFAULT_CHUNK),
      );
      const stdoutBuffer = record.stdout.subarray(
        stdoutFrom - record.stdoutBase,
        stdoutFrom - record.stdoutBase + max,
      );
      const stderrBuffer = record.stderr.subarray(
        stderrFrom - record.stderrBase,
        stderrFrom - record.stderrBase + Math.max(0, max - stdoutBuffer.length),
      );
      return {
        ...publicProcess(record),
        stdout: stdoutBuffer.toString("utf8"),
        stderr: stderrBuffer.toString("utf8"),
        stdoutCursor: stdoutFrom + stdoutBuffer.length,
        stderrCursor: stderrFrom + stderrBuffer.length,
        outputReset:
          Number(input.stdoutCursor || 0) < record.stdoutBase ||
          Number(input.stderrCursor || 0) < record.stderrBase,
      };
    },
    async writeProcess(input) {
      const record = processes.get(input.id);
      if (!record || record.status !== "running")
        throw error("ProcessNotRunning", `Process is not running: ${input.id}`);
      record.child.stdin.write(String(input.text));
      await audit("write_process", {
        ...input,
        text: `<${String(input.text).length} bytes>`,
      });
      return publicProcess(record);
    },
    async stopProcess(input) {
      const record = processes.get(input.id);
      if (!record)
        throw error("UnknownProcess", `Unknown process: ${input.id}`);
      if (record.status === "running")
        record.child.kill(input.force ? "SIGKILL" : "SIGINT");
      await audit("stop_process", input);
      return publicProcess(record);
    },
    listProcesses(input = {}) {
      pruneProcesses();
      return [...processes.values()]
        .filter((p) => !input.project || p.project === input.project)
        .map(publicProcess);
    },
    async applyPatch(input) {
      const selected = project(input.project);
      const args = [
        "apply",
        "--whitespace=nowarn",
        ...(input.dryRun ? ["--check"] : []),
      ];
      const child = spawn("git", args, {
        cwd: selected.root,
        stdio: ["pipe", "pipe", "pipe"],
      });
      let stdout = "",
        stderr = "";
      child.stdout.on("data", (d) => (stdout += d));
      child.stderr.on("data", (d) => (stderr += d));
      child.stdin.end(String(input.patch));
      const exitCode = await new Promise((resolve, reject) => {
        child.on("error", reject);
        child.on("close", resolve);
      });
      if (exitCode !== 0)
        throw error("PatchRejected", stderr || "Patch could not be applied", {
          exitCode,
        });
      await audit("apply_patch", {
        ...input,
        patch: `<${String(input.patch).length} bytes>`,
      });
      return {
        ok: true,
        dryRun: !!input.dryRun,
        stdout,
        stderr,
        changedPaths: input.dryRun ? [] : await changes(selected.root, ""),
      };
    },
    async fsMutate(input) {
      const selected = project(input.project);
      const from = await contained(selected.root, input.path);
      const to =
        input.destination === undefined
          ? null
          : await contained(selected.root, input.destination);
      switch (input.operation) {
        case "mkdir":
          await fsp.mkdir(from, { recursive: input.recursive !== false });
          break;
        case "copy":
          if (!to) throw error("InvalidInput", "destination is required");
          await fsp.cp(from, to, {
            recursive: !!input.recursive,
            force: false,
          });
          break;
        case "move":
        case "rename":
          if (!to) throw error("InvalidInput", "destination is required");
          await fsp.rename(from, to);
          break;
        case "delete":
          if (!input.confirm)
            throw error(
              "ConfirmationRequired",
              "delete requires confirm: true",
            );
          await fsp.rm(from, { recursive: !!input.recursive, force: false });
          break;
        case "chmod":
          if (!input.confirm)
            throw error("ConfirmationRequired", "chmod requires confirm: true");
          await fsp.chmod(from, Number.parseInt(String(input.mode), 8));
          break;
        case "symlink":
          if (!to) throw error("InvalidInput", "destination is required");
          await fsp.symlink(input.path, to);
          break;
        default:
          throw error(
            "InvalidInput",
            `Unknown filesystem operation: ${input.operation}`,
          );
      }
      await audit("fs_mutate", input);
      return {
        ok: true,
        operation: input.operation,
        path: input.path,
        destination: input.destination || null,
      };
    },
    async exportProject(input) {
      await init;
      const selected = project(input.project);
      const format = input.format === "tar.gz" ? "tar.gz" : "zip";
      const artifactId = id();
      const fileName = `${safeName(input.name || selected.id)}.${format}`;
      const target = path.join(artifactRoot, `${artifactId}-${fileName}`);
      const excludes = [
        ...AUTO_EXCLUDES,
        ...(!input.includeGit ? [".git"] : []),
        ...(input.exclude || []),
      ];
      const included =
        Array.isArray(input.include) && input.include.length
          ? input.include.map(String)
          : [""];
      const files = await archiveFiles(
        selected.root,
        included,
        excludes,
        !!input.includeIgnored,
      );
      if (!files.length)
        throw error(
          "ExportFailed",
          "No exportable files matched the requested paths",
        );
      const zipScript =
        "import sys,zipfile,os; target=sys.argv[1]; files=sys.stdin.buffer.read().decode().split('\\0'); z=zipfile.ZipFile(target,'w',zipfile.ZIP_DEFLATED); [(z.write(f,f) if os.path.isfile(f) else None) for f in files if f]; z.close()";
      const result = await runRawInput(
        format === "zip" ? "python3" : "tar",
        format === "zip"
          ? ["-c", zipScript, target]
          : ["-czf", target, "--null", "-T", "-"],
        selected.root,
        files.join("\0") + "\0",
        300_000,
      );
      if (result.exitCode !== 0)
        throw error("ExportFailed", result.stderr || "Archive creation failed");
      const stat = await fsp.stat(target);
      if (stat.size > MAX_ARTIFACT_SIZE) {
        await fsp.rm(target, { force: true });
        throw error(
          "ArtifactTooLarge",
          "Artifact exceeds the configured size limit",
        );
      }
      const existing = await api.listArtifacts();
      if (
        existing.reduce((total, item) => total + item.size, 0) + stat.size >
        MAX_ARTIFACT_STORAGE
      ) {
        await fsp.rm(target, { force: true });
        throw error(
          "ArtifactStorageLimit",
          "Workspace artifact storage limit reached",
        );
      }
      const sha256 = await hashFile(target),
        expiresAt = new Date(Date.now() + 60 * 60_000).toISOString();
      const metadata = {
        id: artifactId,
        project: selected.id,
        fileName,
        path: target,
        format,
        contentType: format === "zip" ? "application/zip" : "application/gzip",
        size: stat.size,
        sha256,
        createdAt: now(),
        expiresAt,
        automaticExclusions: excludes,
      };
      await fsp.writeFile(`${target}.json`, JSON.stringify(metadata));
      await audit("export_project", input, artifactId);
      return artifactPublic(metadata);
    },
    async listArtifacts(input = {}) {
      await init;
      const names = await fsp.readdir(artifactRoot);
      const result = [];
      for (const name of names.filter((x) => x.endsWith(".json")))
        try {
          const metadataPath = path.join(artifactRoot, name);
          const item = JSON.parse(await fsp.readFile(metadataPath, "utf8"));
          if (Date.parse(item.expiresAt) <= Date.now()) {
            await Promise.all([
              fsp.rm(item.path, { force: true }),
              fsp.rm(metadataPath, { force: true }),
            ]);
            continue;
          }
          if (!input.project || item.project === input.project)
            result.push(artifactPublic(item));
        } catch {}
      return result.sort((a, b) => b.createdAt.localeCompare(a.createdAt));
    },
    async deleteArtifact(input) {
      const artifact = await findArtifact(input.id);
      if (!input.confirm)
        throw error(
          "ConfirmationRequired",
          "artifact deletion requires confirm: true",
        );
      await Promise.all([
        fsp.rm(artifact.path),
        fsp.rm(`${artifact.path}.json`),
      ]);
      await audit("delete_artifact", input);
      return { ok: true, id: input.id };
    },
    async createSnapshot(input) {
      await init;
      const selected = project(input.project);
      const projectRoot = await fsp.realpath(selected.root);
      const artifactId = id();
      const fileName = `${safeName(`snapshot-${input.name || selected.id}`)}.tar.gz`;
      const target = path.join(artifactRoot, `${artifactId}-${fileName}`);
      const temporaryRoot = await fsp.mkdtemp(
        path.join(os.tmpdir(), "workbench-snapshot-"),
      );
      try {
        const worktreePath = path.join(temporaryRoot, "worktree.tar.gz");
        const files = await archiveFiles(
          projectRoot,
          [""],
          [".git", ...AUTO_EXCLUDES],
          false,
        );
        const worktree = await runRawInput(
          "tar",
          ["-czf", worktreePath, "--null", "-T", "-"],
          projectRoot,
          files.length ? `${files.join("\0")}\0` : "",
          300_000,
        );
        if (worktree.exitCode !== 0)
          throw error(
            "SnapshotFailed",
            worktree.stderr || "Worktree archive creation failed",
          );
        const head = await gitHeadMetadata(projectRoot, runRaw);
        const status = await gitSnapshotStatus(projectRoot, runRaw);
        const refs = await runRaw(
          "git",
          ["for-each-ref", "--format=%(refname)", "refs"],
          projectRoot,
          30_000,
        );
        if (refs.exitCode !== 0)
          throw error(
            "SnapshotFailed",
            refs.stderr || "Git refs could not be inspected",
          );
        const refNames = refs.stdout.split("\n").filter(Boolean);
        let bundleName = null;
        let bundleSha256 = null;
        if (refNames.length) {
          bundleName = "repository.bundle";
          const bundlePath = path.join(temporaryRoot, bundleName);
          const bundled = await runRaw(
            "git",
            [
              "bundle",
              "create",
              bundlePath,
              "--all",
              ...(head.commit ? ["HEAD"] : []),
            ],
            projectRoot,
            300_000,
          );
          if (bundled.exitCode !== 0)
            throw error(
              "SnapshotFailed",
              bundled.stderr || "Git bundle creation failed",
            );
          bundleSha256 = await hashFile(bundlePath);
        }
        const createdAt = now();
        const snapshot = {
          formatVersion: 1,
          createdAt,
          commit: head.commit,
          branch: head.branch,
          dirty: status,
          untrackedPolicy:
            "included except ignored, secret-like, and automatic exclusions",
          ignoredPolicy: "excluded",
          automaticExclusions: [...AUTO_EXCLUDES],
          secretLikeFiles: "excluded",
          worktree: {
            path: "worktree.tar.gz",
            sha256: await hashFile(worktreePath),
            fileCount: files.length,
          },
          gitBundle: bundleName
            ? { path: bundleName, sha256: bundleSha256, refs: refNames }
            : null,
        };
        await fsp.writeFile(
          path.join(temporaryRoot, "metadata.json"),
          JSON.stringify(snapshot, null, 2),
          { mode: 0o600 },
        );
        const members = [
          "metadata.json",
          "worktree.tar.gz",
          ...(bundleName ? [bundleName] : []),
        ];
        const packed = await runRaw(
          "tar",
          ["-czf", target, "-C", temporaryRoot, ...members],
          projectRoot,
          300_000,
        );
        if (packed.exitCode !== 0)
          throw error(
            "SnapshotFailed",
            packed.stderr || "Snapshot container creation failed",
          );
        const stat = await fsp.stat(target);
        if (stat.size > MAX_ARTIFACT_SIZE)
          throw error(
            "ArtifactTooLarge",
            "Snapshot exceeds the configured size limit",
          );
        const existing = await api.listArtifacts();
        if (
          existing.reduce((total, item) => total + item.size, 0) + stat.size >
          MAX_ARTIFACT_STORAGE
        )
          throw error(
            "ArtifactStorageLimit",
            "Workspace artifact storage limit reached",
          );
        const metadata = {
          id: artifactId,
          project: selected.id,
          fileName,
          path: target,
          format: "snapshot-v1",
          contentType: "application/gzip",
          size: stat.size,
          sha256: await hashFile(target),
          createdAt,
          expiresAt: new Date(Date.now() + 60 * 60_000).toISOString(),
          snapshot,
        };
        await fsp.writeFile(`${target}.json`, JSON.stringify(metadata), {
          mode: 0o600,
        });
        await audit("create_snapshot", input, artifactId);
        return artifactPublic(metadata);
      } catch (cause) {
        await fsp.rm(target, { force: true });
        throw cause;
      } finally {
        await fsp.rm(temporaryRoot, { recursive: true, force: true });
      }
    },
    async listSnapshots(input = {}) {
      return (await api.listArtifacts(input)).filter(
        (item) => item.format === "snapshot-v1",
      );
    },
    async restoreSnapshot(input) {
      if (!input.confirm)
        throw error(
          "ConfirmationRequired",
          "snapshot restore requires confirm: true",
        );
      const selected = project(input.project);
      const projectRoot = await fsp.realpath(selected.root);
      const artifact = await findArtifact(input.id);
      if (artifact.format !== "snapshot-v1")
        throw error(
          "SnapshotInvalid",
          "Artifact is not a supported project snapshot",
        );
      if ((await hashFile(artifact.path)) !== artifact.sha256)
        throw error(
          "ArtifactChecksumMismatch",
          "Snapshot container checksum verification failed",
        );
      const temporaryRoot = await fsp.mkdtemp(
        path.join(os.tmpdir(), "workbench-restore-"),
      );
      try {
        const container = path.join(temporaryRoot, "container"),
          containerManifest = path.join(
            temporaryRoot,
            "container-manifest.json",
          );
        await fsp.mkdir(container);
        await extractValidatedArchive(
          artifact.path,
          "tar.gz",
          container,
          containerManifest,
          projectRoot,
          runRaw,
        );
        const members = JSON.parse(
          await fsp.readFile(containerManifest, "utf8"),
        ).sort();
        const metadata = JSON.parse(
          await fsp.readFile(path.join(container, "metadata.json"), "utf8"),
        );
        validateSnapshotMetadata(metadata, members);
        const worktreeArchive = path.join(container, metadata.worktree.path);
        if ((await hashFile(worktreeArchive)) !== metadata.worktree.sha256)
          throw error(
            "SnapshotInvalid",
            "Worktree archive checksum verification failed",
          );
        const staging = path.join(temporaryRoot, "worktree"),
          worktreeManifest = path.join(temporaryRoot, "worktree-manifest.json");
        await fsp.mkdir(staging);
        await extractValidatedArchive(
          worktreeArchive,
          "tar.gz",
          staging,
          worktreeManifest,
          projectRoot,
          runRaw,
        );
        if (metadata.gitBundle) {
          const bundle = path.join(container, metadata.gitBundle.path);
          if ((await hashFile(bundle)) !== metadata.gitBundle.sha256)
            throw error(
              "SnapshotInvalid",
              "Git bundle checksum verification failed",
            );
          const verifier = path.join(temporaryRoot, "bundle-verifier.git");
          const initialized = await runRaw(
            "git",
            ["init", "--bare", verifier],
            projectRoot,
            30_000,
          );
          if (initialized.exitCode !== 0)
            throw error(
              "SnapshotInvalid",
              initialized.stderr ||
                "Git bundle verifier could not be initialized",
            );
          const verified = await runRaw(
            "git",
            ["-C", verifier, "bundle", "verify", bundle],
            projectRoot,
            60_000,
          );
          if (verified.exitCode !== 0)
            throw error(
              "SnapshotInvalid",
              verified.stderr || "Git bundle verification failed",
            );
        }
        await restoreGitSnapshot(projectRoot, metadata, container, runRaw);
        for (const name of await fsp.readdir(projectRoot))
          if (name !== ".git")
            await fsp.rm(path.join(projectRoot, name), {
              recursive: true,
              force: true,
            });
        await mergeImportedTree(staging, projectRoot, contained, true);
        await audit("restore_snapshot", input);
        return {
          restored: true,
          formatVersion: metadata.formatVersion,
          commit: metadata.commit,
          branch: metadata.branch,
          entries: JSON.parse(await fsp.readFile(worktreeManifest, "utf8"))
            .length,
        };
      } finally {
        await fsp.rm(temporaryRoot, { recursive: true, force: true });
      }
    },
    async importArchive(input) {
      const selected = project(input.project);
      const projectRoot = await fsp.realpath(selected.root);
      const artifact = await findArtifact(input.artifactId);
      if (!["zip", "tar.gz"].includes(artifact.format))
        throw error("ImportFailed", "Unsupported archive format");
      const temporaryRoot = await fsp.mkdtemp(
        path.join(os.tmpdir(), "workbench-import-"),
      );
      try {
        const staging = path.join(temporaryRoot, "contents");
        const manifestPath = path.join(temporaryRoot, "manifest.json");
        await fsp.mkdir(staging);
        await extractValidatedArchive(
          artifact.path,
          artifact.format,
          staging,
          manifestPath,
          projectRoot,
          runRaw,
        );
        const entries = JSON.parse(await fsp.readFile(manifestPath, "utf8"));
        const conflicts = [];
        for (const entry of entries) {
          const destination = await contained(projectRoot, entry);
          try {
            await fsp.lstat(destination);
            conflicts.push(entry);
          } catch (cause) {
            if (cause?.code !== "ENOENT") throw cause;
          }
        }
        if (input.dryRun !== false)
          return { dryRun: true, entries, conflicts, truncated: false };
        if (conflicts.length && !input.overwrite)
          throw error("ImportConflict", "Archive has path conflicts", {
            conflicts,
          });
        if (!input.confirm)
          throw error(
            "ConfirmationRequired",
            "archive extraction requires confirm: true",
          );
        await mergeImportedTree(
          staging,
          projectRoot,
          contained,
          !!input.overwrite,
        );
        await audit("import_archive", input);
        return { dryRun: false, entries: entries.length, conflicts };
      } finally {
        await fsp.rm(temporaryRoot, { recursive: true, force: true });
      }
    },
    async git(input) {
      const selected = project(input.project);
      const commands = {
        diff: [
          "diff",
          ...(input.cached ? ["--cached"] : []),
          ...(input.ref ? [input.ref] : []),
        ],
        stage: ["add", "--", ...(input.paths || [])],
        commit: ["commit", "-m", input.message || "Workbench changes"],
        branch: input.create
          ? ["switch", "-c", input.name]
          : ["switch", input.name],
        sync: [
          input.action || "fetch",
          ...(input.remote ? [input.remote] : []),
        ],
      };
      if (
        input.operation === "sync" &&
        ["push", "pull"].includes(input.action) &&
        !input.confirm
      )
        throw error(
          "ConfirmationRequired",
          `${input.action} requires confirm: true`,
        );
      const args = commands[input.operation];
      if (!args)
        throw error(
          "InvalidInput",
          `Unknown Git operation: ${input.operation}`,
        );
      const result = await runRaw(
        "git",
        args,
        selected.root,
        input.timeoutMs || 120_000,
      );
      await audit(`git_${input.operation}`, input, result.exitCode);
      return { ...result, changedPaths: await changes(selected.root, "") };
    },
    async vmInfo() {
      const disks = await runRaw("df", ["-Pk", "/"], "/");
      return {
        hostname: os.hostname(),
        platform: os.platform(),
        release: os.release(),
        arch: os.arch(),
        cpus: os.cpus().length,
        loadAverage: os.loadavg(),
        totalMemory: os.totalmem(),
        freeMemory: os.freemem(),
        uptimeSeconds: os.uptime(),
        disk: disks.stdout,
      };
    },
    async listPorts() {
      const result = await runRaw("ss", ["-ltnp"], "/");
      return { output: result.stdout, exitCode: result.exitCode };
    },
    async systemProcesses(input = {}) {
      const result = await runRaw(
        "ps",
        ["-eo", "pid,ppid,user,stat,etime,%cpu,%mem,command", "--sort=-%cpu"],
        "/",
      );
      return {
        output: result.stdout
          .split("\n")
          .slice(0, Math.min(501, Number(input.limit) + 1 || 101))
          .join("\n"),
      };
    },
    permission(input) {
      throw error(
        "AuthorizationRequired",
        `${input.capability || "This capability"} requires a trusted owner grant that is not configured`,
      );
    },
  };
  const findArtifact = async (artifactId) => {
    const all = await api.listArtifacts();
    const publicItem = all.find((x) => x.id === artifactId);
    if (!publicItem)
      throw error("UnknownArtifact", `Unknown artifact: ${artifactId}`);
    const names = await fsp.readdir(artifactRoot);
    const metaName = names.find(
      (x) => x.startsWith(`${artifactId}-`) && x.endsWith(".json"),
    );
    return JSON.parse(
      await fsp.readFile(path.join(artifactRoot, metaName), "utf8"),
    );
  };
  api.artifactPath = async (artifactId) => {
    const artifact = await findArtifact(artifactId);
    if ((await hashFile(artifact.path)) !== artifact.sha256)
      throw error(
        "ArtifactChecksumMismatch",
        "Artifact checksum verification failed",
      );
    return artifact.path;
  };
  api.shutdown = async () => {
    for (const record of processes.values())
      if (record.status === "running") record.child.kill("SIGTERM");
  };
  return api;
}

const SAFE_ARCHIVE_EXTRACTOR = String.raw`
import json, os, re, shutil, stat, sys, tarfile, zipfile
archive, kind, root, manifest_path = sys.argv[1:5]
max_entries, max_file, max_total, max_ratio = map(int, sys.argv[5:9])
seen, entries, total = set(), [], 0

def normalize(name):
    if not name or '\\x00' in name or '\\\\' in name or name.startswith('/') or re.match(r'^[A-Za-z]:', name):
        raise ValueError('unsafe absolute or ambiguous archive path')
    parts = name.rstrip('/').split('/')
    if not parts or any(part in ('', '.', '..') for part in parts):
        raise ValueError('unsafe archive path traversal')
    return '/'.join(parts)

def clean(name):
    value = normalize(name)
    if value in seen: raise ValueError('duplicate archive path')
    seen.add(value); entries.append(value)
    if len(entries) > max_entries: raise ValueError('archive has excessive file count')
    return value

def account(size, compressed=None):
    global total
    if size < 0 or size > max_file: raise ValueError('archive entry exceeds per-file expanded size limit')
    total += size
    if total > max_total: raise ValueError('archive exceeds total expanded size limit')
    if compressed is not None and size > 1024 * 1024 and size / max(1, compressed) > max_ratio:
        raise ValueError('suspicious archive compression ratio')

def target(name):
    value = os.path.realpath(os.path.join(root, name))
    if os.path.commonpath((root, value)) != root: raise ValueError('archive link escapes extraction root')
    return value

def link_target(name, link):
    if not link or os.path.isabs(link) or re.match(r'^[A-Za-z]:', link): raise ValueError('archive link has unsafe target')
    value = os.path.realpath(os.path.join(root, os.path.dirname(name), link))
    if os.path.commonpath((root, value)) != root: raise ValueError('archive link escapes extraction root')
    return value

root = os.path.realpath(root)
if kind == 'zip':
    with zipfile.ZipFile(archive) as z:
        records = []
        for item in z.infolist():
            name = clean(item.filename)
            mode = (item.external_attr >> 16) & 0xffff
            is_link = stat.S_ISLNK(mode)
            if stat.S_IFMT(mode) and not (stat.S_ISREG(mode) or stat.S_ISDIR(mode) or is_link): raise ValueError('unsupported special archive entry')
            account(0 if item.is_dir() or is_link else item.file_size, item.compress_size)
            records.append((item, name, is_link))
        for item, name, is_link in records:
            destination = target(name)
            if item.is_dir(): os.makedirs(destination, exist_ok=True); continue
            os.makedirs(os.path.dirname(destination), exist_ok=True)
            if is_link:
                link = z.read(item).decode('utf-8')
                link_target(name, link); os.symlink(link, destination)
            else:
                with z.open(item) as source, open(destination, 'xb') as output: shutil.copyfileobj(source, output, 1024 * 1024)
else:
    compressed_size = os.path.getsize(archive)
    with tarfile.open(archive, 'r:gz') as tar:
        records = []
        for item in tar:
            name = clean(item.name)
            if not (item.isfile() or item.isdir() or item.issym() or item.islnk()): raise ValueError('unsupported special archive entry')
            account(item.size if item.isfile() else 0)
            records.append((item, name))
        if total > 1024 * 1024 and total / max(1, compressed_size) > max_ratio: raise ValueError('suspicious archive compression ratio')
        names = {name for _, name in records}
        for item, name in records:
            destination = target(name)
            if item.isdir(): os.makedirs(destination, exist_ok=True); continue
            os.makedirs(os.path.dirname(destination), exist_ok=True)
            if item.issym():
                link_target(name, item.linkname); os.symlink(item.linkname, destination)
            elif item.islnk():
                linked = normalize(item.linkname)
                if linked not in names: raise ValueError('hardlink target is not an archive entry')
                source = target(linked)
                if not os.path.isfile(source): raise ValueError('hardlink target is unavailable')
                os.link(source, destination)
            else:
                source = tar.extractfile(item)
                if source is None: raise ValueError('archive file cannot be read')
                with source, open(destination, 'xb') as output: shutil.copyfileobj(source, output, 1024 * 1024)
with open(manifest_path, 'w', encoding='utf-8') as output: json.dump(entries, output)
`;

async function mergeImportedTree(
  sourceRoot,
  destinationRoot,
  contained,
  overwrite,
) {
  for (const name of await fsp.readdir(sourceRoot))
    await merge(path.join(sourceRoot, name), name);
  async function merge(source, relative) {
    const destination = await contained(destinationRoot, relative);
    const sourceStat = await fsp.lstat(source);
    let destinationStat = null;
    try {
      destinationStat = await fsp.lstat(destination);
    } catch (cause) {
      if (cause?.code !== "ENOENT") throw cause;
    }
    if (!destinationStat) {
      await fsp.rename(source, destination);
      return;
    }
    if (sourceStat.isDirectory() && destinationStat.isDirectory()) {
      for (const name of await fsp.readdir(source))
        await merge(path.join(source, name), path.join(relative, name));
      await fsp.rmdir(source);
      return;
    }
    if (!overwrite)
      throw error("ImportConflict", `Archive path already exists: ${relative}`);
    await fsp.rm(destination, { recursive: true, force: true });
    await fsp.rename(source, destination);
  }
}

async function archiveFiles(root, included, excludes, includeIgnored) {
  const result = await new Promise((resolve, reject) => {
    const args = [
      "ls-files",
      "-co",
      "-z",
      ...(includeIgnored ? [] : ["--exclude-standard"]),
      "--",
      ...included.map((prefix) => prefix || "."),
    ];
    const child = spawn("git", args, {
      cwd: root,
      stdio: ["ignore", "pipe", "pipe"],
    });
    let stdout = Buffer.alloc(0),
      stderr = "";
    child.stdout.on("data", (d) => (stdout = Buffer.concat([stdout, d])));
    child.stderr.on("data", (d) => (stderr += d));
    child.on("error", reject);
    child.on("close", (code) =>
      code === 0 ? resolve(stdout) : reject(error("ExportFailed", stderr)),
    );
  });
  return result
    .toString("utf8")
    .split("\0")
    .filter(Boolean)
    .filter(
      (file) =>
        !SECRET_PATTERN.test(file) &&
        !excludes.some(
          (excluded) =>
            file === excluded ||
            file.startsWith(`${excluded}/`) ||
            file.includes(`/${excluded}/`),
        ),
    );
}
function runRawInput(command, args, cwd, input, timeoutMs) {
  return new Promise((resolve, reject) => {
    const started = Date.now();
    const child = spawn(command, args, {
      cwd,
      stdio: ["pipe", "pipe", "pipe"],
    });
    let stdout = "",
      stderr = "";
    const timer = setTimeout(() => child.kill("SIGKILL"), timeoutMs);
    child.stdout.on("data", (d) => (stdout += d));
    child.stderr.on("data", (d) => (stderr += d));
    child.on("error", reject);
    child.on("close", (exitCode, signal) => {
      clearTimeout(timer);
      resolve({
        stdout,
        stderr,
        exitCode,
        signal,
        durationMs: Date.now() - started,
      });
    });
    child.stdin.end(input);
  });
}
function publicProcess(record) {
  return {
    id: record.id,
    project: record.project,
    command: redactText(record.command),
    cwd: record.cwd,
    pid: record.pid,
    startedAt: record.startedAt,
    endedAt: record.endedAt,
    exitCode: record.exitCode,
    signal: record.signal,
    status: record.status,
  };
}
function artifactPublic(item) {
  return {
    id: item.id,
    project: item.project,
    fileName: item.fileName,
    format: item.format,
    contentType: item.contentType || "application/octet-stream",
    size: item.size,
    sha256: item.sha256,
    createdAt: item.createdAt,
    expiresAt: item.expiresAt,
    automaticExclusions: item.automaticExclusions,
    snapshot: item.snapshot,
    downloadUrl: `/api/artifacts/${encodeURIComponent(item.id)}/download`,
  };
}
async function extractValidatedArchive(
  archive,
  format,
  staging,
  manifest,
  cwd,
  runRaw,
) {
  const result = await runRaw(
    "python3",
    [
      "-c",
      SAFE_ARCHIVE_EXTRACTOR,
      archive,
      format,
      staging,
      manifest,
      String(MAX_ARCHIVE_ENTRIES),
      String(MAX_ARCHIVE_FILE_SIZE),
      String(MAX_ARCHIVE_EXPANDED_SIZE),
      String(MAX_ARCHIVE_RATIO),
    ],
    cwd,
    300_000,
  );
  if (result.exitCode !== 0)
    throw error(
      "ImportFailed",
      result.stderr.trim() || "Archive validation or extraction failed",
    );
}
async function gitHeadMetadata(root, runRaw) {
  const branchResult = await runRaw(
    "git",
    ["symbolic-ref", "--quiet", "--short", "HEAD"],
    root,
    10_000,
  );
  const commitResult = await runRaw(
    "git",
    ["show", "-s", "--format=%H%x00%an%x00%ae%x00%aI%x00%s", "HEAD"],
    root,
    10_000,
  );
  const fields =
    commitResult.exitCode === 0
      ? commitResult.stdout.trimEnd().split("\0")
      : null;
  return {
    branch: branchResult.exitCode === 0 ? branchResult.stdout.trim() : null,
    commit: fields
      ? {
          oid: fields[0],
          authorName: fields[1],
          authorEmail: fields[2],
          authoredAt: fields[3],
          subject: fields[4],
        }
      : null,
  };
}
async function gitSnapshotStatus(root, runRaw) {
  const result = await runRaw(
    "git",
    ["status", "--porcelain=v1", "--untracked-files=all"],
    root,
    30_000,
  );
  if (result.exitCode !== 0)
    throw error(
      "SnapshotFailed",
      result.stderr || "Git status could not be read",
    );
  const entries = result.stdout.split("\n").filter(Boolean);
  return {
    isDirty: entries.length > 0,
    tracked: entries.filter((line) => !line.startsWith("?? ")),
    untracked: entries
      .filter((line) => line.startsWith("?? "))
      .map((line) => line.slice(3)),
  };
}
function validateSnapshotMetadata(metadata, members) {
  if (
    !metadata ||
    metadata.formatVersion !== 1 ||
    !metadata.createdAt ||
    !metadata.worktree ||
    metadata.worktree.path !== "worktree.tar.gz" ||
    !/^[a-f0-9]{64}$/.test(metadata.worktree.sha256)
  )
    throw error(
      "SnapshotInvalid",
      "Snapshot metadata is invalid or unsupported",
    );
  const expected = ["metadata.json", metadata.worktree.path];
  if (metadata.gitBundle) {
    if (
      metadata.gitBundle.path !== "repository.bundle" ||
      !/^[a-f0-9]{64}$/.test(metadata.gitBundle.sha256) ||
      !Array.isArray(metadata.gitBundle.refs) ||
      metadata.gitBundle.refs.some(
        (ref) => !/^refs\/[A-Za-z0-9._\/-]+$/.test(ref) || ref.includes(".."),
      )
    )
      throw error("SnapshotInvalid", "Git bundle metadata is invalid");
    expected.push(metadata.gitBundle.path);
  }
  if (
    members.length !== expected.length ||
    expected.some((name) => !members.includes(name))
  )
    throw error("SnapshotInvalid", "Snapshot container has unexpected members");
}
async function restoreGitSnapshot(root, metadata, container, runRaw) {
  const inside = await runRaw("git", ["rev-parse", "--git-dir"], root, 10_000);
  if (inside.exitCode !== 0) {
    const initialized = await runRaw("git", ["init"], root, 30_000);
    if (initialized.exitCode !== 0)
      throw error(
        "SnapshotRestoreFailed",
        initialized.stderr ||
          "Destination Git repository could not be initialized",
      );
  }
  if (metadata.gitBundle) {
    await runRaw(
      "git",
      ["symbolic-ref", "HEAD", "refs/heads/__workbench_restore_staging__"],
      root,
      10_000,
    );
    const refspecs = metadata.gitBundle.refs.map((ref) => `+${ref}:${ref}`);
    if (metadata.commit?.oid)
      refspecs.push("+HEAD:refs/workbench/snapshot-head");
    const fetched = await runRaw(
      "git",
      ["fetch", path.join(container, metadata.gitBundle.path), ...refspecs],
      root,
      300_000,
    );
    if (fetched.exitCode !== 0)
      throw error(
        "SnapshotRestoreFailed",
        fetched.stderr || "Snapshot Git refs could not be restored",
      );
  }
  if (metadata.branch) {
    if (
      !/^(?!-)(?!.*\.\.)(?!.*(?:^|\/)\.)(?!.*[~^:?*\\])[A-Za-z0-9._\/-]+$/.test(
        metadata.branch,
      )
    )
      throw error("SnapshotInvalid", "Snapshot branch is invalid");
    const linked = await runRaw(
      "git",
      ["symbolic-ref", "HEAD", `refs/heads/${metadata.branch}`],
      root,
      10_000,
    );
    if (linked.exitCode !== 0)
      throw error("SnapshotRestoreFailed", linked.stderr);
  } else if (metadata.commit?.oid) {
    const detached = await runRaw(
      "git",
      ["update-ref", "--no-deref", "HEAD", metadata.commit.oid],
      root,
      10_000,
    );
    if (detached.exitCode !== 0)
      throw error("SnapshotRestoreFailed", detached.stderr);
  }
  if (metadata.commit?.oid) {
    if (!/^[a-f0-9]{40,64}$/.test(metadata.commit.oid))
      throw error("SnapshotInvalid", "Snapshot commit identity is invalid");
    const indexed = await runRaw(
      "git",
      ["read-tree", metadata.commit.oid],
      root,
      30_000,
    );
    if (indexed.exitCode !== 0)
      throw error(
        "SnapshotRestoreFailed",
        indexed.stderr || "Snapshot index could not be restored",
      );
  } else await runRaw("git", ["read-tree", "--empty"], root, 10_000);
}
async function hashFile(file) {
  const hash = crypto.createHash("sha256");
  for await (const chunk of createReadStream(file)) hash.update(chunk);
  return hash.digest("hex");
}
