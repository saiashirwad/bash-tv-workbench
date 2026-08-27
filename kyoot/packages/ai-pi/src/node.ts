import { spawn, type ChildProcessWithoutNullStreams } from "node:child_process";
import fs from "node:fs";
import { fileURLToPath } from "node:url";
import { Model, type Request } from "@kyoot/ai";
import { Async, Emit, Fail, Kyoot, Resource } from "kyoot";
import type { CompleteCommand, HelperEvent, ModelId, Thinking } from "./protocol.ts";

const helperPath = fileURLToPath(new URL("./helper.mjs", import.meta.url));

const allowedEnvironment = [
  "HOME",
  "PATH",
  "LANG",
  "TERM",
  "TMPDIR",
  "API_REFRESH_TOKEN",
  "BASHTV_FREE_LLM_URL",
  "BASHTV_FREE_MODEL_INFO",
  "BASHTV_TUNNEL_AUTH_TOKEN",
  "VERCEL_AUTOMATION_BYPASS_SECRET",
] as const;

export class BashTvModelError {
  readonly _tag = "BashTvModelError";
  readonly kind: string;
  readonly message: string;
  constructor(kind: string, message: string) {
    this.kind = kind;
    this.message = message;
  }
}

export interface RuntimeOptions {
  readonly helperPath?: string;
  readonly piAiPath?: string;
  readonly nodePath?: string;
  readonly platformPid?: number;
  readonly environment?: () => Readonly<Record<string, string>>;
  readonly terminateGraceMs?: number;
  readonly maxStderrBytes?: number;
}

export interface ModelOptions {
  readonly thinking?: Thinking;
}

interface EventQueue {
  readonly iterable: AsyncIterable<HelperEvent>;
  push(event: HelperEvent): void;
  end(): void;
}

interface Invocation {
  readonly child: ChildProcessWithoutNullStreams;
  readonly events: AsyncIterable<HelperEvent>;
  readonly exited: Promise<void>;
  readonly close: () => Promise<void>;
}

const eventQueue = (): EventQueue => {
  const values: HelperEvent[] = [];
  const waiters: Array<(result: IteratorResult<HelperEvent>) => void> = [];
  let ended = false;
  return {
    iterable: {
      [Symbol.asyncIterator]: () => ({
        next: () => {
          const event = values.shift();
          if (event) return Promise.resolve({ value: event, done: false });
          if (ended) return Promise.resolve({ value: undefined, done: true });
          return new Promise((resolve) => waiters.push(resolve));
        },
        return: async () => ({ value: undefined, done: true }),
      }),
    },
    push: (event) => {
      if (ended) return;
      const waiter = waiters.shift();
      if (waiter) waiter({ value: event, done: false });
      else values.push(event);
    },
    end: () => {
      if (ended) return;
      ended = true;
      for (const waiter of waiters.splice(0)) waiter({ value: undefined, done: true });
    },
  };
};

const parseEnvironment = (raw: string) =>
  Object.fromEntries(
    raw
      .split("\0")
      .filter(Boolean)
      .map((entry) => {
        const index = entry.indexOf("=");
        return [entry.slice(0, index), entry.slice(index + 1)];
      }),
  );

/** Reads only explicitly allowlisted values and never returns them from the provider. */
export const inheritedEnvironment = (platformPid?: number): Record<string, string> => {
  let source: Record<string, string | undefined> = { ...process.env };
  const configuredPid = platformPid ?? Number(process.env.BASH_WORKBENCH_PLATFORM_PID);
  const candidates: number[] = [];
  if (Number.isInteger(configuredPid) && configuredPid > 0) candidates.push(configuredPid);

  // A direct invocation normally inherits entitlement already. Discovery is a
  // fallback for clean supervisors and deliberately considers only same-user Pi.
  if (!source.BASHTV_FREE_LLM_URL) {
    try {
      for (const entry of fs.readdirSync("/proc")) {
        const pid = Number(entry);
        if (!Number.isInteger(pid) || candidates.includes(pid)) continue;
        try {
          if (fs.statSync(`/proc/${pid}`).uid !== process.getuid?.()) continue;
          if (fs.readFileSync(`/proc/${pid}/comm`, "utf8").trim() === "pi") candidates.push(pid);
        } catch {
          // Processes may exit during discovery.
        }
      }
    } catch {
      // Non-Linux runtimes must supply an entitled environment explicitly.
    }
  }

  for (const pid of candidates) {
    try {
      const candidate = parseEnvironment(fs.readFileSync(`/proc/${pid}/environ`, "utf8"));
      if (!candidate.BASHTV_FREE_LLM_URL) continue;
      source = { ...source, ...candidate };
      break;
    } catch {
      // The caller may already have an entitled environment.
    }
  }
  return Object.fromEntries(
    allowedEnvironment.flatMap((key) =>
      source[key] === undefined ? [] : [[key, source[key] as string]],
    ),
  );
};

const terminate = async (pid: number | undefined, exited: Promise<void>, graceMs: number) => {
  if (pid === undefined) return;
  try {
    process.kill(-pid, "SIGTERM");
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== "ESRCH") throw error;
    return;
  }
  const done = await Promise.race([
    exited.then(() => true),
    new Promise<false>((resolve) => setTimeout(() => resolve(false), graceMs)),
  ]);
  if (done) return;
  try {
    process.kill(-pid, "SIGKILL");
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== "ESRCH") throw error;
  }
  await exited;
};

const redact = (message: string) =>
  message
    .replace(/(authorization|api[_-]?key|token)\s*[:=]\s*[^\s,;]+/gi, "$1=[redacted]")
    .replace(/https?:\/\/[^\s,;]+/gi, "[redacted-url]")
    .slice(0, 4_000);

const decode = (line: string): HelperEvent => {
  const value = JSON.parse(line) as HelperEvent;
  if (value.type !== "text" && value.type !== "result" && value.type !== "error")
    throw new Error("unknown helper event");
  return value;
};

const launch = (
  runtime: RuntimeOptions,
  model: ModelId,
  thinking: Thinking,
  request: Request,
): Invocation => {
  const environment = runtime.environment?.() ?? inheritedEnvironment(runtime.platformPid);
  const child = spawn(runtime.nodePath ?? process.execPath, [runtime.helperPath ?? helperPath], {
    env: {
      ...environment,
      KYOOT_PI_AI_PATH:
        runtime.piAiPath ?? "/opt/pi-mono/node_modules/@mariozechner/pi-ai/dist/index.js",
    },
    stdio: ["pipe", "pipe", "pipe"],
    detached: true,
  });
  const queue = eventQueue();
  let stdout = "";
  let stderr = "";
  let sawTerminalEvent = false;
  let settleExit = () => {};
  const exited = new Promise<void>((done) => (settleExit = done));
  const publishLine = (line: string) => {
    if (!line.trim() || sawTerminalEvent) return;
    try {
      const event = decode(line);
      if (event.type === "result" || event.type === "error") sawTerminalEvent = true;
      queue.push(event);
    } catch {
      sawTerminalEvent = true;
      queue.push({
        type: "error",
        error: { kind: "protocol", message: "Bash.tv model helper emitted invalid JSON" },
      });
    }
  };
  child.stdout.on("data", (chunk) => {
    stdout += chunk.toString();
    const lines = stdout.split("\n");
    stdout = lines.pop() ?? "";
    for (const line of lines) publishLine(line);
  });
  child.stderr.on("data", (chunk) => {
    stderr = (stderr + chunk.toString()).slice(-(runtime.maxStderrBytes ?? 8_000));
  });
  child.once("error", (error) => {
    if (!sawTerminalEvent) {
      sawTerminalEvent = true;
      queue.push({ type: "error", error: { kind: "spawn", message: redact(error.message) } });
    }
  });
  child.once("spawn", () => {
    const command: CompleteCommand = { type: "complete", model, thinking, request };
    child.stdin.end(`${JSON.stringify(command)}\n`);
  });
  child.once("close", (code, exitSignal) => {
    settleExit();
    publishLine(stdout);
    if (!sawTerminalEvent) {
      queue.push({
        type: "error",
        error: {
          kind: "exit",
          message: redact(
            `Bash.tv model helper exited (${String(code)}/${String(exitSignal)})${stderr ? `: ${stderr}` : ""}`,
          ),
        },
      });
    }
    queue.end();
  });
  return {
    child,
    events: queue.iterable,
    exited,
    close: () => terminate(child.pid, exited, runtime.terminateGraceMs ?? 2_000),
  };
};

const complete = (runtime: RuntimeOptions, model: ModelId, thinking: Thinking, request: Request) =>
  Kyoot.gen(function* () {
    const invocation = yield* Resource.acquire(
      () => launch(runtime, model, thinking, request),
      (running) => running.close(),
    );
    const iterator = invocation.events[Symbol.asyncIterator]();
    while (true) {
      const next = yield* Async.fromPromise((signal) => {
        const abort = () => void iterator.return?.();
        signal.addEventListener("abort", abort, { once: true });
        return iterator.next().finally(() => signal.removeEventListener("abort", abort));
      });
      if (next.done)
        return yield* Fail.fail(
          new BashTvModelError("protocol", "Bash.tv model helper closed without a result"),
        );
      const event = next.value;
      if (event.type === "text") yield* Emit.value({ type: "text" as const, text: event.text });
      else if (event.type === "result") return event.completion;
      else
        return yield* Fail.fail(
          new BashTvModelError(event.error.kind, redact(event.error.message)),
        );
    }
  })
    .pipe(Fail.run, Resource.run)
    .map(Fail.fromResult);

export const make = (runtime: RuntimeOptions = {}) => ({
  model: (model: ModelId, options: ModelOptions = {}) =>
    Model.handle({
      onOp: (request, resume) =>
        complete(runtime, model, options.thinking ?? "off", request).map(resume),
    }),
});

export const BashTv = make();
