export type QueryKey = readonly string[];
export interface QueryState<A> {
  readonly status: "idle" | "loading" | "ready" | "error";
  readonly value?: A;
  readonly error?: unknown;
  readonly stale: boolean;
}
export interface Query<A> {
  get(): QueryState<A>;
  load(options?: { readonly force?: boolean }): Promise<A>;
  /** Replace cached data immediately. Used by optimistic mutation projections. */
  set(value: A, options?: { readonly stale?: boolean }): void;
  /** Restore an exact prior state when an optimistic mutation fails. */
  restore(state: QueryState<A>): void;
  invalidate(): void;
  subscribe(listener: (state: QueryState<A>) => void): () => void;
}
export interface QueryCache {
  query<A>(key: QueryKey, load: (signal: AbortSignal) => Promise<A>): Query<A>;
  invalidate(prefix: QueryKey): void;
  clear(): void;
}

type Entry = {
  state: QueryState<any>;
  readonly key: QueryKey;
  load: (signal: AbortSignal) => Promise<any>;
  promise?: Promise<any>;
  controller?: AbortController;
  readonly listeners: Set<(state: QueryState<any>) => void>;
};
const encoded = (key: QueryKey) => JSON.stringify(key);
const startsWith = (key: QueryKey, prefix: QueryKey) =>
  prefix.every((segment, index) => key[index] === segment);

export const queryCache = (): QueryCache => {
  const entries = new Map<string, Entry>();
  const notify = (entry: Entry) => {
    for (const listener of entry.listeners) listener(entry.state);
  };
  const invalidateEntry = (entry: Entry) => {
    entry.state = { ...entry.state, stale: true };
    notify(entry);
  };
  return {
    query<A>(key: QueryKey, load: (signal: AbortSignal) => Promise<A>): Query<A> {
      const id = encoded(key);
      const entry = entries.get(id) ?? {
        key: [...key],
        load,
        state: { status: "idle", stale: true },
        listeners: new Set(),
      };
      entry.load = load;
      entries.set(id, entry);
      return {
        get: () => entry.state,
        async load(options = {}) {
          if (!options.force && !entry.state.stale && entry.state.status === "ready")
            return entry.state.value as A;
          if (entry.promise) return entry.promise;
          entry.controller = new AbortController();
          entry.state = { ...entry.state, status: "loading" };
          notify(entry);
          entry.promise = entry
            .load(entry.controller.signal)
            .then(
              (value) => {
                entry.state = { status: "ready", value, stale: false };
                notify(entry);
                return value;
              },
              (error) => {
                entry.state = { ...entry.state, status: "error", error, stale: true };
                notify(entry);
                throw error;
              },
            )
            .finally(() => {
              entry.promise = undefined;
              entry.controller = undefined;
            });
          return entry.promise;
        },
        set(value, options = {}) {
          entry.state = { status: "ready", value, stale: options.stale ?? false };
          notify(entry);
        },
        restore(state) {
          entry.state = state;
          notify(entry);
        },
        invalidate: () => invalidateEntry(entry),
        subscribe(listener) {
          entry.listeners.add(listener);
          listener(entry.state);
          return () => entry.listeners.delete(listener);
        },
      };
    },
    invalidate(prefix) {
      for (const entry of entries.values())
        if (startsWith(entry.key, prefix)) invalidateEntry(entry);
    },
    clear() {
      for (const entry of entries.values()) entry.controller?.abort();
      entries.clear();
    },
  };
};
