import crypto from "node:crypto";
import { spawn, type ChildProcessWithoutNullStreams } from "node:child_process";
import readline from "node:readline";
import { Async, Deferred, Fail, Kyoot, Result, Sync } from "kyoot";
import type { Command, PiEvent, RpcResponse } from "./protocol.ts";
import {
  PiExited,
  PiProtocolError,
  PiTransportError,
  type OpenOptions,
  type PiError,
  type PiRow,
  type Service,
  type Session,
} from "./service.ts";

export interface NodeOptions {
  readonly cliPath: string;
  readonly providerExtension: string;
  readonly nodePath?: string;
  readonly environment: () => Readonly<Record<string, string>>;
  readonly terminateGraceMs?: number;
}

interface Subscriber {
  readonly values: PiEvent[];
  readonly waiters: Array<{
    readonly resolve: (result: IteratorResult<PiEvent>) => void;
    readonly reject: (error: unknown) => void;
  }>;
  closed: boolean;
}

class EventHub {
  readonly subscribers = new Set<Subscriber>();
  failure: unknown;
  closed = false;

  subscribe(): AsyncIterable<PiEvent> {
    const subscriber: Subscriber = { values: [], waiters: [], closed: false };
    this.subscribers.add(subscriber);
    return {
      [Symbol.asyncIterator]: () => ({
        next: () => {
          const value = subscriber.values.shift();
          if (value !== undefined) return Promise.resolve({ value, done: false });
          if (this.failure !== undefined) return Promise.reject(this.failure);
          if (this.closed || subscriber.closed)
            return Promise.resolve({ value: undefined, done: true });
          return new Promise((resolve, reject) => subscriber.waiters.push({ resolve, reject }));
        },
        return: async () => {
          subscriber.closed = true;
          this.subscribers.delete(subscriber);
          for (const waiter of subscriber.waiters.splice(0))
            waiter.resolve({ value: undefined, done: true });
          return { value: undefined, done: true };
        },
      }),
    };
  }

  publish(value: PiEvent) {
    if (this.closed) return;
    for (const subscriber of this.subscribers) {
      const waiter = subscriber.waiters.shift();
      if (waiter) waiter.resolve({ value, done: false });
      else subscriber.values.push(value);
    }
  }

  fail(error: unknown) {
    if (this.closed) return;
    this.failure = error;
    this.closed = true;
    for (const subscriber of this.subscribers)
      for (const waiter of subscriber.waiters.splice(0)) waiter.reject(error);
    this.subscribers.clear();
  }

  end() {
    if (this.closed) return;
    this.closed = true;
    for (const subscriber of this.subscribers)
      for (const waiter of subscriber.waiters.splice(0))
        waiter.resolve({ value: undefined, done: true });
    this.subscribers.clear();
  }
}

type Waiter = Deferred.Deferred<RpcResponse, PiError>;

interface LiveSession {
  readonly session: Session;
  readonly child: ChildProcessWithoutNullStreams;
  readonly events: EventHub;
  readonly pending: Map<string, Waiter>;
  readonly exited: Promise<void>;
  stderr: string;
  closed: boolean;
}

const runSync = <A>(program: import("kyoot").Kyoot<A, { sync: () => unknown }>) =>
  Kyoot.runSync(program.pipe(Sync.run));

const complete = (waiter: Waiter, response: RpcResponse) => runSync(waiter.succeed(response));

const fail = (waiter: Waiter, error: PiError) => runSync(waiter.fail(error));

const attempt = <A>(operation: string, work: (signal: AbortSignal) => Promise<A>) =>
  Async.fromPromise((signal) =>
    work(signal).then(
      (value) => Result.ok(value),
      (error: unknown) =>
        Result.fail(
          error instanceof PiExited ||
            error instanceof PiProtocolError ||
            error instanceof PiTransportError
            ? error
            : new PiTransportError(
                operation,
                error instanceof Error ? error.message : String(error),
              ),
        ),
    ),
  ).map(Fail.fromResult) as import("kyoot").Kyoot<A, PiRow>;

const writeLine = (child: ChildProcessWithoutNullStreams, value: unknown) =>
  new Promise<void>((resolve, reject) =>
    child.stdin.write(`${JSON.stringify(value)}\n`, (error) => (error ? reject(error) : resolve())),
  );

const processArgs = (config: NodeOptions, options: OpenOptions) => [
  config.cliPath,
  "--mode",
  "rpc",
  "--no-extensions",
  ...(options.extensions ?? []).flatMap((extension) => ["-e", extension]),
  "-e",
  config.providerExtension,
  "--provider",
  options.provider,
  "--model",
  options.model,
  "--thinking",
  options.thinking,
  "--session-dir",
  options.sessionDir,
  ...(options.continue ? ["--continue"] : []),
];

const spawnSession = (
  config: NodeOptions,
  options: OpenOptions,
  signal: AbortSignal,
): Promise<LiveSession> =>
  new Promise((resolve, reject) => {
    const child = spawn(config.nodePath ?? process.execPath, processArgs(config, options), {
      cwd: options.cwd,
      env: { ...config.environment() },
      stdio: ["pipe", "pipe", "pipe"],
      detached: true,
    });
    const hub = new EventHub();
    const pending = new Map<string, Waiter>();
    let settleExit = () => {};
    const exited = new Promise<void>((done) => (settleExit = done));
    const live: LiveSession = {
      session: { id: crypto.randomUUID(), pid: child.pid },
      child,
      events: hub,
      pending,
      exited,
      stderr: "",
      closed: false,
    };
    const lines = readline.createInterface({ input: child.stdout, crlfDelay: Infinity });
    lines.on("line", (line) => {
      let value: RpcResponse | PiEvent;
      try {
        value = JSON.parse(line) as RpcResponse | PiEvent;
      } catch {
        hub.publish({ type: "transport_warning", message: "Pi emitted malformed JSON", line });
        return;
      }
      if (value.type === "response" && typeof value.id === "string") {
        const waiter = pending.get(value.id);
        if (waiter) {
          pending.delete(value.id);
          complete(waiter, value as RpcResponse);
        }
      } else hub.publish(value as PiEvent);
    });
    child.stderr.on("data", (chunk) => {
      live.stderr = (live.stderr + chunk.toString()).slice(-64_000);
    });
    const abort = () => void terminate(live, config.terminateGraceMs ?? 5_000).catch(() => {});
    signal.addEventListener("abort", abort, { once: true });
    child.once("spawn", () => resolve(live));
    child.once("error", (error) => reject(error));
    child.once("close", (code, exitSignal) => {
      signal.removeEventListener("abort", abort);
      live.closed = true;
      const error = new PiExited(code, exitSignal, live.stderr);
      for (const waiter of pending.values()) fail(waiter, error);
      pending.clear();
      if (code === 0) hub.end();
      else hub.fail(error);
      settleExit();
    });
  });

const terminate = async (live: LiveSession, graceMs: number) => {
  if (live.closed || live.child.pid === undefined) return;
  try {
    process.kill(-live.child.pid, "SIGTERM");
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== "ESRCH") throw error;
  }
  const exited = await Promise.race([
    live.exited.then(() => true),
    new Promise<false>((resolve) => setTimeout(() => resolve(false), graceMs)),
  ]);
  if (exited) return;
  try {
    process.kill(-live.child.pid, "SIGKILL");
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== "ESRCH") throw error;
  }
  await live.exited;
};

/** Node handler for Pi's JSONL RPC mode. Authorization stays inside `environment()`. */
export const service = (config: NodeOptions): Service => {
  const sessions = new Map<string, LiveSession>();
  const lookup = (session: Session) => sessions.get(session.id);

  return {
    open: (options) =>
      attempt("open", async (signal) => {
        const live = await spawnSession(
          config,
          { ...options, extensions: options.extensions ?? [] },
          signal,
        );
        sessions.set(live.session.id, live);
        return live.session;
      }),

    request: <A>(session: Session, command: Command) => {
      const live = lookup(session);
      if (!live)
        return Fail.fail(new PiTransportError(command.type, "Unknown Pi session")) as never;
      return Kyoot.gen(function* () {
        const waiter = yield* Deferred.make<RpcResponse<A>, PiError>();
        const id = crypto.randomUUID();
        live.pending.set(id, waiter as Waiter);
        yield* attempt(command.type, async () => writeLine(live.child, { ...command, id }));
        const response = yield* waiter.await;
        if (!response.success)
          return yield* Fail.fail(new PiProtocolError(response.command, response.error));
        return response.data as A;
      }).pipe(Sync.run) as never;
    },

    events: (session) => {
      const live = lookup(session);
      return live
        ? (attempt("events", async () => live.events.subscribe()) as never)
        : (Fail.fail(new PiTransportError("events", "Unknown Pi session")) as never);
    },

    close: (session) => {
      const live = lookup(session);
      if (!live) return attempt("close", async () => undefined);
      sessions.delete(session.id);
      return attempt("close", async () => terminate(live, config.terminateGraceMs ?? 5_000));
    },
  };
};
