import assert from "node:assert/strict";
import { test } from "node:test";
import { Async, Clock, Fail, Kyoot, Sync } from "kyoot";
import { awaitWorkers, make, type WorkerEvent } from "../src/scheduler.ts";

interface Task {
  readonly delay: number;
  readonly fail?: boolean;
}

test("persistent scheduler bounds concurrency and accepts work over time", async () => {
  let active = 0;
  let peak = 0;
  const completed: string[] = [];
  const events: WorkerEvent<Task>[] = [];

  const program = Kyoot.gen(function* () {
    const { scheduler, workers } = yield* make({
      concurrency: 2,
      queueCapacity: 8,
      onEvent: (event: WorkerEvent<Task>) => events.push(event),
      execute: (job: { readonly id: string; readonly value: Task }) =>
        Kyoot.gen(function* () {
          active++;
          peak = Math.max(peak, active);
          yield* Clock.sleep(job.value.delay);
          active--;
          completed.push(job.id);
        }),
    });

    yield* scheduler.submit({ id: "a", value: { delay: 20 } });
    yield* scheduler.submit({ id: "b", value: { delay: 20 } });
    yield* Clock.sleep(2);
    yield* scheduler.submit({ id: "c", value: { delay: 1 } });

    while (completed.length < 3) yield* Clock.sleep(2);
    yield* scheduler.shutdown;
    yield* awaitWorkers(workers);
  }).pipe(Sync.run, Fail.orThrow);

  await Kyoot.runPromise(program);
  assert.equal(peak, 2);
  assert.deepEqual([...completed].sort(), ["a", "b", "c"]);
  assert.equal(events.filter((event) => event.type === "started").length, 3);
  assert.equal(events.filter((event) => event.type === "completed").length, 3);
});

test("one defective job is reported and workers continue", async () => {
  const events: WorkerEvent<Task>[] = [];
  const completed: string[] = [];

  const program = Kyoot.gen(function* () {
    const { scheduler, workers } = yield* make({
      concurrency: 1,
      onEvent: (event: WorkerEvent<Task>) => events.push(event),
      execute: (job: { readonly id: string; readonly value: Task }) =>
        Clock.sleep(1).map(() => {
          if (job.value.fail) throw new Error(job.id);
          completed.push(job.id);
        }),
    });

    yield* scheduler.submit({ id: "bad", value: { delay: 1, fail: true } });
    yield* scheduler.submit({ id: "good", value: { delay: 1 } });
    while (completed.length < 1) yield* Clock.sleep(2);
    yield* scheduler.shutdown;
    yield* awaitWorkers(workers);
  }).pipe(Sync.run, Fail.orThrow);

  await Kyoot.runPromise(program);
  assert.deepEqual(completed, ["good"]);
  assert.equal(events.filter((event) => event.type === "failed").length, 1);
  assert.equal(events.filter((event) => event.type === "completed").length, 1);
});

test("interrupting the scheduler scope interrupts active workers", async () => {
  let interrupted = false;
  const program = Kyoot.gen(function* () {
    const root = yield* Async.fork(
      Kyoot.gen(function* () {
        const { scheduler } = yield* make({
          concurrency: 1,
          execute: (_job: { readonly id: string; readonly value: Task }) =>
            Async.fromPromise(
              (signal) =>
                new Promise<void>(() =>
                  signal.addEventListener("abort", () => (interrupted = true), { once: true }),
                ),
            ),
        });
        yield* scheduler.submit({ id: "slow", value: { delay: 1 } });
        yield* Async.never;
      }).pipe(Sync.run, Fail.orThrow),
    );
    yield* Clock.sleep(5);
    yield* root.interrupt;
    return yield* root.await;
  });

  const result = await Kyoot.runPromise(program);
  assert.ok(!result.ok && result.cause._tag === "Interrupted");
  assert.equal(interrupted, true);
});
