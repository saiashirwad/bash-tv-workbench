import crypto from "node:crypto";
import fs from "node:fs/promises";
import path from "node:path";
import type { Run, RunArtifactReference, RunEvent } from "./run.ts";
import { recover } from "./run.ts";

/** Values larger than this are never embedded in a summary or event journal. */
export const RUN_INLINE_BYTES = 16 * 1024;
export const RUN_OUTPUT_PREVIEW_BYTES = 2 * 1024;

export interface RunArtifactRetention {
  readonly maxArtifactsPerRun?: number;
  readonly maxBytesPerRun?: number;
  readonly maxArtifactBytes?: number;
  readonly maxAgeMs?: number;
}
export interface StoredRunArtifact extends RunArtifactReference {
  readonly runId: string;
  readonly kind: "event-payload" | "final-output";
  readonly createdAt: string;
  readonly expiresAt: string;
}
export interface RunStore {
  list(): Promise<readonly Run[]>;
  get(id: string): Promise<Run | undefined>;
  put(run: Run): Promise<Run>;
  appendEvent?(runId: string, event: RunEvent): Promise<RunEvent>;
  readEvents?(runId: string, after: number, limit: number): Promise<{
    events: readonly RunEvent[];
    nextCursor: number;
    more: boolean;
    reset: boolean;
  }>;
  readArtifact?(runId: string, id: string): Promise<{ metadata: StoredRunArtifact; data: Buffer }>;
  cleanupArtifacts?(runId?: string): Promise<number>;
  flush(): Promise<void>;
}

const atomicWrite = async (filename: string, value: unknown) => {
  const temporary = `${filename}.${process.pid}.${crypto.randomUUID()}.tmp`;
  await fs.mkdir(path.dirname(filename), { recursive: true, mode: 0o700 });
  await fs.writeFile(temporary, JSON.stringify(value, null, 2), { mode: 0o600 });
  await fs.rename(temporary, filename);
  await fs.chmod(filename, 0o600);
};
const bytes = (value: unknown) => Buffer.byteLength(JSON.stringify(value) ?? "null");
const compactEvent = (event: RunEvent, reference: RunArtifactReference): RunEvent => {
  const compact: Record<string, unknown> = {
    id: event.id,
    sequence: event.sequence,
    at: event.at,
    type: event.type,
  };
  for (const key of ["name", "callId", "isError"])
    if (key in event && bytes(event[key]) <= 1024) compact[key] = event[key];
  return { ...compact, payloadArtifact: reference, artifactReferences: [reference] } as unknown as RunEvent;
};
const references = (run: Run, additions: readonly RunArtifactReference[]) => {
  const merged = new Map((run.artifactReferences ?? []).map((item) => [item.id, item]));
  for (const item of additions) merged.set(item.id, item);
  return [...merged.values()].slice(-256);
};

export const memory = (initial: readonly Run[] = []): RunStore => {
  const runs = new Map(initial.map((run) => [run.id, structuredClone(run)]));
  const artifacts = new Map<string, { metadata: StoredRunArtifact; data: Buffer }>();
  const save = (runId: string, kind: StoredRunArtifact["kind"], contentType: string, input: Buffer) => {
    const id = crypto.randomUUID();
    const data = Buffer.from(input);
    const createdAt = new Date().toISOString();
    const metadata: StoredRunArtifact = {
      id, runId, kind, contentType, size: data.length,
      sha256: crypto.createHash("sha256").update(data).digest("hex"),
      createdAt, expiresAt: new Date(Date.now() + 7 * 24 * 60 * 60 * 1000).toISOString(),
    };
    artifacts.set(`${runId}:${id}`, { metadata, data });
    return metadata;
  };
  return {
    list: async () => [...runs.values()].map((run) => structuredClone(run)),
    get: async (id) => structuredClone(runs.get(id)),
    put: async (input) => {
      let run = structuredClone(input);
      if (Buffer.byteLength(run.output) > RUN_INLINE_BYTES) {
        const ref = save(run.id, "final-output", "text/plain; charset=utf-8", Buffer.from(run.output));
        run = { ...run, output: Buffer.from(run.output).subarray(-RUN_OUTPUT_PREVIEW_BYTES).toString(), outputArtifact: ref, artifactReferences: references(run, [ref]) };
      }
      runs.set(run.id, run);
      return structuredClone(run);
    },
    appendEvent: async (runId, input) => {
      let event = structuredClone(input);
      if (bytes(event) > RUN_INLINE_BYTES) {
        const ref = save(runId, "event-payload", "application/json", Buffer.from(JSON.stringify(event)));
        event = compactEvent(event, ref);
      }
      return event;
    },
    readEvents: async (runId, after, limit) => {
      const events = (runs.get(runId)?.events ?? []).filter((event) => (event.sequence ?? 0) > after);
      const page = events.slice(0, limit);
      return { events: page, nextCursor: page.at(-1)?.sequence ?? after, more: events.length > limit, reset: false };
    },
    readArtifact: async (runId, id) => {
      const value = artifacts.get(`${runId}:${id}`);
      if (!value) throw Object.assign(new Error("Run artifact not found"), { status: 404 });
      return { metadata: value.metadata, data: Buffer.from(value.data) };
    },
    cleanupArtifacts: async () => 0,
    flush: async () => {},
  };
};

export const directory = async (root: string, retention: RunArtifactRetention = {}): Promise<RunStore> => {
  await fs.mkdir(root, { recursive: true, mode: 0o700 });
  const runs = new Map<string, Run>();
  const writes = new Map<string, Promise<void>>();
  const limits = {
    count: Math.max(1, retention.maxArtifactsPerRun ?? 128),
    total: Math.max(1, retention.maxBytesPerRun ?? 32 * 1024 * 1024),
    artifact: Math.max(1, retention.maxArtifactBytes ?? 8 * 1024 * 1024),
    age: Math.max(1, retention.maxAgeMs ?? 7 * 24 * 60 * 60 * 1000),
  };
  const artifactDir = (runId: string) => path.join(root, runId, "artifacts-v1");
  const removeArtifact = async (runId: string, id: string) => {
    await Promise.all([
      fs.rm(path.join(artifactDir(runId), `${id}.data`), { force: true }),
      fs.rm(path.join(artifactDir(runId), `${id}.json`), { force: true }),
    ]);
  };
  const artifactMetadata = async (runId: string) => {
    const result: StoredRunArtifact[] = [];
    for (const entry of await fs.readdir(artifactDir(runId)).catch(() => [])) {
      if (!entry.endsWith(".json")) continue;
      try {
        const value = JSON.parse(await fs.readFile(path.join(artifactDir(runId), entry), "utf8")) as StoredRunArtifact;
        if (value.runId === runId && value.id === entry.slice(0, -5)) result.push(value);
      } catch {}
    }
    return result;
  };
  const cleanupOne = async (runId: string) => {
    const all = (await artifactMetadata(runId)).sort((a, b) => b.createdAt.localeCompare(a.createdAt));
    let keptBytes = 0, kept = 0, removed = 0;
    for (const item of all) {
      const expired = Date.parse(item.expiresAt) <= Date.now();
      if (expired || kept >= limits.count || keptBytes + item.size > limits.total) {
        await removeArtifact(runId, item.id); removed++;
      } else { kept++; keptBytes += item.size; }
    }
    return removed;
  };
  const saveArtifact = async (runId: string, kind: StoredRunArtifact["kind"], contentType: string, input: Buffer) => {
    const originalSize = input.length;
    const data = input.subarray(0, Math.min(limits.artifact, limits.total));
    const id = crypto.randomUUID();
    const createdAt = new Date().toISOString();
    const metadata: StoredRunArtifact = {
      id, runId, kind, contentType, size: data.length, originalSize,
      truncated: data.length !== originalSize,
      sha256: crypto.createHash("sha256").update(data).digest("hex"),
      createdAt, expiresAt: new Date(Date.now() + limits.age).toISOString(),
    };
    const dir = artifactDir(runId);
    await fs.mkdir(dir, { recursive: true, mode: 0o700 });
    const temporary = path.join(dir, `${id}.${process.pid}.tmp`);
    await fs.writeFile(temporary, data, { mode: 0o600 });
    await fs.rename(temporary, path.join(dir, `${id}.data`));
    await atomicWrite(path.join(dir, `${id}.json`), metadata);
    await cleanupOne(runId);
    return metadata;
  };

  for (const entry of await fs.readdir(root).catch(() => [])) {
    try {
      const filename = path.join(root, entry, "run.json");
      const parsed = JSON.parse(await fs.readFile(filename, "utf8")) as Partial<Run>;
      if (!parsed.id || !parsed.cwd || !parsed.prompt || !parsed.createdAt) continue;
      const eventFile = path.join(root, entry, "events.jsonl");
      let events = parsed.events ?? [];
      try { events = (await fs.readFile(eventFile, "utf8")).split("\n").filter(Boolean).map((line) => JSON.parse(line)); } catch {}
      events = events.map((event, index) => ({ ...event, sequence: event.sequence ?? index + 1 }));
      const normalized: Run = {
        version: parsed.version === 3 ? 3 : parsed.version === 2 ? 2 : 1,
        id: parsed.id, title: parsed.title || parsed.prompt.split("\n")[0] || "Agent", prompt: parsed.prompt,
        cwd: parsed.cwd, sessionDir: parsed.sessionDir || path.join(root, parsed.id, "session"),
        createdAt: parsed.createdAt, updatedAt: parsed.updatedAt || parsed.endedAt || parsed.startedAt || parsed.createdAt,
        startedAt: parsed.startedAt ?? null, endedAt: parsed.endedAt ?? null, status: parsed.status ?? "interrupted",
        pid: parsed.pid ?? null, exitCode: parsed.exitCode ?? null, error: parsed.error ?? null, events,
        output: parsed.output ?? "", outputArtifact: parsed.outputArtifact, artifactReferences: parsed.artifactReferences ?? [],
        turnCount: parsed.turnCount ?? 1, creator: parsed.creator ?? null, originChat: parsed.originChat ?? null,
        usage: parsed.usage ?? null, changes: parsed.changes ?? [], toolCount: parsed.toolCount ?? 0,
        operation: parsed.operation ?? "turn", pendingPrompt: parsed.pendingPrompt ?? null,
      };
      const restored = recover(normalized);
      runs.set(restored.id, restored);
      if (parsed.events?.length && !(await fs.stat(eventFile).catch(() => null)))
        await fs.writeFile(eventFile, events.map((event) => JSON.stringify(event)).join("\n") + "\n", { mode: 0o600 });
      if (JSON.stringify(restored) !== JSON.stringify(parsed))
        await atomicWrite(filename, { ...restored, version: 3, events: undefined });
      await cleanupOne(parsed.id);
    } catch {}
  }

  const put = async (input: Run) => {
    let run = structuredClone(input);
    if (Buffer.byteLength(run.output) > RUN_INLINE_BYTES) {
      const ref = await saveArtifact(run.id, "final-output", "text/plain; charset=utf-8", Buffer.from(run.output));
      run = { ...run, output: Buffer.from(run.output).subarray(-RUN_OUTPUT_PREVIEW_BYTES).toString(), outputArtifact: ref, artifactReferences: references(run, [ref]) };
    }
    runs.set(run.id, structuredClone(run));
    const filename = path.join(root, run.id, "run.json");
    const previous = writes.get(run.id) ?? Promise.resolve();
    const summary = { ...run, version: 3, events: undefined };
    const next = previous.then(() => atomicWrite(filename, summary));
    writes.set(run.id, next);
    try { await next; } finally { if (writes.get(run.id) === next) writes.delete(run.id); }
    return structuredClone(run);
  };

  return {
    list: async () => [...runs.values()].map((run) => structuredClone(run)),
    get: async (id) => structuredClone(runs.get(id)),
    put,
    appendEvent: async (runId, input) => {
      let event = structuredClone(input);
      if (bytes(event) > RUN_INLINE_BYTES) {
        const ref = await saveArtifact(runId, "event-payload", "application/json", Buffer.from(JSON.stringify(event)));
        event = compactEvent(event, ref);
      }
      const filename = path.join(root, runId, "events.jsonl");
      await fs.mkdir(path.dirname(filename), { recursive: true, mode: 0o700 });
      const key = `${runId}:events`, previous = writes.get(key) ?? Promise.resolve();
      const next = previous.then(() => fs.appendFile(filename, JSON.stringify(event) + "\n", { mode: 0o600 }));
      writes.set(key, next);
      try { await next; } finally { if (writes.get(key) === next) writes.delete(key); }
      return event;
    },
    readEvents: async (runId, after, limit) => {
      const all = runs.get(runId)?.events ?? [], earliest = all[0]?.sequence ?? after + 1;
      const events = all.filter((event) => (event.sequence ?? 0) > after), page = events.slice(0, limit);
      return { events: page, nextCursor: page.at(-1)?.sequence ?? after, more: events.length > limit, reset: after > 0 && after < earliest - 1 };
    },
    readArtifact: async (runId, id) => {
      if (!/^[0-9a-f-]{36}$/.test(id)) throw Object.assign(new Error("Run artifact not found"), { status: 404 });
      try {
        const metadata = JSON.parse(await fs.readFile(path.join(artifactDir(runId), `${id}.json`), "utf8")) as StoredRunArtifact;
        if (metadata.runId !== runId || Date.parse(metadata.expiresAt) <= Date.now()) {
          await removeArtifact(runId, id); throw Object.assign(new Error("Run artifact not found"), { status: 404 });
        }
        const data = await fs.readFile(path.join(artifactDir(runId), `${id}.data`));
        const checksum = crypto.createHash("sha256").update(data).digest("hex");
        if (data.length !== metadata.size || checksum !== metadata.sha256) throw new Error("Run artifact checksum mismatch");
        return { metadata, data };
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code === "ENOENT")
          throw Object.assign(new Error("Run artifact not found"), { status: 404 });
        throw error;
      }
    },
    cleanupArtifacts: async (runId) => runId ? cleanupOne(runId) : (await Promise.all([...runs.keys()].map(cleanupOne))).reduce((a, b) => a + b, 0),
    flush: async () => void (await Promise.all(writes.values())),
  };
};
