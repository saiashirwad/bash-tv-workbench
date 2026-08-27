#!/usr/bin/env node
import fs from "node:fs/promises";
import path from "node:path";
import process from "node:process";
import crypto from "node:crypto";
import { fileURLToPath } from "node:url";
import { PLATFORM_OPERATION_CATALOG } from "../workbench-operation-catalog.mjs";

const VERSION = "1.0.0";
const INSTALL_ROOT = path.dirname(path.dirname(fileURLToPath(import.meta.url)));
const TERMINAL_RUN_STATES = new Set([
  "completed",
  "failed",
  "stopped",
  "cancelled",
  "interrupted",
]);
const TERMINAL_WORKFLOW_STATES = new Set([
  "completed",
  "failed",
  "cancelled",
  "interrupted",
]);

const HELP = `Bash Workbench CLI ${VERSION}

Usage: bash-workbench [global options] <command> [options]

Global options:
  --url URL             Workbench URL (default: http://127.0.0.1:8010)
  --project ID          Default project ID
  --token-file PATH     Control token file; read silently when it exists
  --timeout MS          Request timeout (default: 300000)
  --compact             Print compact JSON
  --raw                 Print a command's primary text value

Core commands:
  status [--wait]
  projects list|register
  runs list|get|create|batch|message|stop|compact|events|watch|wait
  workflows list|get|create|add-tasks|cancel|cancel-task|retry-task|events|wait
  trajectory list|get
  live info|messages
  files tree|read|write|search|grep|patch
  fs mkdir|copy|move|rename|delete|chmod|symlink
  git status|log|diff|stage|commit|branch|fetch|pull|push
  exec
  process list|start|read|follow|write|stop
  artifact list|export|download|delete|import
  snapshot list|create|restore
  vm info|ports|ps
  op list|describe|call
  rpc

Examples:
  bash-workbench projects list
  bash-workbench projects register --root /home/bashtv/my-app --name "My App"
  bash-workbench runs create --project app --title "Fix tests" --prompt "Fix the failing tests"
  bash-workbench runs wait RUN_ID
  bash-workbench runs events RUN_ID --tail 50
  bash-workbench exec --project app -- npm test
  bash-workbench files grep --project app --query "TODO" --include "src/**"
  bash-workbench workflows create --file workflow.json
  bash-workbench op describe workbench_create_snapshot
  bash-workbench rpc runs.get --input '{"id":"RUN_ID"}'

Use '-' as a file name to read JSON or text from stdin.
`;

const COMMAND_HELP = {
  status: `Usage: bash-workbench status [--wait] [--wait-timeout MS] [--interval MS]\n\nCheck Workbench health. --wait retries until the server is ready.\n`,
  projects: `Usage: bash-workbench projects <list|register> [options]\n`,
  "projects register": `Usage: bash-workbench projects register --root PATH [--name TEXT] [--id ID]\n\nPersist a project and make it visible in the running Workbench. The name defaults to the directory name, and the ID defaults to a lowercase name slug.\n`,
  runs: `Usage: bash-workbench runs <list|create|batch|get|message|stop|compact|events|watch|wait> [options]\n\nUse "bash-workbench runs <command> --help" for command details.\n`,
  "runs create": `Usage: bash-workbench runs create [--project ID] (--prompt TEXT | --prompt-file FILE) [--title TEXT]\n\nCreate one agent run. The first registered project is used when --project is omitted.\n`,
  "runs batch": `Usage: bash-workbench runs batch (--input JSON | --file FILE) [--project ID] [--concurrency N] [--full]\n\nCreate up to 50 independent agent runs. Input is an array or an object with a runs array. Calls run concurrently.\n`,
  workflows: `Usage: bash-workbench workflows <list|create|get|add-tasks|cancel|cancel-task|retry-task|events|wait> [options]\n\nUse --file, --input, or stdin for workflow JSON.\n`,
  "workflows create": `Usage: bash-workbench workflows create (--input JSON | --file FILE)\n\nCreate a durable workflow. See CLI.md for the task schema.\n`,
  files: `Usage: bash-workbench files <tree|read|write|search|grep|patch> [options]\n`,
  fs: `Usage: bash-workbench fs <mkdir|copy|move|rename|delete|chmod|symlink> [options]\n`,
  git: `Usage: bash-workbench git <status|log|diff|stage|commit|branch|fetch|pull|push> [options]\n`,
  process: `Usage: bash-workbench process <list|start|read|follow|write|stop> [options]\n`,
  artifact: `Usage: bash-workbench artifact <list|export|download|delete|import> [options]\n`,
  snapshot: `Usage: bash-workbench snapshot <list|create|restore> [options]\n`,
  trajectory: `Usage: bash-workbench trajectory <list|get> [options]\n`,
  live: `Usage: bash-workbench live <info|messages> [options]\n`,
  vm: `Usage: bash-workbench vm <info|ports|ps> [options]\n`,
  op: `Usage: bash-workbench op <list|describe|call> [options]\n`,
  rpc: `Usage: bash-workbench rpc PROCEDURE (--input JSON | --file FILE)\n`,
  exec: `Usage: bash-workbench exec [--project ID] [--cwd PATH] -- COMMAND [ARGS...]\n`,
};

const helpFor = (group, action) =>
  `Bash Workbench CLI ${VERSION}\n\n${COMMAND_HELP[[group, action].filter(Boolean).join(" ")] || COMMAND_HELP[group] || HELP}`;

const BOOLEAN_OPTIONS = new Set([
  "allow-failure",
  "cached",
  "compact",
  "confirm",
  "create",
  "dry-run",
  "events",
  "force",
  "full",
  "help",
  "include-git",
  "include-ignored",
  "no-auth",
  "overwrite",
  "raw",
  "recursive",
  "regex",
  "version",
  "wait",
]);

const splitArguments = (argv) => {
  const options = new Map();
  const positional = [];
  let passthrough = [];
  for (let index = 0; index < argv.length; index++) {
    const item = argv[index];
    if (item === "--") {
      passthrough = argv.slice(index + 1);
      break;
    }
    if (!item.startsWith("--")) {
      positional.push(item);
      continue;
    }
    const equal = item.indexOf("=");
    const key = item.slice(2, equal < 0 ? undefined : equal);
    const next = equal >= 0 ? item.slice(equal + 1) : argv[index + 1];
    const value =
      equal >= 0
        ? next
        : BOOLEAN_OPTIONS.has(key)
          ? true
          : next != null && !next.startsWith("--")
            ? next
            : true;
    if (equal < 0 && value !== true) index++;
    const previous = options.get(key);
    options.set(
      key,
      previous == null
        ? value
        : Array.isArray(previous)
          ? [...previous, value]
          : [previous, value],
    );
  }
  return { options, positional, passthrough };
};

const parsed = splitArguments(process.argv.slice(2));
const option = (name, fallback) =>
  parsed.options.has(name) ? parsed.options.get(name) : fallback;
const flag = (name) => option(name, false) === true || option(name) === "true";
const number = (name, fallback) => {
  const value = Number(option(name, fallback));
  if (!Number.isFinite(value)) throw new Error(`--${name} must be a number`);
  return value;
};
const strings = (name) => {
  const value = option(name, []);
  return (Array.isArray(value) ? value : value === true ? [] : [value])
    .flatMap((item) => String(item).split(","))
    .filter(Boolean);
};
const required = (name) => {
  const value = option(name);
  if (value == null || value === true || value === "")
    throw new Error(`--${name} is required`);
  return String(value);
};
const first = (index, label) => {
  const value = parsed.positional[index];
  if (!value) throw new Error(`${label} is required`);
  return value;
};
const sleep = (milliseconds) =>
  new Promise((resolve) => setTimeout(resolve, milliseconds));
const shellWord = (value) => `'${String(value).replace(/'/g, `'"'"'`)}'`;
const passthroughCommand = () => parsed.passthrough.map(shellWord).join(" ");

const readInput = async (filename, fallback = "") => {
  if (!filename) return fallback;
  if (filename === "-") {
    const chunks = [];
    for await (const chunk of process.stdin) chunks.push(chunk);
    return Buffer.concat(chunks).toString("utf8");
  }
  return fs.readFile(path.resolve(filename), "utf8");
};
const jsonInput = async (
  value = option("input"),
  filename = option("file"),
) => {
  const source = filename ? await readInput(String(filename)) : value;
  if (source == null || source === true || source === "") return {};
  if (typeof source !== "string") return source;
  if (source.startsWith("@"))
    return JSON.parse(await readInput(source.slice(1)));
  return JSON.parse(source);
};

class WorkbenchClient {
  constructor({ url, token, timeoutMs }) {
    this.url = String(url).replace(/\/$/, "");
    this.token = token;
    this.timeoutMs = timeoutMs;
  }

  headers(json = true) {
    return {
      ...(json ? { "content-type": "application/json" } : {}),
      ...(this.token ? { "x-workbench-control": this.token } : {}),
    };
  }

  async request(url, init = {}, timeoutMs = this.timeoutMs) {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), timeoutMs);
    try {
      const response = await fetch(`${this.url}${url}`, {
        ...init,
        signal: controller.signal,
      });
      const text = await response.text();
      let payload = text;
      try {
        payload = text ? JSON.parse(text) : null;
      } catch {}
      if (!response.ok) {
        const message =
          payload?.error?.message ||
          payload?.message ||
          text ||
          `HTTP ${response.status}`;
        throw Object.assign(new Error(message), {
          status: response.status,
          payload,
        });
      }
      return payload;
    } finally {
      clearTimeout(timer);
    }
  }

  async rpc(procedure, input = {}) {
    const payload = await this.request("/api/rpc", {
      method: "POST",
      headers: this.headers(),
      body: JSON.stringify({
        version: 1,
        id: crypto.randomUUID(),
        procedure,
        input,
      }),
    });
    if (payload?.ok === false) {
      const error = payload.error || {};
      throw Object.assign(
        new Error(error.message || `RPC failed: ${procedure}`),
        error,
      );
    }
    return payload?.output;
  }

  platform(operation, input = {}) {
    return this.rpc("platform.call", { operation, input });
  }

  async download(relativeUrl, filename) {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), this.timeoutMs);
    try {
      const response = await fetch(`${this.url}${relativeUrl}`, {
        headers: this.headers(false),
        signal: controller.signal,
      });
      if (!response.ok)
        throw new Error((await response.text()) || `HTTP ${response.status}`);
      const data = Buffer.from(await response.arrayBuffer());
      const target = path.resolve(filename);
      await fs.writeFile(target, data, { flag: "wx" });
      return { path: target, bytes: data.length };
    } finally {
      clearTimeout(timer);
    }
  }
}

const loadToken = async () => {
  if (flag("no-auth")) return "";
  const direct = process.env.BASH_WORKBENCH_CONTROL_TOKEN;
  if (direct) return direct;
  const filename = path.resolve(
    String(
      option(
        "token-file",
        process.env.BASH_WORKBENCH_TOKEN_FILE ||
          path.join(INSTALL_ROOT, ".state/workflows-v1/control.token"),
      ),
    ),
  );
  return (await fs.readFile(filename, "utf8").catch(() => "")).trim();
};

const client = new WorkbenchClient({
  url: option(
    "url",
    process.env.BASH_WORKBENCH_URL ||
      `http://127.0.0.1:${process.env.BASH_WORKBENCH_PORT || 8010}`,
  ),
  token: await loadToken(),
  timeoutMs: number("timeout", 300_000),
});

const print = (value, primary) => {
  if (flag("raw") && primary != null) process.stdout.write(String(primary));
  else
    process.stdout.write(
      `${JSON.stringify(value, null, flag("compact") ? 0 : 2)}\n`,
    );
};
const project = async () => {
  const selected = option("project", process.env.BASH_WORKBENCH_PROJECT);
  if (selected) return String(selected);
  const projects = await client.rpc("projects.list", {});
  if (!projects?.length) throw new Error("No Workbench project is registered");
  return projects[0].id;
};
const confirmation = () => flag("confirm");
const statusList = () => strings("status");
const conciseRun = ({ id, project, title, status }) => ({
  id,
  project,
  title,
  status,
});
const mapConcurrent = async (items, concurrency, visit) => {
  const results = new Array(items.length);
  let next = 0;
  const workers = Array.from(
    { length: Math.min(items.length, concurrency) },
    async () => {
      while (next < items.length) {
        const index = next++;
        results[index] = await visit(items[index], index);
      }
    },
  );
  await Promise.all(workers);
  return results;
};

const healthCommand = async () => {
  if (!flag("wait"))
    return client.request("/api/health", { headers: client.headers(false) });
  const deadline = Date.now() + number("wait-timeout", 60_000);
  let lastError;
  while (Date.now() < deadline) {
    try {
      const health = await client.request(
        "/api/health",
        { headers: client.headers(false) },
        Math.min(2_000, Math.max(1, deadline - Date.now())),
      );
      if (health?.ok === true) return health;
      lastError = new Error("health did not report ok: true");
    } catch (error) {
      lastError = error;
    }
    await sleep(
      Math.min(number("interval", 500), Math.max(0, deadline - Date.now())),
    );
  }
  throw new Error(
    `Workbench was not ready within ${number("wait-timeout", 60_000)}ms${lastError?.message ? `: ${lastError.message}` : ""}`,
  );
};

const runCommand = async (action) => {
  if (action === "list") {
    let runs = await client.rpc("runs.list", {});
    const statuses = statusList();
    const selectedProject = option("project");
    if (selectedProject)
      runs = runs.filter((run) => run.project === selectedProject);
    if (statuses.length)
      runs = runs.filter((run) => statuses.includes(run.status));
    return runs.slice(0, number("limit", 50));
  }
  if (action === "create") {
    const prompt = option("prompt") ?? (await readInput(option("prompt-file")));
    if (!prompt) throw new Error("--prompt or --prompt-file is required");
    return client.rpc("runs.create", {
      project: await project(),
      prompt: String(prompt),
      ...(option("title") ? { title: String(option("title")) } : {}),
    });
  }
  if (action === "batch") {
    const input = await jsonInput();
    const tasks = Array.isArray(input) ? input : input.runs;
    if (!Array.isArray(tasks) || tasks.length === 0)
      throw new Error("Batch input must contain at least one run");
    if (tasks.length > 50) throw new Error("Batch input cannot exceed 50 runs");
    const fallbackProject = tasks.some((task) => !task?.project)
      ? await project()
      : null;
    const created = await mapConcurrent(
      tasks,
      Math.max(1, Math.min(25, number("concurrency", 10))),
      (task, index) => {
        if (!task || typeof task !== "object")
          throw new Error(`Run ${index + 1} must be an object`);
        if (typeof task.prompt !== "string" || !task.prompt.trim())
          throw new Error(`Run ${index + 1} requires a prompt`);
        return client.rpc("runs.create", {
          project: String(task.project || fallbackProject),
          prompt: task.prompt,
          ...(task.title ? { title: String(task.title) } : {}),
        });
      },
    );
    return flag("full") ? created : created.map(conciseRun);
  }
  const id = first(2, "run ID");
  if (action === "get") {
    const run = await client.rpc("runs.get", { id });
    if (!flag("events")) return run;
    const page = await client.rpc("runs.events", {
      id,
      after: 0,
      before: null,
      limit: number("limit", 500),
    });
    return { ...run, events: page.events, eventsTruncated: page.more };
  }
  if (action === "message") {
    const message =
      option("message") ?? (await readInput(option("message-file")));
    if (!message) throw new Error("--message or --message-file is required");
    return client.rpc("runs.message", { id, message: String(message) });
  }
  if (["stop", "compact"].includes(action))
    return client.rpc(`runs.${action}`, { id });
  if (action === "events") {
    const tail = option("tail");
    return client.rpc("runs.events", {
      id,
      after: number("after", 0),
      before: tail
        ? Number.MAX_SAFE_INTEGER
        : option("before")
          ? number("before")
          : null,
      limit: Number(tail || option("limit", 100)),
    });
  }
  if (action === "wait") {
    const deadline = Date.now() + number("wait-timeout", 30 * 60_000);
    while (Date.now() < deadline) {
      const run = await client.rpc("runs.get", { id });
      if (TERMINAL_RUN_STATES.has(run.status)) return run;
      await sleep(number("interval", 750));
    }
    throw new Error(`Timed out while waiting for run ${id}`);
  }
  if (action === "watch") {
    let cursor = number("after", 0);
    const deadline = Date.now() + number("wait-timeout", 30 * 60_000);
    while (Date.now() < deadline) {
      const page = await client.rpc("runs.events", {
        id,
        after: cursor,
        before: null,
        limit: 100,
      });
      for (const event of page.events)
        process.stdout.write(`${JSON.stringify(event)}\n`);
      cursor = page.nextCursor;
      if (page.completed && !page.more)
        return {
          ...(await client.rpc("runs.get", { id })),
          eventCursor: cursor,
        };
      await sleep(number("interval", 500));
    }
    throw new Error(`Timed out while watching run ${id}`);
  }
  throw new Error(`Unknown runs command: ${action}`);
};

const workflowCommand = async (action) => {
  if (action === "list") return client.rpc("workflows.list", {});
  if (action === "create")
    return client.rpc("workflows.create", await jsonInput());
  const id = first(2, "workflow ID");
  if (action === "get") return client.rpc("workflows.get", { id });
  if (action === "add-tasks") {
    const input = await jsonInput();
    return client.rpc("workflows.addTasks", {
      workflowId: id,
      tasks: input.tasks || input,
    });
  }
  if (action === "cancel") return client.rpc("workflows.cancel", { id });
  if (action === "cancel-task" || action === "retry-task") {
    const taskId = first(3, "task ID");
    return client.rpc(
      action === "cancel-task" ? "workflows.cancelTask" : "workflows.retryTask",
      { workflowId: id, taskId },
    );
  }
  if (action === "events")
    return client.rpc("workflows.events", {
      after: number("after", 0),
      workflowId: id,
      taskId: option("task"),
      limit: number("limit", 1000),
    });
  if (action === "wait") {
    const deadline = Date.now() + number("wait-timeout", 60 * 60_000);
    while (Date.now() < deadline) {
      const workflow = await client.rpc("workflows.get", { id });
      if (TERMINAL_WORKFLOW_STATES.has(workflow.status)) return workflow;
      await sleep(number("interval", 1000));
    }
    throw new Error(`Timed out while waiting for workflow ${id}`);
  }
  throw new Error(`Unknown workflows command: ${action}`);
};

const platform = (name, input) => client.platform(name, input);
const fileCommand = async (action) => {
  const selectedProject = await project();
  if (action === "tree")
    return client.rpc("files.tree", {
      project: selectedProject,
      path: String(option("path", "")),
    });
  if (action === "read") {
    const result = await client.rpc("files.read", {
      project: selectedProject,
      path: first(2, "path"),
    });
    return result;
  }
  if (action === "write") {
    const filename = first(2, "path");
    const content = option("content") ?? (await readInput(option("file", "-")));
    return client.rpc("files.write", {
      project: selectedProject,
      path: filename,
      content: String(content),
      ...(option("revision") ? { expectedRevision: option("revision") } : {}),
    });
  }
  if (action === "search")
    return client.rpc("files.search", {
      project: selectedProject,
      query: required("query"),
      limit: number("limit", 100),
    });
  if (action === "grep")
    return client.rpc("files.contentSearch", {
      project: selectedProject,
      query: required("query"),
      regex: flag("regex"),
      include: strings("include"),
      exclude: strings("exclude"),
      limit: number("limit", 100),
      maxFileSize: number("max-file-size", 2 * 1024 * 1024),
      contextLines: number("context", 0),
      timeoutMs: number("search-timeout", 30_000),
    });
  if (action === "patch")
    return platform("workbench_apply_patch", {
      project: selectedProject,
      patch: await readInput(option("file", "-")),
      dryRun: flag("dry-run"),
    });
  throw new Error(`Unknown files command: ${action}`);
};

const gitCommand = async (action) => {
  const selectedProject = await project();
  if (action === "status")
    return client.rpc("git.info", { project: selectedProject });
  if (action === "log")
    return client.rpc("git.commits", {
      project: selectedProject,
      limit: number("limit", 50),
    });
  if (action === "diff")
    return platform("workbench_git_diff", {
      project: selectedProject,
      cached: flag("cached"),
      ...(option("ref") ? { ref: option("ref") } : {}),
    });
  if (action === "stage")
    return platform("workbench_git_stage", {
      project: selectedProject,
      paths: parsed.positional.slice(2),
    });
  if (action === "commit")
    return platform("workbench_git_commit", {
      project: selectedProject,
      message: required("message"),
    });
  if (action === "branch")
    return platform("workbench_git_branch", {
      project: selectedProject,
      name: first(2, "branch name"),
      create: flag("create"),
    });
  if (["fetch", "pull", "push"].includes(action))
    return platform("workbench_git_sync", {
      project: selectedProject,
      action,
      ...(option("remote") ? { remote: option("remote") } : {}),
      confirm: action === "fetch" || confirmation(),
    });
  throw new Error(`Unknown git command: ${action}`);
};

const fsCommand = async (action) => {
  const allowed = new Set([
    "mkdir",
    "copy",
    "move",
    "rename",
    "delete",
    "chmod",
    "symlink",
  ]);
  if (!allowed.has(action)) throw new Error(`Unknown fs command: ${action}`);
  const source = first(2, "path");
  const destination = option("destination", parsed.positional[3]);
  return platform("workbench_fs_mutate", {
    project: await project(),
    operation: action,
    path: source,
    ...(destination ? { destination: String(destination) } : {}),
    ...(flag("recursive") ? { recursive: true } : {}),
    ...(option("mode") ? { mode: String(option("mode")) } : {}),
    ...(confirmation() ? { confirm: true } : {}),
  });
};

const processCommand = async (action) => {
  if (action === "list")
    return platform(
      "workbench_list_processes",
      option("project") ? { project: option("project") } : {},
    );
  if (action === "start")
    return platform("workbench_start_process", {
      project: await project(),
      command: passthroughCommand() || required("command"),
      ...(option("cwd") ? { cwd: option("cwd") } : {}),
    });
  const id = first(2, "process ID");
  if (action === "read")
    return platform("workbench_read_process", {
      id,
      stdoutCursor: number("stdout-cursor", 0),
      stderrCursor: number("stderr-cursor", 0),
      maxOutputBytes: number("max-output", 512 * 1024),
    });
  if (action === "write")
    return platform("workbench_write_process", {
      id,
      text: String(option("text") ?? (await readInput(option("file", "-")))),
    });
  if (action === "stop")
    return platform("workbench_stop_process", { id, force: flag("force") });
  if (action === "follow") {
    let stdoutCursor = 0,
      stderrCursor = 0;
    while (true) {
      const result = await platform("workbench_read_process", {
        id,
        stdoutCursor,
        stderrCursor,
        maxOutputBytes: number("max-output", 128 * 1024),
      });
      if (result.stdout) process.stdout.write(result.stdout);
      if (result.stderr) process.stderr.write(result.stderr);
      stdoutCursor = result.stdoutCursor ?? stdoutCursor;
      stderrCursor = result.stderrCursor ?? stderrCursor;
      if (!result.running) return result;
      await sleep(number("interval", 500));
    }
  }
  throw new Error(`Unknown process command: ${action}`);
};

const artifactCommand = async (action) => {
  if (action === "list")
    return platform(
      "workbench_list_artifacts",
      option("project") ? { project: option("project") } : {},
    );
  if (action === "export")
    return platform("workbench_export_project", {
      project: await project(),
      format: option("format", "zip"),
      ...(option("name") ? { name: option("name") } : {}),
      includeGit: flag("include-git"),
      includeIgnored: flag("include-ignored"),
      include: strings("include"),
      exclude: strings("exclude"),
    });
  const id = first(2, "artifact ID");
  if (action === "download") {
    const artifact = await platform("workbench_download_artifact", { id });
    const saved = await client.download(
      artifact.downloadUrl,
      String(option("output", artifact.fileName || `artifact-${id}`)),
    );
    return { ...artifact, ...saved, downloadUrl: undefined };
  }
  if (action === "delete")
    return platform("workbench_delete_artifact", {
      id,
      confirm: confirmation(),
    });
  if (action === "import")
    return platform("workbench_import_archive", {
      project: await project(),
      artifactId: id,
      dryRun: flag("dry-run"),
      overwrite: flag("overwrite"),
      confirm: confirmation(),
    });
  throw new Error(`Unknown artifact command: ${action}`);
};

const snapshotCommand = async (action) => {
  if (action === "list")
    return platform(
      "workbench_list_snapshots",
      option("project") ? { project: option("project") } : {},
    );
  if (action === "create")
    return platform("workbench_create_snapshot", {
      project: await project(),
      ...(option("name") ? { name: option("name") } : {}),
    });
  if (action === "restore")
    return platform("workbench_restore_snapshot", {
      project: await project(),
      id: first(2, "snapshot ID"),
      confirm: confirmation(),
    });
  throw new Error(`Unknown snapshot command: ${action}`);
};

async function dispatch() {
  const [group, action] = parsed.positional;
  if (flag("version") || group === "version") return { version: VERSION };
  if (!group || group === "help") return { help: HELP };
  if (flag("help")) return { help: helpFor(group, action) };
  if (group === "status") return healthCommand();
  if (group === "projects") {
    if (!action || action === "list") return client.rpc("projects.list", {});
    if (action === "register")
      return client.rpc("projects.register", {
        root: required("root"),
        ...(option("name") ? { name: String(option("name")) } : {}),
        ...(option("id") ? { id: String(option("id")) } : {}),
      });
  }
  if (group === "runs") return runCommand(action || "list");
  if (group === "workflows") return workflowCommand(action || "list");
  if (group === "trajectory") {
    if (action === "list")
      return client.rpc("live.trajectory", {
        before: option("before") ? number("before") : null,
        limit: number("limit", 100),
        query: String(option("query", "")),
      });
    if (action === "get")
      return client.rpc("live.trajectoryEvent", { id: first(2, "event ID") });
  }
  if (group === "live") {
    if (action === "info")
      return client.rpc("live.session", { messages: false, trajectory: false });
    if (action === "messages")
      return client.rpc("live.page", {
        cursor: option("cursor", null),
        limit: number("limit", 100),
      });
  }
  if (group === "files") return fileCommand(action);
  if (group === "fs") return fsCommand(action);
  if (group === "git") return gitCommand(action);
  if (group === "exec")
    return platform("workbench_exec", {
      project: await project(),
      command: passthroughCommand() || required("command"),
      ...(option("cwd") ? { cwd: option("cwd") } : {}),
      timeoutMs: number("command-timeout", 30_000),
      maxOutputBytes: number("max-output", 512 * 1024),
    });
  if (group === "process") return processCommand(action || "list");
  if (group === "artifact") return artifactCommand(action || "list");
  if (group === "snapshot") return snapshotCommand(action || "list");
  if (group === "vm") {
    if (action === "info") return platform("workbench_vm_info", {});
    if (action === "ports") return platform("workbench_list_ports", {});
    if (action === "ps")
      return platform("workbench_list_system_processes", {
        limit: number("limit", 100),
      });
  }
  if (group === "op") {
    if (action === "list")
      return PLATFORM_OPERATION_CATALOG.map(
        ({ name, title, description, annotations }) => ({
          name,
          title,
          description,
          ...annotations,
        }),
      );
    if (action === "describe") {
      const name = first(2, "operation name");
      const found = PLATFORM_OPERATION_CATALOG.find(
        (entry) => entry.name === name,
      );
      if (!found) throw new Error(`Unknown operation: ${name}`);
      return found;
    }
    if (action === "call")
      return platform(first(2, "operation name"), await jsonInput());
  }
  if (group === "rpc")
    return client.rpc(first(1, "procedure"), await jsonInput());
  throw new Error(
    `Unknown command: ${[group, action].filter(Boolean).join(" ")}`,
  );
}

try {
  const result = await dispatch();
  if (result?.help) process.stdout.write(result.help);
  else print(result, result?.content ?? result?.stdout ?? result?.diff);
  const [group, action] = parsed.positional;
  if (!flag("allow-failure")) {
    if (
      ((group === "runs" || group === "workflows") &&
        ["wait", "watch"].includes(action) &&
        result?.status &&
        result.status !== "completed") ||
      (group === "exec" && result?.exitCode)
    )
      process.exitCode = 2;
  }
} catch (error) {
  process.stderr.write(`${error?.message || String(error)}\n`);
  if (error?.issues)
    process.stderr.write(`${JSON.stringify(error.issues, null, 2)}\n`);
  process.exitCode = 1;
}
