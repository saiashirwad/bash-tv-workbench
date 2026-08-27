import crypto from "node:crypto";
import type { Run, RunEvent } from "./run.ts";
import type { RunStore } from "./store.ts";

export interface CreateRun {
  readonly id?: string;
  readonly title?: string;
  readonly prompt: string;
  readonly cwd: string;
  readonly creator?: unknown;
  readonly originChat?: unknown;
}
export interface RunExecution {
  readonly output?: string;
  readonly usage?: unknown;
  readonly changes?: readonly unknown[];
  readonly toolCount?: number;
  readonly compaction?: unknown;
}
export interface RunContext {
  readonly signal: AbortSignal;
  readonly emit: (event: Omit<RunEvent, "id" | "at">) => Promise<void>;
  readonly started: (pid?: number) => Promise<void>;
}
export interface RunExecutor {
  turn(
    run: Run,
    prompt: string,
    continuing: boolean,
    context: RunContext,
  ): Promise<RunExecution>;
  compact(run: Run, context: RunContext): Promise<RunExecution>;
}
export interface RunEngineOptions {
  readonly stateRoot: string;
  readonly maxConcurrency?: number;
  readonly coldStartSpacingMs?: number;
  readonly now?: () => Date;
  readonly id?: () => string;
}
export interface RunEngine {
  list(): Promise<readonly Run[]>;
  get(id: string): Promise<Run>;
  create(input: CreateRun): Promise<Run>;
  message(
    id: string,
    prompt: string,
    attribution?: Pick<CreateRun, "creator" | "originChat">,
  ): Promise<Run>;
  compact(id: string): Promise<Run>;
  stop(id: string): Promise<Run>;
  events(
    id: string,
    after?: number,
    limit?: number,
    before?: number | null,
  ): Promise<{
    events: readonly RunEvent[];
    nextCursor: number;
    previousCursor: number | null;
    more: boolean;
    moreBefore: boolean;
    reset: boolean;
    completed: boolean;
  }>;
  subscribe(listener: (run: Run) => void): () => void;
  shutdown(): Promise<void>;
}

const activeStatus = new Set([
  "queued",
  "starting",
  "running",
  "compacting",
  "stopping",
]);
const errorText = (error: unknown) =>
  error instanceof Error ? error.message : String(error);

export const makeRunEngine = async (
  store: RunStore,
  executor: RunExecutor,
  options: RunEngineOptions,
): Promise<RunEngine> => {
  const maxConcurrency = Math.max(1, options.maxConcurrency ?? 3);
  const spacing = Math.max(0, options.coldStartSpacingMs ?? 4_000);
  const now = () => (options.now?.() ?? new Date()).toISOString();
  const listeners = new Set<(run: Run) => void>();
  const controllers = new Map<string, AbortController>();
  const locks = new Map<string, Promise<unknown>>();
  let active = 0;
  let lastStart = 0;
  let stopped = false;
  let wake: ReturnType<typeof setTimeout> | undefined;

  const locked = <A>(id: string, work: () => Promise<A>): Promise<A> => {
    const previous = locks.get(id) ?? Promise.resolve();
    const next = previous.catch(() => {}).then(work);
    locks.set(id, next);
    const cleanup = () => {
      if (locks.get(id) === next) locks.delete(id);
    };
    void next.then(cleanup, cleanup);
    return next;
  };
  const publish = async (run: Run) => {
    const updated = await store.put({ ...run, updatedAt: now() });
    for (const listener of listeners) listener(structuredClone(updated));
    return updated;
  };
  const requireRun = async (id: string) => {
    const run = await store.get(id);
    if (!run) throw Object.assign(new Error("Unknown run"), { status: 404 });
    return run;
  };
  const schedule = (delay = 0) => {
    if (stopped || wake) return;
    wake = setTimeout(() => {
      wake = undefined;
      void pump();
    }, delay);
    wake.unref?.();
  };
  const execute = async (id: string) => {
    active++;
    const controller = new AbortController();
    controllers.set(id, controller);
    try {
      let run = await locked(id, async () => {
        const current = await requireRun(id);
        if (current.status !== "queued") return current;
        return publish({
          ...current,
          status: "starting",
          startedAt: current.startedAt ?? now(),
          endedAt: null,
          error: null,
          exitCode: null,
        });
      });
      if (run.status !== "starting") return;
      const emit = async (event: Omit<RunEvent, "id" | "at">) => {
        await locked(id, async () => {
          const current = await requireRun(id);
          const nextEvent: RunEvent = {
            id: crypto.randomUUID(),
            sequence: (current.events.at(-1)?.sequence ?? 0) + 1,
            at: now(),
            ...event,
          } as RunEvent;
          const persisted =
            (await store.appendEvent?.(id, nextEvent)) ?? nextEvent;
          await publish({
            ...current,
            events: [...current.events, persisted].slice(-500),
            artifactReferences: [
              ...(current.artifactReferences ?? []),
              ...((persisted.artifactReferences as Run["artifactReferences"]) ??
                []),
            ].slice(-256),
          });
        });
      };
      const started = async (pid?: number) => {
        await locked(id, async () => {
          const current = await requireRun(id);
          if (current.status !== "starting") return;
          await publish({
            ...current,
            status: current.operation === "compact" ? "compacting" : "running",
            pid: pid ?? null,
          });
        });
      };
      const prompt = run.pendingPrompt ?? run.prompt;
      const result =
        run.operation === "compact"
          ? await executor.compact(run, {
              signal: controller.signal,
              emit,
              started,
            })
          : await executor.turn(run, prompt, run.turnCount > 1, {
              signal: controller.signal,
              emit,
              started,
            });
      await locked(id, async () => {
        const current = await requireRun(id);
        if (current.status === "stopping") return;
        await publish({
          ...current,
          status: "completed",
          pid: null,
          endedAt: now(),
          exitCode: 0,
          error: null,
          output: (result.output ?? current.output).slice(-100_000),
          usage: result.usage ?? current.usage,
          changes: result.changes ?? current.changes,
          toolCount: result.toolCount ?? current.toolCount,
          pendingPrompt: null,
        });
      });
    } catch (error) {
      await locked(id, async () => {
        const current = await requireRun(id);
        const cancelled =
          controller.signal.aborted || current.status === "stopping";
        await publish({
          ...current,
          status: cancelled ? "stopped" : "failed",
          pid: null,
          endedAt: now(),
          exitCode: cancelled ? null : 1,
          error: cancelled ? null : errorText(error),
          pendingPrompt: null,
        });
      }).catch(() => {});
    } finally {
      controllers.delete(id);
      active--;
      schedule();
    }
  };
  const pump = async () => {
    if (stopped || active >= maxConcurrency) return;
    const queued = (await store.list())
      .filter((run) => run.status === "queued")
      .sort((a, b) => a.createdAt.localeCompare(b.createdAt));
    while (queued.length && active < maxConcurrency) {
      const wait = Math.max(0, lastStart + spacing - Date.now());
      if (wait > 0) {
        schedule(wait);
        return;
      }
      const run = queued.shift()!;
      lastStart = Date.now();
      void execute(run.id);
    }
  };
  const enqueueExisting = async (id: string, patch: Partial<Run>) =>
    locked(id, async () => {
      const current = await requireRun(id);
      if (activeStatus.has(current.status))
        throw Object.assign(new Error("Run already has an active operation"), {
          status: 409,
        });
      const next = await publish({
        ...current,
        ...patch,
        status: "queued",
        endedAt: null,
        pid: null,
        error: null,
      });
      schedule();
      return next;
    });

  const engine: RunEngine = {
    list: async () =>
      [...(await store.list())].sort((a, b) =>
        b.createdAt.localeCompare(a.createdAt),
      ),
    get: requireRun,
    create: async (input) => {
      const prompt = input.prompt.trim();
      if (!prompt || prompt.length > 20_000)
        throw Object.assign(new Error("Prompt must be 1–20,000 characters"), {
          status: 400,
        });
      const id = input.id ?? options.id?.() ?? crypto.randomUUID();
      if (await store.get(id))
        throw Object.assign(new Error("Run id already exists"), {
          status: 409,
        });
      const createdAt = now();
      const run: Run = {
        version: 1,
        id,
        title: (input.title || prompt.split("\n")[0] || "Agent").slice(0, 100),
        prompt,
        cwd: input.cwd,
        sessionDir: `${options.stateRoot}/${id}/session`,
        createdAt,
        updatedAt: createdAt,
        startedAt: null,
        endedAt: null,
        status: "queued",
        pid: null,
        exitCode: null,
        error: null,
        events: [],
        output: "",
        turnCount: 1,
        creator: input.creator ?? null,
        originChat: input.originChat ?? null,
        usage: null,
        changes: [],
        toolCount: 0,
        operation: "turn",
        pendingPrompt: prompt,
      };
      await publish(run);
      schedule();
      return run;
    },
    message: async (id, prompt, attribution = {}) => {
      const message = prompt.trim();
      if (!message || message.length > 20_000)
        throw Object.assign(new Error("Prompt must be 1–20,000 characters"), {
          status: 400,
        });
      const current = await requireRun(id);
      const event = {
        id: crypto.randomUUID(),
        sequence: (current.events.at(-1)?.sequence ?? 0) + 1,
        at: now(),
        type: "user",
        text: message,
        creator: attribution.creator ?? current.creator,
        originChat: attribution.originChat ?? current.originChat,
      };
      const persisted: RunEvent =
        (await store.appendEvent?.(id, event)) ?? event;
      return enqueueExisting(id, {
        operation: "turn",
        pendingPrompt: message,
        turnCount: current.turnCount + 1,
        events: [...current.events, persisted].slice(-500),
        artifactReferences: [
          ...(current.artifactReferences ?? []),
          ...((persisted.artifactReferences as Run["artifactReferences"]) ??
            []),
        ].slice(-256),
      });
    },
    compact: (id) =>
      enqueueExisting(id, { operation: "compact", pendingPrompt: null }),
    stop: (id) =>
      locked(id, async () => {
        const current = await requireRun(id);
        if (!activeStatus.has(current.status)) return current;
        if (current.status === "queued")
          return publish({
            ...current,
            status: "stopped",
            endedAt: now(),
            pendingPrompt: null,
          });
        const next = await publish({ ...current, status: "stopping" });
        controllers.get(id)?.abort();
        return next;
      }),
    events: async (id, after = 0, limit = 100, before = null) => {
      const run = await requireRun(id);
      const page = store.readEventPage
        ? await store.readEventPage(id, {
            after,
            before,
            limit: Math.max(1, Math.min(1000, limit)),
          })
        : store.readEvents && before == null
          ? {
              ...(await store.readEvents(
                id,
                after,
                Math.max(1, Math.min(1000, limit)),
              )),
              previousCursor: null,
              moreBefore: false,
            }
          : {
              events:
                before == null
                  ? run.events
                      .filter((event) => (event.sequence ?? 0) > after)
                      .slice(0, limit)
                  : run.events
                      .filter((event) => (event.sequence ?? 0) < before)
                      .slice(-limit),
              nextCursor: run.events.at(-1)?.sequence ?? after,
              previousCursor: run.events.at(0)?.sequence ?? null,
              more: before == null && run.events.length > limit,
              moreBefore: before != null && run.events.length > limit,
              reset: false,
            };
      return { ...page, completed: !activeStatus.has(run.status) };
    },
    subscribe: (listener) => {
      listeners.add(listener);
      return () => listeners.delete(listener);
    },
    shutdown: async () => {
      stopped = true;
      if (wake) clearTimeout(wake);
      for (const controller of controllers.values()) controller.abort();
      while (active > 0)
        await new Promise((resolve) => setTimeout(resolve, 20));
      await store.flush();
    },
  };
  schedule();
  return engine;
};
