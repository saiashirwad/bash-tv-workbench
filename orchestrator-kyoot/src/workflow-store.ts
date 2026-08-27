import fs from "node:fs/promises";
import path from "node:path";
import type { WorkflowEvent, WorkflowRecord } from "./workflow.ts";

export interface EventQuery {
  readonly after?: number;
  readonly workflowId?: string;
  readonly taskId?: string;
  readonly limit?: number;
}
export interface EventPage {
  readonly cursor: number;
  readonly earliestCursor: number;
  readonly reset: boolean;
  readonly events: readonly WorkflowEvent[];
}
export interface WorkflowStore {
  list(): Promise<readonly WorkflowRecord[]>;
  get(id: string): Promise<WorkflowRecord | undefined>;
  put(workflow: WorkflowRecord): Promise<void>;
  append(event: Omit<WorkflowEvent, "cursor">): Promise<WorkflowEvent>;
  events(query?: EventQuery): Promise<EventPage>;
  subscribe(listener: (event: WorkflowEvent) => void): () => void;
  flush(): Promise<void>;
}
export interface StoreOptions {
  readonly eventLimit?: number;
}

const activeStatuses = new Set(["running", "cancelling"]);
const recover = (workflow: WorkflowRecord): WorkflowRecord => {
  if (!activeStatuses.has(workflow.status)) return workflow;
  const at = new Date().toISOString();
  const tasks = Object.fromEntries(Object.entries(workflow.tasks).map(([id, task]) => [id,
    task.status === "running" || task.status === "retrying"
      ? { ...task, status: "interrupted" as const, endedAt: at, error: "Kyoot workflow runtime restarted" }
      : task,
  ]));
  return { ...workflow, status: "interrupted", endedAt: at, tasks };
};
const atomicWrite = async (filename: string, value: unknown) => {
  const temporary = `${filename}.${process.pid}.${crypto.randomUUID()}.tmp`;
  await fs.mkdir(path.dirname(filename), { recursive: true, mode: 0o700 });
  await fs.writeFile(temporary, JSON.stringify(value, null, 2), { mode: 0o600 });
  await fs.rename(temporary, filename);
  await fs.chmod(filename, 0o600);
};

const makeStore = (
  workflows: Map<string, WorkflowRecord>,
  persisted: WorkflowEvent[],
  options: StoreOptions,
  persistWorkflow: (workflow: WorkflowRecord) => Promise<void>,
  persistEvent: (event: WorkflowEvent, events: readonly WorkflowEvent[]) => Promise<void>,
): WorkflowStore => {
  let journal = [...persisted];
  let cursor = journal.at(-1)?.cursor ?? 0;
  let write = Promise.resolve();
  const listeners = new Set<(event: WorkflowEvent) => void>();
  const serialize = (work: () => Promise<void>) => {
    const next = write.then(work);
    write = next.catch(() => {});
    return next;
  };
  return {
    list: async () => [...workflows.values()],
    get: async (id) => workflows.get(id),
    put: async (workflow) => {
      workflows.set(workflow.id, structuredClone(workflow));
      await serialize(() => persistWorkflow(workflow));
    },
    append: async (event) => {
      const stored = { ...event, cursor: ++cursor };
      journal.push(stored);
      while (journal.length > (options.eventLimit ?? 10_000)) journal.shift();
      await serialize(() => persistEvent(stored, journal));
      for (const listener of listeners) listener(stored);
      return stored;
    },
    events: async (query = {}) => {
      const after = query.after ?? 0;
      const earliestCursor = journal[0]?.cursor ?? cursor + 1;
      const reset = after > 0 && after + 1 < earliestCursor;
      const events = journal.filter((event) =>
        event.cursor > after &&
        (!query.workflowId || event.workflowId === query.workflowId) &&
        (!query.taskId || event.taskId === query.taskId),
      ).slice(0, query.limit ?? 1_000);
      return { cursor, earliestCursor, reset, events };
    },
    subscribe(listener) { listeners.add(listener); return () => listeners.delete(listener); },
    flush: async () => void (await write),
  };
};

export const memory = (initial: readonly WorkflowRecord[] = [], options: StoreOptions = {}) =>
  makeStore(new Map(initial.map((workflow) => [workflow.id, workflow])), [], options, async () => {}, async () => {});

export const directory = async (root: string, options: StoreOptions = {}): Promise<WorkflowStore> => {
  await fs.mkdir(path.join(root, "workflows"), { recursive: true, mode: 0o700 });
  const workflows = new Map<string, WorkflowRecord>();
  for (const entry of await fs.readdir(path.join(root, "workflows")).catch(() => [])) {
    if (!entry.endsWith(".json")) continue;
    try {
      const parsed = JSON.parse(await fs.readFile(path.join(root, "workflows", entry), "utf8")) as WorkflowRecord;
      const restored = recover(parsed);
      workflows.set(restored.id, restored);
      if (restored !== parsed) await atomicWrite(path.join(root, "workflows", entry), restored);
    } catch {}
  }
  const journalFile = path.join(root, "events.jsonl");
  const journal = (await fs.readFile(journalFile, "utf8").catch(() => ""))
    .split("\n").filter(Boolean).flatMap((line) => {
      try { return [JSON.parse(line) as WorkflowEvent]; } catch { return []; }
    }).slice(-(options.eventLimit ?? 10_000));
  return makeStore(
    workflows,
    journal,
    options,
    (workflow) => atomicWrite(path.join(root, "workflows", `${workflow.id}.json`), workflow),
    async (event, events) => {
      // Appends are serialized by makeStore. Periodic compaction bounds replay
      // storage without rewriting a growing journal for every model delta.
      if (event.cursor % 1_000 !== 0) {
        await fs.appendFile(journalFile, `${JSON.stringify(event)}\n`, { mode: 0o600 });
        return;
      }
      const temporary = `${journalFile}.${process.pid}.${crypto.randomUUID()}.tmp`;
      await fs.writeFile(temporary, `${events.map((item) => JSON.stringify(item)).join("\n")}\n`, { mode: 0o600 });
      await fs.rename(temporary, journalFile);
      await fs.chmod(journalFile, 0o600);
    },
  );
};
