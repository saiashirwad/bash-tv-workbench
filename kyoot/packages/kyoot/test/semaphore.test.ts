import assert from "node:assert/strict";
import { test } from "node:test";
import { Async, Clock, Fail, Kyoot, Semaphore } from "../src/index.ts";

const Slots = Semaphore.tag("test-slots");

test("Semaphore: provide bounds concurrent runs", async () => {
  let active = 0;
  let peak = 0;
  const events: string[] = [];
  const task = (id: number) =>
    Slots.run(
      Kyoot.gen(function* () {
        active++;
        peak = Math.max(peak, active);
        events.push(`start ${id}`);
        yield* Clock.sleep(5);
        events.push(`end ${id}`);
        active--;
        return id;
      }),
    );

  const program = Async.all([task(1), task(2), task(3), task(4)]).pipe(
    Slots.provide({ permits: 2 }),
  );

  assert.deepEqual(await Kyoot.runPromise(program), [1, 2, 3, 4]);
  assert.equal(peak, 2);
  assert.deepEqual(events.slice(0, 2), ["start 1", "start 2"]);
});

test("Semaphore: waiting runs are admitted FIFO", async () => {
  const order: number[] = [];
  const task = (id: number) =>
    Slots.run(
      Kyoot.gen(function* () {
        order.push(id);
        yield* Clock.sleep(2);
      }),
    );

  await Kyoot.runPromise(
    Async.all([task(1), task(2), task(3), task(4)]).pipe(Slots.provide({ permits: 1 })),
  );
  assert.deepEqual(order, [1, 2, 3, 4]);
});

test("Semaphore: a permit is returned after typed failure", async () => {
  const program = Kyoot.gen(function* () {
    const failed = yield* Async.fork(Slots.run(Fail.fail("nope" as const)));
    const failure = yield* failed.await;
    const next = yield* Slots.run(Kyoot.succeed("admitted"));
    return [failure, next] as const;
  }).pipe(Slots.provide({ permits: 1 }));

  const [failure, next] = await Kyoot.runPromise(program);
  assert.ok(!failure.ok && failure.cause._tag === "Fail" && failure.cause.error === "nope");
  assert.equal(next, "admitted");
});

test("Semaphore: a permit is returned after defect", async () => {
  const boom = new Error("boom");
  const program = Kyoot.gen(function* () {
    const failed = yield* Async.fork(
      Slots.run(
        Kyoot.succeed(undefined).map(() => {
          throw boom;
        }),
      ),
    );
    const failure = yield* failed.await;
    const next = yield* Slots.run(Kyoot.succeed("admitted"));
    return [failure, next] as const;
  }).pipe(Slots.provide({ permits: 1 }));

  const [failure, next] = await Kyoot.runPromise(program);
  assert.ok(!failure.ok && failure.cause._tag === "Defect" && failure.cause.defect === boom);
  assert.equal(next, "admitted");
});

test("Semaphore: a permit is returned after interruption", async () => {
  const program = Kyoot.gen(function* () {
    const held = yield* Async.fork(Slots.run(Async.never));
    yield* Clock.sleep(1);
    yield* held.interrupt;
    const interrupted = yield* held.await;
    const next = yield* Slots.run(Kyoot.succeed("admitted"));
    return [interrupted, next] as const;
  }).pipe(Slots.provide({ permits: 1 }));

  const [interrupted, next] = await Kyoot.runPromise(program);
  assert.ok(!interrupted.ok && interrupted.cause._tag === "Interrupted");
  assert.equal(next, "admitted");
});

test("Semaphore: interrupting a waiter does not consume a permit", async () => {
  const events: string[] = [];
  const program = Kyoot.gen(function* () {
    const holder = yield* Async.fork(
      Slots.run(
        Clock.sleep(20).map(() => {
          events.push("holder");
        }),
      ),
    );
    yield* Clock.sleep(1);
    const cancelled = yield* Async.fork(
      Slots.run(
        Kyoot.succeed(undefined).map(() => {
          events.push("cancelled ran");
        }),
      ),
    );
    yield* Clock.sleep(1);
    yield* cancelled.interrupt;
    const cancelledResult = yield* cancelled.await;
    yield* holder.join;
    yield* Slots.run(
      Kyoot.succeed(undefined).map(() => {
        events.push("next");
      }),
    );
    return cancelledResult;
  }).pipe(Slots.provide({ permits: 1 }));

  const cancelled = await Kyoot.runPromise(program);
  assert.ok(!cancelled.ok && cancelled.cause._tag === "Interrupted");
  assert.deepEqual(events, ["holder", "next"]);
});

test("Semaphore: zero permits block until interruption", async () => {
  const program = Kyoot.gen(function* () {
    const blocked = yield* Async.fork(Slots.run(Kyoot.succeed("never")));
    yield* Clock.sleep(1);
    yield* blocked.interrupt;
    return yield* blocked.await;
  }).pipe(Slots.provide({ permits: 0 }));

  const result = await Kyoot.runPromise(program);
  assert.ok(!result.ok && result.cause._tag === "Interrupted");
});

test("Semaphore: each provide execution creates fresh state", async () => {
  const protectedValue = Slots.run(Kyoot.succeed(1)).pipe(Slots.provide({ permits: 1 }));
  assert.equal(await Kyoot.runPromise(protectedValue), 1);
  assert.equal(await Kyoot.runPromise(protectedValue), 1);
});

test("Semaphore: withPermit aliases run", async () => {
  const value = Slots.withPermit(Kyoot.succeed(42)).pipe(Slots.provide({ permits: 1 }));
  assert.equal(await Kyoot.runPromise(value), 42);
});

test("Semaphore: provide rejects invalid permit counts", () => {
  assert.throws(() => Slots.provide({ permits: -1 }), /non-negative integer/);
  assert.throws(() => Slots.provide({ permits: 1.5 }), /non-negative integer/);
});
