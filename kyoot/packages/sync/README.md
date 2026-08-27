# @kyoot/sync

A deliberately small, server-authoritative sync engine for normalized browser state.

```ts
const engine = Sync.make(client);
await engine.start();

const runs = engine.collection<Run>("runs");
runs.subscribe(renderRuns);

await engine.mutate("runs/create", { project, prompt }, [
  { collection: "runs", operation: "put", key: temporary.id, value: temporary },
]);
```

The protocol uses monotonic revisions, snapshots, bounded delta replay, idempotent mutation IDs, optimistic overlays, and reset-on-gap recovery. It is not a CRDT: the server owns ordering and authoritative state.

Optimistic mutations may provide static changes or a functional projection. Functional projections are replayed in insertion order over the latest authoritative base plus earlier pending projections. This prevents overlapping mutations from capturing stale optimistic entities and keeps pending state correct across incoming deltas, acknowledgements, rollback, and reconnect snapshots. Query objects expose `set`/`restore` for optimistic mutation of on-demand resources that intentionally remain outside replicated collections.

`@kyoot/sync/rpc` exports a ready-made typed `SyncRpc` contract and adapters for `@kyoot/rpc`.

Use sync for compact replicated collections such as runs and projects. Keep large or request-specific resources—file contents, search results, Git history, and diffs—as on-demand typed RPC queries. `@kyoot/sync/query` provides a small deduplicating query cache with prefix invalidation, retryable stale entries, subscriptions, and cancellation on clear.
