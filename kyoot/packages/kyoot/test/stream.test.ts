import assert from "node:assert/strict";
import { test } from "node:test";
import { Clock, Emit, InterruptedError, Kyoot, runFiber } from "../src/index.ts";

test("Emit.fromIterable + map + run", () => {
  const r = Kyoot.runSync(
    Emit.fromIterable([1, 2, 3]).pipe(
      Emit.map((n: number) => n * 10),
      Emit.collect,
    ),
  );
  assert.deepEqual(r, [undefined, [10, 20, 30]]);
});

test("Emit.forEach with an effectful callback", () => {
  const seen: string[] = [];
  const r = Kyoot.runSync(
    Emit.fromIterable(["a", "b"]).pipe(
      Emit.forEach((s: string) => Clock.sleep(1).map(() => void seen.push(s))),
      Clock.virtual,
    ),
  );
  assert.deepEqual(seen, ["a", "b"]);
  assert.deepEqual(r, [undefined, 2]);
});

async function* source(n: number) {
  for (let i = 0; i < n; i++) yield i;
}

test("Emit.fromAsyncIterable → toAsyncIterable round trip", async () => {
  const out: number[] = [];
  for await (const x of Emit.toAsyncIterable(Emit.fromAsyncIterable(source(4)))) out.push(x);
  assert.deepEqual(out, [0, 1, 2, 3]);
});

test("fromAsyncIterable removes settled abort listeners", async () => {
  const count = 10;
  let next = 0;
  let returns = 0;
  let finish = (_r: IteratorResult<number>) => {};
  let waiting = () => {};
  const wait = new Promise<void>((resolve) => (waiting = resolve));
  const it: AsyncIterableIterator<number> = {
    [Symbol.asyncIterator]() {
      return this;
    },
    next() {
      if (next++ < count) return Promise.resolve({ value: next, done: false });
      waiting();
      return new Promise((resolve) => (finish = resolve));
    },
    return() {
      returns++;
      finish({ value: undefined, done: true });
      return Promise.resolve({ value: undefined, done: true });
    },
  };
  const fiber = runFiber(Emit.fromAsyncIterable(it).pipe(Emit.discard));
  await wait;
  fiber.interrupt();
  await assert.rejects(fiber.promise, (e) => e instanceof InterruptedError);
  assert.equal(returns, 1);
});

test("toAsyncIterable: breaking early interrupts the producer", async () => {
  let produced = 0;
  const stream = Emit.fromAsyncIterable(
    (async function* () {
      while (true) yield ++produced;
    })(),
  );
  for await (const x of Emit.toAsyncIterable(stream, { buffer: 1 })) if (x >= 3) break;
  const at = produced;
  await Promise.resolve();
  assert.ok(at <= 4, "at most the in-flight item after the break");
  assert.equal(produced, at, "and nothing after that");
});

test("toAsyncIterable: a defect in the producer rejects the consumer", async () => {
  const boom = new Error("boom");
  const stream = Emit.fromIterable([1]).map(() => {
    throw boom;
  });
  await assert.rejects(
    (async () => {
      for await (const _ of Emit.toAsyncIterable(stream)) void _;
    })(),
    (e) => e === boom,
  );
});

test("toAsyncIterable: the producer runs at most `buffer` items ahead", async () => {
  let produced = 0;
  const stream = Kyoot.gen(function* () {
    for (let i = 0; i < 50; i++) {
      produced++;
      yield* Emit.value(i);
    }
  });
  let consumed = 0;
  let maxAhead = 0;
  for await (const _ of Emit.toAsyncIterable(stream, { buffer: 3 })) {
    consumed++;
    maxAhead = Math.max(maxAhead, produced - consumed);
    await Promise.resolve();
  }
  assert.equal(consumed, 50);
  assert.equal(produced, 50);
  assert.ok(maxAhead <= 3, `producer ran ${maxAhead} ahead`);
});

test("toAsyncIterable: breaking while the producer is parked interrupts it", async () => {
  let produced = 0;
  const stream = Kyoot.gen(function* () {
    while (true) {
      produced++;
      yield* Emit.value(produced);
    }
  });
  for await (const x of Emit.toAsyncIterable(stream, { buffer: 2 })) if (x >= 5) break;
  const at = produced;
  assert.equal(produced, at);
  assert.ok(at <= 8);
});
