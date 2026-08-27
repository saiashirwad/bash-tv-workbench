export type Entity = { readonly id: string; readonly [key: string]: unknown };
export type Collections = Readonly<Record<string, ReadonlyArray<Entity>>>;
export type Change =
  | {
      readonly collection: string;
      readonly operation: "put";
      readonly key: string;
      readonly value: Entity;
    }
  | { readonly collection: string; readonly operation: "delete"; readonly key: string };
export interface Snapshot {
  readonly revision: number;
  readonly collections: Collections;
}
export interface Delta {
  readonly revision: number;
  readonly changes: ReadonlyArray<Change>;
}
export type CatchUp =
  | { readonly reset: false; readonly changes: ReadonlyArray<Delta> }
  | { readonly reset: true; readonly snapshot: Snapshot };
export interface Mutation {
  readonly id: string;
  readonly baseRevision: number;
  readonly type: string;
  readonly input: unknown;
}
export interface MutationAck {
  readonly id: string;
  readonly revision: number;
  readonly result: unknown;
}
export interface SyncClient {
  snapshot(after: number): Promise<CatchUp>;
  changes(after: number, signal: AbortSignal): AsyncIterable<Delta>;
  mutate(mutation: Mutation): Promise<MutationAck>;
}

export class RevisionGap extends Error {
  readonly _tag = "RevisionGap";
  readonly expected: number;
  readonly actual: number;
  constructor(expected: number, actual: number) {
    super(`expected revision ${expected}, received ${actual}`);
    this.expected = expected;
    this.actual = actual;
  }
}

export interface Collection<T extends Entity> {
  all(): ReadonlyArray<T>;
  get(id: string): T | undefined;
  subscribe(listener: (values: ReadonlyArray<T>) => void): () => void;
}
export type Optimistic =
  | ReadonlyArray<Change>
  | ((
      read: <A extends Entity>(collection: string, id: string) => A | undefined,
    ) => ReadonlyArray<Change>);
export interface Engine {
  readonly revision: number;
  readonly status: "idle" | "connecting" | "live" | "stopped";
  collection<T extends Entity>(name: string): Collection<T>;
  start(): Promise<void>;
  stop(): void;
  refresh(): Promise<void>;
  mutate(type: string, input: unknown, optimistic?: Optimistic): Promise<MutationAck>;
  subscribe(listener: () => void): () => void;
}
export interface Options {
  readonly reconnectMs?: number;
  readonly mutationId?: () => string;
}

const mutationId = () => globalThis.crypto?.randomUUID?.() ?? `${Date.now()}-${Math.random()}`;
export const make = (client: SyncClient, options: Options = {}): Engine => {
  const base = new Map<string, Map<string, Entity>>();
  const optimistic = new Map<string, Optimistic>();
  const listeners = new Set<() => void>();
  const collectionListeners = new Map<string, Set<(values: ReadonlyArray<any>) => void>>();
  let revision = 0;
  let status: Engine["status"] = "idle";
  let controller: AbortController | undefined;
  let running: Promise<void> | undefined;

  const projected = () => {
    const state = new Map([...base].map(([name, values]) => [name, new Map(values)]));
    const read = <A extends Entity>(collection: string, id: string) =>
      state.get(collection)?.get(id) as A | undefined;
    for (const projection of optimistic.values()) {
      const changes = typeof projection === "function" ? projection(read) : projection;
      applyChanges(changes, state);
    }
    return state;
  };
  const effective = (name: string) => [...(projected().get(name)?.values() ?? [])];
  const notify = (collections?: Set<string>) => {
    for (const listener of listeners) listener();
    for (const name of collections ?? collectionListeners.keys())
      for (const listener of collectionListeners.get(name) ?? []) listener(effective(name));
  };
  const applyChanges = (changes: ReadonlyArray<Change>, target = base) => {
    const touched = new Set<string>();
    for (const change of changes) {
      const collection = target.get(change.collection) ?? new Map<string, Entity>();
      target.set(change.collection, collection);
      if (change.operation === "put") collection.set(change.key, change.value);
      else collection.delete(change.key);
      touched.add(change.collection);
    }
    return touched;
  };
  const replace = (snapshot: Snapshot) => {
    base.clear();
    for (const [name, values] of Object.entries(snapshot.collections))
      base.set(name, new Map(values.map((value) => [value.id, value])));
    revision = snapshot.revision;
    notify();
  };
  const apply = (delta: Delta) => {
    if (delta.revision <= revision) return;
    if (delta.revision !== revision + 1) throw new RevisionGap(revision + 1, delta.revision);
    const touched = applyChanges(delta.changes);
    revision = delta.revision;
    notify(touched);
  };
  const catchUp = async () => {
    const result = await client.snapshot(revision);
    if (result.reset) replace(result.snapshot);
    else for (const delta of result.changes) apply(delta);
  };
  const loop = async (signal: AbortSignal) => {
    status = "connecting";
    notify();
    while (!signal.aborted) {
      try {
        await catchUp();
        status = "live";
        notify();
        for await (const delta of client.changes(revision, signal)) apply(delta);
      } catch (error) {
        if (signal.aborted) break;
        if (error instanceof RevisionGap) await catchUp();
        await new Promise((resolve) => setTimeout(resolve, options.reconnectMs ?? 250));
      }
    }
  };

  const engine: Engine = {
    get revision() {
      return revision;
    },
    get status() {
      return status;
    },
    collection<T extends Entity>(name: string): Collection<T> {
      return {
        all: () => effective(name) as unknown as ReadonlyArray<T>,
        get: (id) => effective(name).find((value) => value.id === id) as T | undefined,
        subscribe(listener) {
          const set = collectionListeners.get(name) ?? new Set();
          collectionListeners.set(name, set);
          set.add(listener);
          listener(effective(name) as unknown as ReadonlyArray<T>);
          return () => set.delete(listener);
        },
      };
    },
    async start() {
      if (running) return;
      controller = new AbortController();
      running = loop(controller.signal).finally(() => {
        status = "stopped";
        running = undefined;
        notify();
      });
      await new Promise<void>((resolve, reject) => {
        const check = () =>
          status === "live"
            ? (unsubscribe(), resolve())
            : status === "stopped"
              ? (unsubscribe(), reject(new Error("sync stopped")))
              : undefined;
        const unsubscribe = engine.subscribe(check);
        check();
      });
    },
    stop() {
      controller?.abort();
    },
    refresh: catchUp,
    async mutate(type, input, projection = []) {
      const id = (options.mutationId ?? mutationId)();
      const request = { id, baseRevision: revision, type, input };
      optimistic.set(id, projection);
      const collections =
        typeof projection === "function"
          ? undefined
          : new Set(projection.map((change) => change.collection));
      notify(collections);
      try {
        const ack = await client.mutate(request);
        optimistic.delete(id);
        await catchUp();
        notify(collections);
        return ack;
      } catch (error) {
        optimistic.delete(id);
        notify(collections);
        throw error;
      }
    },
    subscribe(listener) {
      listeners.add(listener);
      return () => listeners.delete(listener);
    },
  };
  return engine;
};

export interface AuthorityOptions {
  readonly initial?: Collections;
  readonly historyLimit?: number;
  readonly apply: (
    mutation: Mutation,
  ) => Promise<{ readonly changes: ReadonlyArray<Change>; readonly result?: unknown }>;
}
export interface Authority extends SyncClient {
  current(): Snapshot;
  commit(changes: ReadonlyArray<Change>): Delta;
}

export const authority = (options: AuthorityOptions): Authority => {
  const state = new Map<string, Map<string, Entity>>();
  for (const [name, values] of Object.entries(options.initial ?? {}))
    state.set(name, new Map(values.map((value) => [value.id, value])));
  const history: Delta[] = [];
  const mutations = new Map<string, MutationAck>();
  const subscribers = new Set<(delta: Delta) => void>();
  let revision = Object.keys(options.initial ?? {}).length > 0 ? 1 : 0;
  const current = (): Snapshot => ({
    revision,
    collections: Object.fromEntries(
      [...state].map(([name, values]) => [name, [...values.values()]]),
    ),
  });
  const commit = (changes: ReadonlyArray<Change>) => {
    revision++;
    for (const change of changes) {
      const collection = state.get(change.collection) ?? new Map<string, Entity>();
      state.set(change.collection, collection);
      if (change.operation === "put") collection.set(change.key, change.value);
      else collection.delete(change.key);
    }
    const delta = { revision, changes };
    history.push(delta);
    while (history.length > (options.historyLimit ?? 1_000)) history.shift();
    for (const subscriber of subscribers) subscriber(delta);
    return delta;
  };
  return {
    current,
    commit,
    async snapshot(after) {
      if (after === revision) return { reset: false, changes: [] };
      const first = history[0]?.revision ?? revision + 1;
      if (after + 1 < first || after > revision) return { reset: true, snapshot: current() };
      return { reset: false, changes: history.filter((delta) => delta.revision > after) };
    },
    changes(after, signal) {
      return {
        async *[Symbol.asyncIterator]() {
          const queued: Delta[] = history.filter((delta) => delta.revision > after);
          let wake = () => {};
          const subscriber = (delta: Delta) => {
            queued.push(delta);
            wake();
          };
          subscribers.add(subscriber);
          const abort = () => wake();
          signal.addEventListener("abort", abort, { once: true });
          try {
            while (!signal.aborted) {
              if (queued.length) yield queued.shift()!;
              else
                await new Promise<void>((resolve) => {
                  wake = resolve;
                });
            }
          } finally {
            subscribers.delete(subscriber);
            signal.removeEventListener("abort", abort);
          }
        },
      };
    },
    async mutate(mutation) {
      const previous = mutations.get(mutation.id);
      if (previous) return previous;
      const applied = await options.apply(mutation);
      const delta = commit(applied.changes);
      const ack = { id: mutation.id, revision: delta.revision, result: applied.result };
      mutations.set(mutation.id, ack);
      return ack;
    },
  };
};
