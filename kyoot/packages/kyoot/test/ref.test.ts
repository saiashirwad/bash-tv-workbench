import assert from "node:assert/strict";
import { test } from "node:test";
import { Async, Kyoot, Ref, Sync } from "../src/index.ts";

test("Ref updates are shared across fibers", async () => {
  const program = Kyoot.gen(function* () {
    const ref = yield* Ref.make(0);
    const workers = [];
    for (let worker = 0; worker < 10; worker++)
      workers.push(
        yield* Async.fork(
          Kyoot.gen(function* () {
            for (let index = 0; index < 100; index++) yield* ref.update((value) => value + 1);
          }),
        ),
      );
    for (const worker of workers) yield* worker.join;
    return yield* ref.get;
  }).pipe(Sync.run);
  assert.equal(await Kyoot.runPromise(program), 1000);
});

test("Ref.modify returns a value and installs the next state atomically", () => {
  const program = Kyoot.gen(function* () {
    const ref = yield* Ref.make(["a"]);
    const previousLength = yield* ref.modify((values) => [values.length, [...values, "b"]]);
    return [previousLength, yield* ref.get] as const;
  }).pipe(Sync.run);
  assert.deepEqual(Kyoot.runSync(program), [1, ["a", "b"]]);
});
