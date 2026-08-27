import assert from "node:assert/strict";
import { test } from "node:test";
import { z } from "zod";
import { Async, Emit, Fail, Kyoot, Resource } from "kyoot";
import { api, client, inMemory, mutation, provide, query, router, stream } from "@kyoot/rpc";
import { fetchTransport, httpApp } from "@kyoot/rpc/http";

const Api = api("test", {
  math: {
    double: query({ input: z.number(), output: z.number() }),
    reject: mutation({
      input: z.string(),
      output: z.never(),
      error: z.object({ _tag: z.literal("Rejected"), reason: z.string() }),
    }),
    count: stream({ input: z.number().int().min(0), output: z.number() }),
  },
});
const handlers = router(Api, {
  math: {
    double: (value) => Kyoot.succeed(value * 2),
    reject: (reason) => Fail.fail({ _tag: "Rejected" as const, reason }),
    count: (length) =>
      Kyoot.gen(function* () {
        for (let i = 0; i < length; i++) yield* Emit.value(i);
      }),
  },
});
const Client = client(Api);

test("one contract types and validates the in-memory client and server", async () => {
  const value = await Kyoot.runPromise(
    Client.math.double(21).pipe(provide(inMemory(handlers)), Fail.orThrow),
  );
  assert.equal(value, 42);
  const failed = await Kyoot.runPromise(
    Client.math.reject("no").pipe(provide(inMemory(handlers)), Fail.run),
  );
  assert.ok(!failed.ok && failed.cause._tag === "Fail" && failed.cause.error._tag === "Rejected");
});

test("streams preserve sequence and reach Emit consumers", async () => {
  const [, values] = await Kyoot.runPromise(
    Client.math.count(3).pipe(provide(inMemory(handlers)), Emit.collect, Fail.orThrow),
  );
  assert.deepEqual(values, [0, 1, 2]);
});

test("Web Request/Response and Fetch transport round trip without Node types", async () => {
  const app = httpApp(handlers);
  const transport = fetchTransport({
    url: "https://rpc.test/rpc",
    fetch: async (input, init) => app(new Request(input, init)),
  });
  const value = await Kyoot.runPromise(
    Client.math.double(4).pipe(provide(transport), Fail.orThrow),
  );
  const [, values] = await Kyoot.runPromise(
    Client.math.count(2).pipe(provide(transport), Emit.collect, Fail.orThrow),
  );
  assert.equal(value, 8);
  assert.deepEqual(values, [0, 1]);
});

test("aborting a server stream interrupts its handler fiber", async () => {
  let cleaned = false;
  const Streaming = api("streaming", {
    wait: stream({ input: z.object({}), output: z.number() }),
  });
  const server = router(Streaming, {
    wait: () =>
      Kyoot.gen(function* () {
        yield* Resource.acquire(
          () => undefined,
          () => {
            cleaned = true;
          },
        );
        yield* Async.never;
      }).pipe(Resource.run) as never,
  });
  const controller = new AbortController();
  const iterator = server
    .subscribe({ version: 1, id: "s1", procedure: "wait", input: {} }, controller.signal)
    [Symbol.asyncIterator]();
  const pending = iterator.next();
  setTimeout(() => controller.abort(), 5);
  const result = await pending;
  assert.equal(result.done, true);
  await new Promise((resolve) => setTimeout(resolve, 0));
  assert.equal(cleaned, true);
});

test("transport cancellation reaches a unary request", async () => {
  let aborted = false;
  const transport = {
    request: (_request: unknown, signal: AbortSignal) =>
      new Promise<never>(() =>
        signal.addEventListener(
          "abort",
          () => {
            aborted = true;
          },
          { once: true },
        ),
      ),
    subscribe: () => ({ async *[Symbol.asyncIterator]() {} }),
  };
  await Kyoot.runPromise(
    Kyoot.gen(function* () {
      const child = yield* Async.fork(Client.math.double(1).pipe(provide(transport)));
      yield* Async.fromPromise(() => new Promise((resolve) => setTimeout(resolve, 0)));
      yield* child.interrupt;
    }),
  );
  assert.equal(aborted, true);
});
