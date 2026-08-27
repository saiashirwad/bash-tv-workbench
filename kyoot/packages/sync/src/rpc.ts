import { z } from "zod";
import { api, mutation, provide, query, stream, type Client, type Transport } from "@kyoot/rpc";
import { Async, Emit, Kyoot } from "kyoot";
import type { Authority, CatchUp, Delta, Mutation, MutationAck, SyncClient } from "./index.ts";

const Entity = z.object({ id: z.string() }).catchall(z.unknown());
const Change = z.discriminatedUnion("operation", [
  z.object({ collection: z.string(), operation: z.literal("put"), key: z.string(), value: Entity }),
  z.object({ collection: z.string(), operation: z.literal("delete"), key: z.string() }),
]);
const Delta = z.object({ revision: z.number().int().nonnegative(), changes: z.array(Change) });
const Snapshot = z.object({
  revision: z.number().int().nonnegative(),
  collections: z.record(z.string(), z.array(Entity)),
});
const CatchUp = z.discriminatedUnion("reset", [
  z.object({ reset: z.literal(false), changes: z.array(Delta) }),
  z.object({ reset: z.literal(true), snapshot: Snapshot }),
]);
const Mutation = z.object({
  id: z.string(),
  baseRevision: z.number().int().nonnegative(),
  type: z.string(),
  input: z.unknown(),
});
const Ack = z.object({
  id: z.string(),
  revision: z.number().int().nonnegative(),
  result: z.unknown(),
});

export const SyncRpc = api("sync", {
  snapshot: query({ input: z.object({ after: z.number().int().nonnegative() }), output: CatchUp }),
  changes: stream({ input: z.object({ after: z.number().int().nonnegative() }), output: Delta }),
  mutate: mutation({ input: Mutation, output: Ack }),
});
export type SyncRpcClient = Client<typeof SyncRpc.shape>;

const changes = (authority: Authority, after: number) => {
  const controller = new AbortController();
  const inner = authority.changes(after, controller.signal);
  return {
    [Symbol.asyncIterator]() {
      const iterator = inner[Symbol.asyncIterator]();
      return {
        next: () => iterator.next(),
        async return() {
          controller.abort();
          return (await iterator.return?.()) ?? { value: undefined, done: true };
        },
      };
    },
  };
};

export const handlers = (authority: Authority): any => ({
  snapshot: ({ after }: { after: number }) => Async.fromPromise(() => authority.snapshot(after)),
  changes: ({ after }: { after: number }) => Emit.fromAsyncIterable(changes(authority, after)),
  mutate: (value: Mutation) => Async.fromPromise(() => authority.mutate(value)),
});

export const fromRpc = (rpc: SyncRpcClient, transport: Transport): SyncClient => ({
  snapshot: (after) =>
    Kyoot.runPromise(rpc.snapshot({ after }).pipe(provide(transport)) as never) as Promise<CatchUp>,
  changes: (after, signal) => {
    const iterable = Emit.toAsyncIterable(
      rpc.changes({ after }).pipe(provide(transport)) as never,
    ) as AsyncIterable<Delta>;
    return {
      [Symbol.asyncIterator]() {
        const iterator = iterable[Symbol.asyncIterator]();
        signal.addEventListener("abort", () => void iterator.return?.(), { once: true });
        return iterator;
      },
    };
  },
  mutate: (value) =>
    Kyoot.runPromise(rpc.mutate(value).pipe(provide(transport)) as never) as Promise<MutationAck>,
});
