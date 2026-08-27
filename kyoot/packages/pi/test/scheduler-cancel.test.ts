import assert from "node:assert/strict";
import { test } from "node:test";
import { Clock, Fail, Kyoot, Sync } from "kyoot";
import { awaitWorkers, make, type WorkerEvent } from "../src/scheduler.ts";

interface Task {
  readonly wait: number;
}

test("cancel interrupts only the selected active job and releases capacity", async () => {
  const events: WorkerEvent<Task>[] = [];
  const program = Kyoot.gen(function* () {
    const { scheduler, workers } = yield* make({
      concurrency: 2,
      onEvent: (event: WorkerEvent<Task>) => events.push(event),
      execute: (job: { readonly id: string; readonly value: Task }) => Clock.sleep(job.value.wait),
    });
    yield* scheduler.submit({ id: "slow", value: { wait: 10_000 } });
    yield* scheduler.submit({ id: "sibling", value: { wait: 10 } });
    yield* Clock.sleep(2);
    assert.equal(yield* scheduler.cancel("slow"), true);
    yield* scheduler.submit({ id: "replacement", value: { wait: 1 } });
    while (events.filter((event) => event.type === "completed").length < 2) yield* Clock.sleep(2);
    yield* scheduler.shutdown;
    yield* awaitWorkers(workers);
  }).pipe(Sync.run, Fail.orThrow);
  await Kyoot.runPromise(program);
  assert.deepEqual(
    events
      .filter((event) => event.type === "completed")
      .map((event) => event.job.id)
      .sort(),
    ["replacement", "sibling"],
  );
  assert.equal(
    events.find((event) => event.job.id === "slow" && event.type === "failed") !== undefined,
    true,
  );
});

test("cancelled queued jobs are skipped", async () => {
  const started: string[] = [];
  const program = Kyoot.gen(function* () {
    const { scheduler, workers } = yield* make({
      concurrency: 1,
      execute: (job: { readonly id: string; readonly value: Task }) =>
        Kyoot.gen(function* () {
          started.push(job.id);
          yield* Clock.sleep(job.value.wait);
        }),
    });
    yield* scheduler.submit({ id: "first", value: { wait: 10 } });
    yield* scheduler.submit({ id: "cancelled", value: { wait: 1 } });
    assert.equal(yield* scheduler.cancel("cancelled"), false);
    yield* scheduler.submit({ id: "last", value: { wait: 1 } });
    while (!started.includes("last")) yield* Clock.sleep(2);
    yield* scheduler.shutdown;
    yield* awaitWorkers(workers);
  }).pipe(Sync.run, Fail.orThrow);
  await Kyoot.runPromise(program);
  assert.deepEqual(started, ["first", "last"]);
});
