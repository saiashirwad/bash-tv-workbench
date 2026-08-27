import assert from "node:assert/strict";
import { test } from "node:test";
import { Async, Clock, Deferred, Fail, Kyoot, Queue, Sync } from "../src/index.ts";

test("Deferred completes once and shares its result with every waiter", async () => {
  const program = Kyoot.gen(function* () {
    const deferred = yield* Deferred.make<number>();
    const first = yield* Async.fork(deferred.await);
    const second = yield* Async.fork(deferred.await);
    const won = yield* deferred.succeed(42);
    const lost = yield* deferred.succeed(99);
    return [won, lost, yield* first.join, yield* second.join] as const;
  }).pipe(Sync.run);
  assert.deepEqual(await Kyoot.runPromise(program), [true, false, 42, 42]);
});

test("Deferred typed failure crosses await", async () => {
  const program = Kyoot.gen(function* () {
    const deferred = yield* Deferred.make<number, "nope">();
    yield* deferred.fail("nope");
    return yield* deferred.await;
  }).pipe(Sync.run, Fail.run);
  const result = await Kyoot.runPromise(program);
  assert.ok(!result.ok && result.cause._tag === "Fail" && result.cause.error === "nope");
});

test("interrupting one Deferred waiter leaves it available to others", async () => {
  const program = Kyoot.gen(function* () {
    const deferred = yield* Deferred.make<number>();
    const cancelled = yield* Async.fork(deferred.await);
    yield* cancelled.interrupt;
    const interrupted = yield* cancelled.await;
    const waiting = yield* Async.fork(deferred.await);
    yield* deferred.succeed(7);
    return [interrupted, yield* waiting.join] as const;
  }).pipe(Sync.run);
  const [interrupted, value] = await Kyoot.runPromise(program.pipe(Fail.orThrow));
  assert.ok(!interrupted.ok && interrupted.cause._tag === "Interrupted");
  assert.equal(value, 7);
});

test("bounded Queue is FIFO and applies producer backpressure", async () => {
  const events: string[] = [];
  const program = Kyoot.gen(function* () {
    const queue = yield* Queue.bounded<number>(1);
    yield* queue.offer(1);
    const producer = yield* Async.fork(queue.offer(2).map(() => void events.push("offered 2")));
    yield* Clock.sleep(1);
    assert.deepEqual(events, []);
    const first = yield* queue.take;
    yield* producer.join;
    const second = yield* queue.take;
    return [first, second] as const;
  }).pipe(Sync.run);
  const values = await Kyoot.runPromise(program.pipe(Fail.orThrow));
  assert.deepEqual(values, [1, 2]);
  assert.deepEqual(events, ["offered 2"]);
});

test("rendezvous Queue pairs producers and consumers without buffering", async () => {
  const program = Kyoot.gen(function* () {
    const queue = yield* Queue.bounded<string>(0);
    const producer = yield* Async.fork(queue.offer("hello"));
    yield* Clock.sleep(1);
    const size = yield* queue.size;
    const value = yield* queue.take;
    yield* producer.join;
    return [size, value] as const;
  }).pipe(Sync.run);
  assert.deepEqual(await Kyoot.runPromise(program.pipe(Fail.orThrow)), [0, "hello"]);
});

test("Queue can carry undefined values", async () => {
  const program = Kyoot.gen(function* () {
    const queue = yield* Queue.bounded<undefined>(1);
    yield* queue.offer(undefined);
    return yield* queue.take;
  }).pipe(Sync.run);
  assert.equal(await Kyoot.runPromise(program.pipe(Fail.orThrow)), undefined);
});

test("interrupting a blocked Queue offer removes it", async () => {
  const program = Kyoot.gen(function* () {
    const queue = yield* Queue.bounded<number>(1);
    yield* queue.offer(1);
    const blocked = yield* Async.fork(queue.offer(2));
    yield* Clock.sleep(1);
    yield* blocked.interrupt;
    const interrupted = yield* blocked.await;
    const first = yield* queue.take;
    const empty = yield* queue.tryTake;
    return [interrupted, first, empty] as const;
  }).pipe(Sync.run);
  const [interrupted, first, empty] = await Kyoot.runPromise(program.pipe(Fail.orThrow));
  assert.ok(!interrupted.ok && interrupted.cause._tag === "Interrupted");
  assert.equal(first, 1);
  assert.equal(empty, undefined);
});

test("interrupting a blocked Queue take removes it", async () => {
  const program = Kyoot.gen(function* () {
    const queue = yield* Queue.unbounded<number>();
    const blocked = yield* Async.fork(queue.take);
    yield* Clock.sleep(1);
    yield* blocked.interrupt;
    const interrupted = yield* blocked.await;
    yield* queue.offer(3);
    return [interrupted, yield* queue.take] as const;
  }).pipe(Sync.run);
  const [interrupted, value] = await Kyoot.runPromise(program.pipe(Fail.orThrow));
  assert.ok(!interrupted.ok && interrupted.cause._tag === "Interrupted");
  assert.equal(value, 3);
});

test("Queue shutdown wakes blocked takers and offerers", async () => {
  const takerProgram = Kyoot.gen(function* () {
    const queue = yield* Queue.unbounded<number>();
    const taker = yield* Async.fork(queue.take);
    yield* queue.shutdown;
    return yield* taker.await;
  }).pipe(Sync.run);
  const taker = await Kyoot.runPromise(takerProgram);
  assert.ok(
    !taker.ok && taker.cause._tag === "Fail" && taker.cause.error instanceof Queue.QueueShutdown,
  );

  const offererProgram = Kyoot.gen(function* () {
    const queue = yield* Queue.bounded<number>(0);
    const offerer = yield* Async.fork(queue.offer(1));
    yield* Clock.sleep(1);
    yield* queue.shutdown;
    return yield* offerer.await;
  }).pipe(Sync.run);
  const offerer = await Kyoot.runPromise(offererProgram);
  assert.ok(
    !offerer.ok &&
      offerer.cause._tag === "Fail" &&
      offerer.cause.error instanceof Queue.QueueShutdown,
  );
});

test("Queue constructors reject invalid capacities", () => {
  assert.throws(() => Kyoot.runSync(Queue.bounded(-1).pipe(Sync.run)), /non-negative integer/);
});
