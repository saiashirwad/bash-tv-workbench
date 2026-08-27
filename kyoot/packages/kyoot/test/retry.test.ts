import assert from "node:assert/strict";
import { test } from "node:test";
import { Clock, Fail, Kyoot, Retry, Sync } from "../src/index.ts";

class Flaky {
  readonly _tag = "Flaky";
}

const failingFor = (n: number) => {
  let calls = 0;
  const prog = Kyoot.gen(function* () {
    calls++;
    if (calls <= n) yield* Fail.fail(new Flaky());
    return calls;
  });
  return { prog, calls: () => calls };
};

test("Retry: re-runs until success, sleeping between attempts", () => {
  const { prog, calls } = failingFor(2);
  const r = Kyoot.runSync(
    prog.pipe(
      Retry.run({ times: 5, delay: (attempt) => 100 * 2 ** attempt }),
      Fail.orThrow,
      Clock.virtual,
    ),
  );
  assert.deepEqual(r, [3, 100 + 200]);
  assert.equal(calls(), 3);
});

test("Retry: gives up after `times` retries with the last failure", () => {
  const { prog, calls } = failingFor(10);
  const [r] = Kyoot.runSync(prog.pipe(Retry.run({ times: 2 }), Fail.run, Clock.virtual));
  assert.ok(!r.ok && r.cause._tag === "Fail" && r.cause.error instanceof Flaky);
  assert.equal(calls(), 3);
});

test("Retry: gives up when `while` rejects the failure", () => {
  const { prog, calls } = failingFor(10);
  const [r, elapsed] = Kyoot.runSync(
    prog.pipe(
      Retry.run({ times: 3, delay: 100, while: (e) => !(e instanceof Flaky) }),
      Fail.run,
      Clock.virtual,
    ),
  );
  assert.ok(!r.ok && r.cause._tag === "Fail" && r.cause.error instanceof Flaky);
  assert.equal(calls(), 1);
  assert.equal(elapsed, 0);
});

test("Retry: defects are not retried", () => {
  let calls = 0;
  const boom = new Error("boom");
  const prog = Sync.defer(() => {
    calls++;
    throw boom;
  });
  assert.throws(
    () => Kyoot.runSync(prog.pipe(Sync.run, Retry.run({ times: 3 }), Fail.orThrow, Clock.virtual)),
    (e) => e === boom,
  );
  assert.equal(calls, 1);
});

test("Retry: works under runPromise with the real clock", async () => {
  const { prog } = failingFor(1);
  assert.equal(
    await Kyoot.runPromise(prog.pipe(Retry.run({ times: 1, delay: 5 }), Fail.orThrow)),
    2,
  );
});
