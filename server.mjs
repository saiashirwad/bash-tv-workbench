import http from "node:http";
import fs from "node:fs";
import fsp from "node:fs/promises";
import path from "node:path";
import os from "node:os";
import { spawn } from "node:child_process";
import { createReadStream } from "node:fs";
import { createGzip } from "node:zlib";
import { Readable } from "node:stream";
import crypto from "node:crypto";
import { loadProjects } from "./project-config.mjs";
import { makeWorkbenchPlatform } from "./workbench-platform.mjs";
import {
  collaboratorTokensFromEnvironment,
  makeWorkbenchAuthorization,
} from "./workbench-auth.mjs";
import { assertPlatformInput } from "./workbench-operation-catalog.mjs";
import {
  LiveSessionReader,
  liveCursor,
  paginateLiveMessages,
} from "./live-session-reader.mjs";
import { LiveTrajectoryIndex } from "./live-trajectory.mjs";
import {
  kyootBackend,
  makePiWorkflowEngine,
  makeRunEngine,
  makeTypedApi,
  piRunExecutor,
  runDirectory,
  workflowBackend,
  workflowDirectory,
} from "./typed-server.mjs";

const PORT = Number(process.env.PORT || 8011);
const HOST = process.env.HOST || "0.0.0.0";
const HOME = os.homedir();
const PROJECTS = new Map(loadProjects().map((entry) => [entry.id, entry]));
const SESSION_ROOT = path.join(HOME, ".pi/agent/sessions");
const UPLOADS_ROOT = path.join(HOME, "uploads");
const PUBLIC = path.join(
  path.dirname(new URL(import.meta.url).pathname),
  "public",
);
const TEXT_LIMIT = 2 * 1024 * 1024;
const ASSET_MANIFEST_FILE = path.join(PUBLIC, "asset-manifest.json");
let assetManifest;
try {
  assetManifest = JSON.parse(await fsp.readFile(ASSET_MANIFEST_FILE, "utf8"));
  if (
    assetManifest?.version !== 1 ||
    !assetManifest.assets ||
    typeof assetManifest.assets !== "object"
  )
    throw new Error("unsupported format");
} catch (error) {
  throw new Error(
    `Generated asset manifest is missing or invalid: ${error.message}`,
  );
}
const hashedAssets = new Set(Object.values(assetManifest.assets));
const WORKFLOW_CONTROL_FILE = path.join(
  path.dirname(new URL(import.meta.url).pathname),
  ".state/workflows-v1/control.token",
);
await fsp.mkdir(path.dirname(WORKFLOW_CONTROL_FILE), {
  recursive: true,
  mode: 0o700,
});
let WORKFLOW_CONTROL_TOKEN;
try {
  WORKFLOW_CONTROL_TOKEN = (
    await fsp.readFile(WORKFLOW_CONTROL_FILE, "utf8")
  ).trim();
} catch {
  WORKFLOW_CONTROL_TOKEN = crypto.randomBytes(32).toString("base64url");
  await fsp.writeFile(WORKFLOW_CONTROL_FILE, WORKFLOW_CONTROL_TOKEN, {
    mode: 0o600,
    flag: "wx",
  });
}
await fsp.chmod(WORKFLOW_CONTROL_FILE, 0o600);
const AUTHENTICATION_REQUIRED = /^(?:1|true|yes)$/i.test(
  String(process.env.BASH_WORKBENCH_AUTH_REQUIRED || ""),
);
const authorization = makeWorkbenchAuthorization({
  ownerToken: WORKFLOW_CONTROL_TOKEN,
  collaboratorTokens: collaboratorTokensFromEnvironment(),
  authenticationRequired: AUTHENTICATION_REQUIRED,
});
const TREE_LIMIT = 4000;
const EXCLUDED = new Set([
  "node_modules",
  ".pnpm-store",
  ".git",
  "dist",
  "build",
  ".next",
  ".cache",
  "coverage",
]);

function json(res, status, value) {
  const body = JSON.stringify(value);
  res.writeHead(status, {
    "content-type": "application/json; charset=utf-8",
    "content-length": Buffer.byteLength(body),
    "cache-control": "private, no-store",
    ...securityHeaders(),
  });
  res.end(body);
}
function securityHeaders() {
  return {
    "x-content-type-options": "nosniff",
    "x-frame-options": "SAMEORIGIN",
    "referrer-policy": "no-referrer",
    "content-security-policy":
      "default-src 'self'; script-src 'self'; style-src 'self' 'unsafe-inline'; img-src 'self' data: blob: https:; connect-src 'self'; object-src 'none'; base-uri 'none'; frame-ancestors 'self' https://bash.tv https://*.bash.tv",
  };
}
function fail(res, status, message) {
  json(res, status, { ok: false, error: message });
}
function project(id) {
  return PROJECTS.get(id) || null;
}
function safePath(root, relative = "") {
  if (relative.includes("\0")) throw new Error("Invalid path");
  const absolute = path.resolve(root, relative.replace(/^[/\\]+/, ""));
  const base = path.resolve(root);
  if (absolute !== base && !absolute.startsWith(base + path.sep))
    throw new Error("Path escapes project root");
  return absolute;
}
async function realContained(root, target) {
  const [rr, rt] = await Promise.all([
    fsp.realpath(root),
    fsp.realpath(target),
  ]);
  if (rt !== rr && !rt.startsWith(rr + path.sep))
    throw new Error("Symlink escapes project root");
  return rt;
}
function run(cmd, args, opts = {}) {
  return new Promise((resolve, reject) => {
    const p = spawn(cmd, args, { ...opts, stdio: ["ignore", "pipe", "pipe"] });
    const out = [],
      err = [];
    p.stdout.on("data", (d) => out.push(d));
    p.stderr.on("data", (d) => err.push(d));
    p.on("error", reject);
    p.on("close", (code) =>
      code === 0
        ? resolve(Buffer.concat(out))
        : reject(
            new Error(Buffer.concat(err).toString() || `${cmd} exited ${code}`),
          ),
    );
  });
}
async function requestBody(req, limit = 100000) {
  let raw = "";
  for await (const chunk of req) {
    raw += chunk;
    if (Buffer.byteLength(raw) > limit)
      throw Object.assign(new Error("Request too large"), { status: 413 });
  }
  return JSON.parse(raw || "{}");
}
function sensitivePath(relative) {
  return relative
    .split(/[\\/]/)
    .some((name) =>
      /^\.env($|\.)|\.pem$|\.key$|credentials|(^|\.)secret(s)?($|\.)/i.test(
        name,
      ),
    );
}
function fileVersion(buffer) {
  return crypto.createHash("sha256").update(buffer).digest("hex");
}
async function readProjectFile(root, relative) {
  const target = safePath(root, relative);
  const real = await realContained(root, target);
  const st = await fsp.stat(real);
  if (!st.isFile())
    throw Object.assign(new Error("Not a file"), { status: 400 });
  if (st.size > TEXT_LIMIT)
    throw Object.assign(new Error("File is too large for text preview"), {
      status: 413,
    });
  const buf = await fsp.readFile(real);
  if (buf.includes(0))
    return {
      path: relative,
      size: st.size,
      binary: true,
      mime: mime(real),
    };
  const version = fileVersion(buf);
  return {
    path: relative,
    size: st.size,
    binary: false,
    mime: mime(real),
    content: buf.toString("utf8"),
    version,
    revision: version,
    mtime: st.mtime.toISOString(),
    editable: !sensitivePath(relative),
  };
}
async function writeProjectFile(root, relative, body) {
  if (!relative || sensitivePath(relative))
    throw Object.assign(new Error("This path is not editable"), {
      status: 403,
    });
  const target = safePath(root, relative),
    real = await realContained(root, target),
    st = await fsp.stat(real);
  if (!st.isFile())
    throw Object.assign(new Error("Not a regular file"), { status: 400 });
  const before = await fsp.readFile(real);
  if (before.includes(0))
    throw Object.assign(new Error("Binary files are not editable"), {
      status: 400,
    });
  if (
    typeof body.content !== "string" ||
    Buffer.byteLength(body.content) > TEXT_LIMIT
  )
    throw Object.assign(new Error("Invalid or oversized content"), {
      status: 413,
    });
  if (body.version && body.version !== fileVersion(before))
    throw Object.assign(
      new Error("File changed on disk; reload before saving"),
      { status: 409 },
    );
  const temp = path.join(
    path.dirname(real),
    `.${path.basename(real)}.workbench-${crypto.randomUUID()}`,
  );
  await fsp.writeFile(temp, body.content, { mode: st.mode });
  await fsp.rename(temp, real);
  const saved = Buffer.from(body.content);
  return {
    ok: true,
    path: relative,
    size: saved.length,
    version: fileVersion(saved),
    mtime: new Date().toISOString(),
  };
}
const liveSessionReader = new LiveSessionReader(SESSION_ROOT);
const liveTrajectoryIndex = new LiveTrajectoryIndex();
function messageImages(text) {
  const images = [],
    seen = new Set(),
    pattern = /original:\s*~\/uploads\/([^;\]\n]+)/gi;
  for (const match of String(text || "").matchAll(pattern)) {
    const name = path.basename(match[1].trim());
    if (!seen.has(name) && /\.(?:png|jpe?g|gif|webp)$/i.test(name)) {
      seen.add(name);
      images.push(name);
    }
  }
  return images.slice(0, 12);
}
function textOf(content) {
  if (typeof content === "string") return content;
  if (!Array.isArray(content)) return "";
  return content
    .filter((x) => x && (x.type === "text" || typeof x.text === "string"))
    .map((x) => x.text || "")
    .join("\n");
}
function liveMessage(row, sequence) {
  const m = row.type === "message" ? row.message : null;
  if (!m || (m.role !== "user" && m.role !== "assistant")) return null;
  const text = textOf(m.content).trim();
  if (!text) return null;
  return {
    sequence,
    id: String(row.id || `message-${sequence}`),
    role: m.role,
    text: text.slice(0, 30000),
    images: messageImages(text),
    timestamp: row.timestamp,
    author:
      m.author && typeof m.author === "object"
        ? {
            id: String(m.author.id || "").slice(0, 200) || null,
            username: String(m.author.username || "").slice(0, 80) || null,
            pfp: /^https?:\/\//.test(String(m.author.pfp || ""))
              ? String(m.author.pfp).slice(0, 2000)
              : null,
          }
        : null,
  };
}
function sessionMessages(rows) {
  let sequence = 0;
  const messages = [];
  for (const row of rows) {
    const message = liveMessage(row, sequence + 1);
    if (message) {
      sequence++;
      messages.push(message);
    }
  }
  return messages;
}
async function sessionData(includeMessages = false, includeTrajectory = false) {
  const current = await liveSessionReader.refresh();
  if (!current.stat) return null;
  const rows = current.rows;
  liveTrajectoryIndex.update(current.identity, rows);
  const latest = { m: current.stat.mtimeMs, size: current.stat.size };
  const header = rows.find((x) => x.type === "session") || {};
  const modelChange =
    [...rows].reverse().find((x) => x.type === "model_change") || {};
  const thinking =
    [...rows].reverse().find((x) => x.type === "thinking_level_change") || {};
  const messages = includeMessages ? sessionMessages(rows) : [];
  const tools = {};
  let usage = null;
  for (const row of rows) {
    const m = row.type === "message" ? row.message : null;
    if (!m || typeof m !== "object") continue;
    if (m.usage) usage = m.usage;
    if (Array.isArray(m.content))
      for (const c of m.content) {
        const name = c?.name || c?.toolName;
        if (name && (c.type === "toolCall" || c.type === "tool_call"))
          tools[name] = (tools[name] || 0) + 1;
      }
  }
  let proc = null;
  try {
    const stat = (
      await run("ps", [
        "-p",
        "1158",
        "-o",
        "pid=,etime=,%cpu=,%mem=,rss=,stat=",
      ])
    )
      .toString()
      .trim()
      .split(/\s+/);
    if (stat.length >= 6)
      proc = {
        pid: +stat[0],
        elapsed: stat[1],
        cpu: +stat[2],
        memoryPercent: +stat[3],
        rssKiB: +stat[4],
        state: stat[5],
      };
  } catch {}
  const active = Boolean(proc) && Date.now() - latest.m < 10 * 60_000;
  return {
    id: header.id,
    cwd: header.cwd,
    model: `${modelChange.provider || "unknown"}/${modelChange.modelId || "unknown"}`,
    thinking: thinking.thinkingLevel || null,
    startedAt: header.timestamp,
    lastActivityAt: new Date(latest.m).toISOString(),
    bytes: latest.size,
    active,
    process: proc,
    usage,
    counts: {
      records: rows.length,
      messages: rows.filter((x) => x.type === "message").length,
      tools,
    },
    ...(includeMessages
      ? {
          messages: messages.slice(-250),
          cursor: liveCursor(current.identity, messages.length),
        }
      : {}),
    ...(includeTrajectory
      ? { trajectory: liveTrajectoryIndex.page({ limit: 100 }) }
      : {}),
  };
}
async function liveTrajectoryPage(input) {
  const current = await liveSessionReader.refresh();
  liveTrajectoryIndex.update(current.identity, current.rows);
  return liveTrajectoryIndex.page(input);
}
async function liveTrajectoryEvent(id) {
  const current = await liveSessionReader.refresh();
  liveTrajectoryIndex.update(current.identity, current.rows);
  return liveTrajectoryIndex.event(id);
}
async function liveSessionPage(cursor, limit) {
  const current = await liveSessionReader.refresh();
  if (!current.stat)
    return {
      messages: [],
      nextCursor: null,
      reset: cursor != null,
      more: false,
      completed: true,
    };
  const messages = sessionMessages(current.rows);
  return {
    ...paginateLiveMessages(current.identity, messages, cursor, limit),
    completed: Date.now() - current.stat.mtimeMs >= 10 * 60_000,
  };
}
async function tree(root, relative = "") {
  const start = safePath(root, relative);
  await realContained(root, start);
  const entries = [];
  let count = 0;
  async function walk(dir, rel, depth) {
    if (count >= TREE_LIMIT || depth > 8) return;
    const list = await fsp
      .readdir(dir, { withFileTypes: true })
      .catch(() => []);
    list.sort(
      (a, b) =>
        Number(b.isDirectory()) - Number(a.isDirectory()) ||
        a.name.localeCompare(b.name),
    );
    for (const e of list) {
      if (count++ >= TREE_LIMIT) break;
      if (EXCLUDED.has(e.name)) continue;
      const rp = path.posix.join(rel.replaceAll(path.sep, "/"), e.name);
      if (/^\.env($|\.)|\.pem$|\.key$|credentials/i.test(e.name)) continue;
      const item = {
        name: e.name,
        path: rp,
        type: e.isDirectory() ? "dir" : e.isSymbolicLink() ? "link" : "file",
      };
      if (e.isFile()) {
        try {
          const s = await fsp.stat(path.join(dir, e.name));
          item.size = s.size;
          item.mtime = s.mtime.toISOString();
        } catch {}
      }
      entries.push(item);
      if (e.isDirectory()) await walk(path.join(dir, e.name), rp, depth + 1);
    }
  }
  await walk(start, relative, 0);
  return { entries, truncated: count >= TREE_LIMIT };
}
function mime(p) {
  const ext = path.extname(p).toLowerCase();
  return (
    {
      ".png": "image/png",
      ".jpg": "image/jpeg",
      ".jpeg": "image/jpeg",
      ".gif": "image/gif",
      ".webp": "image/webp",
      ".svg": "image/svg+xml",
      ".pdf": "application/pdf",
      ".json": "application/json",
      ".md": "text/markdown",
      ".html": "text/html",
      ".css": "text/css",
      ".js": "text/javascript",
      ".mjs": "text/javascript",
      ".ts": "text/plain",
      ".tsx": "text/plain",
      ".py": "text/plain",
      ".sh": "text/plain",
    }[ext] || "application/octet-stream"
  );
}
const fileIndexCache = new Map();
async function fileIndex(root) {
  let stamp = 0;
  try {
    stamp = (await fsp.stat(path.join(root, ".git/index"))).mtimeMs;
  } catch {}
  const cached = fileIndexCache.get(root);
  if (cached && cached.stamp === stamp && Date.now() - cached.loadedAt < 30000)
    return cached.files;
  let files;
  try {
    const out = await run("git", [
      "-C",
      root,
      "ls-files",
      "-co",
      "--exclude-standard",
    ]);
    files = out
      .toString()
      .split("\n")
      .filter(Boolean)
      .filter(
        (p) => !p.split("/").some((n) => EXCLUDED.has(n) || sensitivePath(n)),
      )
      .slice(0, 30000);
  } catch {
    files = (await tree(root)).entries
      .filter((x) => x.type === "file" || x.type === "link")
      .map((x) => x.path);
  }
  fileIndexCache.set(root, { stamp, loadedAt: Date.now(), files });
  return files;
}
function fuzzyFileScore(file, query) {
  if (!query) return 1;
  const p = file.toLowerCase(),
    tokens = query.toLowerCase().split(/\s+/).filter(Boolean);
  let total = 0;
  for (const q of tokens) {
    let pi = 0,
      score = 0,
      run = 0;
    for (const c of q) {
      const at = p.indexOf(c, pi);
      if (at < 0) return -1;
      run = at === pi ? run + 1 : 0;
      score +=
        20 - at + run * 8 + (at === 0 || "/._-".includes(p[at - 1]) ? 12 : 0);
      pi = at + 1;
    }
    total += score - (p.length - q.length) * 0.03;
  }
  return total;
}
async function searchFiles(root, query) {
  const files = await fileIndex(root);
  return files
    .map((p) => ({
      path: p,
      name: path.posix.basename(p),
      score: fuzzyFileScore(p, query),
    }))
    .filter((x) => x.score >= 0)
    .sort((a, b) => b.score - a.score || a.path.localeCompare(b.path))
    .slice(0, 80)
    .map(({ path, name }) => ({ path, name }));
}
async function gitInfo(root, selectedCommit = "") {
  const [status, log, branch, upstream, divergence] = await Promise.all([
    run("git", ["-C", root, "status", "--short", "--branch"]).catch((e) =>
      Buffer.from(e.message),
    ),
    run("git", [
      "-C",
      root,
      "log",
      "-15",
      "--date=iso",
      "--pretty=format:%h%x09%ad%x09%an%x09%s",
    ]).catch((e) => Buffer.from(e.message)),
    run("git", ["-C", root, "branch", "--show-current"]).catch(() =>
      Buffer.from(""),
    ),
    run("git", ["-C", root, "rev-parse", "--abbrev-ref", "@{upstream}"]).catch(
      () => Buffer.from(""),
    ),
    run("git", [
      "-C",
      root,
      "rev-list",
      "--left-right",
      "--count",
      "HEAD...@{upstream}",
    ]).catch(() => Buffer.from("0\t0")),
  ]);
  const commits = log
    .toString()
    .split("\n")
    .filter(Boolean)
    .map((x) => {
      const [hash, date, author, ...msg] = x.split("\t");
      return { hash, date, author, message: msg.join("\t") };
    });
  const [ahead = 0, behind = 0] = divergence
    .toString()
    .trim()
    .split(/\s+/)
    .map(Number);
  let detail = null;
  if (selectedCommit && /^[0-9a-f]{7,40}$/i.test(selectedCommit)) {
    const show = await run("git", [
      "-C",
      root,
      "show",
      "--no-renames",
      "--date=iso-strict",
      "--format=%H%x00%an%x00%ae%x00%ad%x00%B%x00",
      "--name-status",
      selectedCommit,
    ]).catch(() => Buffer.from(""));
    const [hash, author, email, date, message, files = ""] = show
      .toString()
      .split("\0");
    if (hash) {
      detail = {
        hash,
        author,
        email,
        date,
        message: message.trim(),
        files: files
          .trim()
          .split("\n")
          .filter(Boolean)
          .map((line) => {
            const [status, ...parts] = line.split("\t");
            return { status, path: parts.join(" → ") };
          }),
      };
    }
  }
  return {
    branch: branch.toString().trim(),
    upstream: upstream.toString().trim(),
    ahead,
    behind,
    status: status.toString(),
    commits,
    latest: commits[0] || null,
    detail,
  };
}
async function streamCommand(res, cmd, args, filename, cwd) {
  res.writeHead(200, {
    ...securityHeaders(),
    "content-type": "application/octet-stream",
    "content-disposition": `attachment; filename="${filename}"`,
    "cache-control": "private, no-store",
  });
  const p = spawn(cmd, args, { cwd, stdio: ["ignore", "pipe", "pipe"] });
  p.stdout.pipe(res);
  let err = "";
  p.stderr.on("data", (d) => (err += d));
  p.on("close", (code) => {
    if (code !== 0 && !res.writableEnded) res.destroy(new Error(err));
  });
}

const applicationRoot = path.dirname(new URL(import.meta.url).pathname);
const providerExtension = path.join(applicationRoot, "child-provider.mjs");
const runRoot = path.join(applicationRoot, ".state/runs-v2");
const platform = makeWorkbenchPlatform({
  projects: PROJECTS,
  stateRoot: path.join(applicationRoot, ".state"),
});
const runStore = await runDirectory(runRoot);
const runEngine = await makeRunEngine(
  runStore,
  piRunExecutor(providerExtension),
  {
    stateRoot: runRoot,
    maxConcurrency: Number(process.env.BASH_WORKBENCH_MAX_AGENTS || 3),
    coldStartSpacingMs: Number(
      process.env.BASH_WORKBENCH_START_SPACING_MS || 4_000,
    ),
  },
);
const workflowRoot = path.join(applicationRoot, ".state/workflows-v1");
const workflowStore = await workflowDirectory(workflowRoot, {
  eventLimit: 50_000,
});
const workflowEngine = await makePiWorkflowEngine(workflowStore, {
  stateRoot: workflowRoot,
  projectRoot: (id) => {
    const selected = project(id);
    if (!selected) throw new Error(`Unknown project ${id}`);
    return selected.root;
  },
  maxConcurrency: 2,
  coldStartSpacingMs: 4_000,
  providerExtension,
});
const typedApi = await makeTypedApi(
  kyootBackend(
    {
      projects: PROJECTS,
      liveSession: ({ messages, trajectory }) =>
        sessionData(messages, trajectory),
      liveSessionPage: ({ cursor, limit }) => liveSessionPage(cursor, limit),
      liveTrajectory: (input) => liveTrajectoryPage(input),
      liveTrajectoryEvent,
      tree,
      searchFiles,
      contentSearch: (input, options) => platform.contentSearch(input, options),
      gitInfo,
      readFile: (project, relative) => readProjectFile(project.root, relative),
      writeFile: (project, relative, body) =>
        writeProjectFile(project.root, relative, body),
    },
    runEngine,
    async (operation, input, options) => {
      const validated = assertPlatformInput(operation, input);
      const { definition, value } = validated;
      const methodInput = { ...value, ...(definition.methodInput || {}) };
      if (definition.method === "downloadArtifact") {
        const artifacts = await platform.listArtifacts({});
        const artifact = artifacts.find((item) => item.id === methodInput.id);
        if (!artifact)
          throw Object.assign(
            new Error(`Unknown artifact: ${methodInput.id}`),
            {
              _tag: "UnknownArtifact",
            },
          );
        return artifact;
      }
      const method = platform[definition.method];
      if (typeof method !== "function")
        throw new Error(
          `Platform implementation is unavailable: ${definition.method}`,
        );
      return method.call(platform, methodInput, options);
    },
  ),
  workflowBackend(workflowEngine, (id) => PROJECTS.has(id)),
);
const unsubscribeRuns = runEngine.subscribe((run) => {
  typedApi.refreshRun(run.id).catch(() => {});
});
const refreshTypedRuns = setInterval(() => {
  typedApi.refreshRuns().catch(() => {});
}, 10_000);
refreshTypedRuns.unref();

async function serveWebApp(req, res, app, capability) {
  const controller = new AbortController();
  const abort = () => controller.abort();
  req.on("aborted", abort);
  res.on("close", abort);
  const chunks = [];
  for await (const chunk of req) chunks.push(chunk);
  const body = chunks.length ? Buffer.concat(chunks) : Buffer.alloc(0);
  if (capability) authorization.requireAccess(req, capability);
  const request = new Request(
    new URL(req.url, `http://${req.headers.host || "localhost"}`),
    {
      method: req.method,
      headers: req.headers,
      body: body.length ? body : undefined,
      signal: controller.signal,
    },
  );
  const response = await app(request);
  const headers = Object.fromEntries(response.headers);
  const gzip =
    /(?:^|,)\s*gzip\s*(?:,|$)/i.test(
      String(req.headers["accept-encoding"] || ""),
    ) && String(headers["content-type"] || "").includes("json");
  if (gzip) {
    delete headers["content-length"];
    headers["content-encoding"] = "gzip";
    headers.vary = headers.vary
      ? `${headers.vary}, Accept-Encoding`
      : "Accept-Encoding";
  }
  res.writeHead(response.status, {
    ...headers,
    ...securityHeaders(),
    "cache-control": "private, no-store",
  });
  if (!response.body) return res.end();
  if (gzip) {
    Readable.fromWeb(response.body).pipe(createGzip()).pipe(res);
    return;
  }
  const reader = response.body.getReader();
  try {
    while (!res.writableEnded) {
      const next = await reader.read();
      if (next.done) break;
      if (!res.write(Buffer.from(next.value)))
        await new Promise((resolve) => res.once("drain", resolve));
    }
  } finally {
    await reader.cancel().catch(() => {});
    if (!res.writableEnded) res.end();
  }
}

const server = http.createServer(async (req, res) => {
  try {
    const u = new URL(req.url, `http://${req.headers.host || "localhost"}`);
    if (u.pathname === "/api/auth/session" && req.method === "POST") {
      if (!AUTHENTICATION_REQUIRED)
        return json(res, 200, {
          ok: true,
          authenticated: true,
          role: "owner",
          authenticationRequired: false,
        });
      const body = await requestBody(req, 16_384);
      const session = authorization.createSession(String(body.token || ""));
      if (!session) return fail(res, 401, "Invalid Workbench credential");
      res.setHeader(
        "set-cookie",
        `bash_workbench_session=${session.id}; Path=/; HttpOnly; Secure; SameSite=Strict; Max-Age=43200`,
      );
      return json(res, 200, { ok: true, role: session.role });
    }
    if (u.pathname === "/api/auth/session" && req.method === "DELETE") {
      authorization.revokeSession(req);
      res.setHeader(
        "set-cookie",
        "bash_workbench_session=; Path=/; HttpOnly; Secure; SameSite=Strict; Max-Age=0",
      );
      return json(res, 200, { ok: true });
    }
    if (u.pathname === "/api/auth/session" && req.method === "GET") {
      const principal = authorization.principal(req);
      return json(res, 200, {
        authenticated: principal.authorized,
        role: principal.role,
        authenticationRequired: AUTHENTICATION_REQUIRED,
      });
    }
    if (u.pathname === "/api/rpc" || u.pathname === "/api/rpc/stream")
      return await serveWebApp(req, res, typedApi.workbenchApp, "rpc.access");
    if (u.pathname === "/api/sync" || u.pathname === "/api/sync/stream")
      return await serveWebApp(req, res, typedApi.syncApp, "sync.access");
    const artifactDownload = u.pathname.match(
      /^\/api\/artifacts\/([^/]+)\/download$/,
    );
    if (artifactDownload && req.method === "GET") {
      authorization.requireAccess(req, "artifacts.read");
      const artifactId = decodeURIComponent(artifactDownload[1]);
      const artifact = (await platform.listArtifacts()).find(
        (item) => item.id === artifactId,
      );
      if (!artifact) return fail(res, 404, "Artifact not found");
      const file = await platform.artifactPath(artifactId);
      const st = await fsp.stat(file);
      res.writeHead(200, {
        ...securityHeaders(),
        "content-type": artifact.contentType || "application/octet-stream",
        "content-length": st.size,
        "content-disposition": `attachment; filename="${artifact.fileName.replace(/[\"\\]/g, "-")}"`,
        "cache-control": "private, no-store",
      });
      return createReadStream(file).pipe(res);
    }
    if (u.pathname === "/api/health")
      return json(res, 200, {
        ok: true,
        mode: "kyoot",
        access: AUTHENTICATION_REQUIRED ? "authenticated" : "open-experimental",
        authenticationRequired: AUTHENTICATION_REQUIRED,
        orchestrator: {
          engine: "@kyoot/pi",
          maxActiveAgents: Number(process.env.BASH_WORKBENCH_MAX_AGENTS || 3),
          coldStartSpacingMs: Number(
            process.env.BASH_WORKBENCH_START_SPACING_MS || 4_000,
          ),
        },
        uptime: process.uptime(),
      });
    if (u.pathname === "/api/session-image" && req.method === "GET") {
      authorization.requireAccess(req, "session.read");
      const name = path.basename(u.searchParams.get("name") || "");
      if (!/\.(?:png|jpe?g|gif|webp)$/i.test(name))
        return fail(res, 400, "Invalid image");
      const target = safePath(UPLOADS_ROOT, name);
      const real = await realContained(UPLOADS_ROOT, target);
      const st = await fsp.stat(real);
      if (!st.isFile()) return fail(res, 404, "Image not found");
      res.writeHead(200, {
        ...securityHeaders(),
        "content-type": mime(real),
        "content-length": st.size,
        "cache-control": "private, no-store",
      });
      return createReadStream(real).pipe(res);
    }
    const match = u.pathname.match(/^\/api\/projects\/([^/]+)(.*)$/);
    if (match) {
      authorization.requireAccess(req, "projects.read");
      const p = project(decodeURIComponent(match[1]));
      if (!p) return fail(res, 404, "Unknown project");
      const action = match[2];
      if (req.method === "GET" && action === "/raw") {
        const rel = u.searchParams.get("path") || "";
        const target = safePath(p.root, rel);
        const real = await realContained(p.root, target);
        const st = await fsp.stat(real);
        if (!st.isFile()) return fail(res, 400, "Not a file");
        res.writeHead(200, {
          ...securityHeaders(),
          "content-type": mime(real),
          "content-length": st.size,
          "cache-control": "private, no-store",
        });
        return createReadStream(real).pipe(res);
      }
      if (action === "/source.zip")
        return streamCommand(
          res,
          "git",
          ["archive", "--format=zip", "HEAD"],
          `${p.id}-source.zip`,
          p.root,
        );
      if (action === "/repository.bundle")
        return streamCommand(
          res,
          "git",
          ["bundle", "create", "-", "--all"],
          `${p.id}.bundle`,
          p.root,
        );
    }
    if (u.pathname.startsWith("/api/"))
      return fail(res, 404, "API route not found");
    if (req.method !== "GET" && req.method !== "HEAD")
      return fail(res, 405, "Method not allowed");
    const logicalAsset = assetManifest.assets[u.pathname];
    let file =
      u.pathname === "/" ? "index.html" : (logicalAsset || u.pathname).slice(1);
    file =
      u.pathname === "/workbench-operation-catalog.mjs"
        ? path.join(applicationRoot, "workbench-operation-catalog.mjs")
        : safePath(PUBLIC, file);
    const st = await fsp.stat(file).catch(() => null);
    if (!st?.isFile()) {
      file = path.join(PUBLIC, "index.html");
    }
    const stat = await fsp.stat(file);
    const compress =
      /\bgzip\b/.test(String(req.headers["accept-encoding"] || "")) &&
      /\.(?:js|css|html|mjs|json|svg)$/i.test(file) &&
      stat.size > 1024;
    const publicPath = `/${path.relative(PUBLIC, file).split(path.sep).join("/")}`;
    const cacheControl = file.endsWith("index.html")
      ? "no-cache"
      : hashedAssets.has(u.pathname)
        ? "public, max-age=31536000, immutable"
        : "public, max-age=300";
    res.writeHead(200, {
      ...securityHeaders(),
      "content-type": mime(file),
      ...(compress
        ? { "content-encoding": "gzip", vary: "accept-encoding" }
        : { "content-length": stat.size }),
      "cache-control": cacheControl,
    });
    if (req.method === "HEAD") return res.end();
    const stream = createReadStream(file);
    if (compress) stream.pipe(createGzip()).pipe(res);
    else stream.pipe(res);
  } catch (e) {
    fail(res, e?.status || 500, e instanceof Error ? e.message : String(e));
  }
});
let shuttingDown = false;
const shutdown = async () => {
  if (shuttingDown) return;
  shuttingDown = true;
  clearInterval(refreshTypedRuns);
  unsubscribeRuns();
  server.close();
  server.closeIdleConnections?.();
  const force = setTimeout(() => server.closeAllConnections?.(), 2_000);
  force.unref();
  await Promise.all([
    runEngine.shutdown().catch(() => {}),
    workflowEngine.shutdown().catch(() => {}),
    platform.shutdown().catch(() => {}),
  ]);
  clearTimeout(force);
  server.closeAllConnections?.();
};
process.once("SIGTERM", () => void shutdown());
process.once("SIGINT", () => void shutdown());
server.listen(PORT, HOST, () =>
  console.log(`Bash Workbench listening on http://${HOST}:${PORT}`),
);
