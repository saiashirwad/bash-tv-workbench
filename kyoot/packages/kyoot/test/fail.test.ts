import assert from "node:assert/strict";
import { test } from "node:test";
import { Fail, Kyoot, Var } from "../src/index.ts";

const Total = Var.tag<number>()("Total");

test("Fail.run: success becomes Result.ok", () => {
  const flag = false as boolean;
  const prog = Kyoot.gen(function* () {
    if (flag) yield* Fail.fail("never");
    return 42;
  });
  const r = Kyoot.runSync(prog.pipe(Fail.run));
  assert.deepEqual(r, { ok: true, value: 42 });
});

test("Fail.run: typed failure becomes Result with a Fail cause", () => {
  const r = Kyoot.runSync(Fail.fail("nope").pipe(Fail.run));
  assert.deepEqual(r, { ok: false, cause: { _tag: "Fail", error: "nope" } });
});

test("Fail.run: a defect lands in the defect channel, not the error channel", () => {
  const boom = new Error("boom");
  const k = Kyoot.gen(function* () {
    yield* Kyoot.succeed(1);
    throw boom;
  }).pipe(Fail.run);
  const r = Kyoot.runSync(k);
  assert.equal(r.ok, false);
  assert.equal(!r.ok && r.cause._tag, "Defect");
  assert.equal(!r.ok && r.cause._tag === "Defect" && r.cause.defect, boom);
});

test("defects bypass Fail.catchAll", () => {
  const boom = new Error("boom");
  const k = Kyoot.succeed(1)
    .map(() => {
      throw boom;
    })
    .pipe(Fail.catchAll(() => Kyoot.succeed("recovered")));
  assert.throws(
    () => Kyoot.runSync(k),
    (e) => e === boom,
  );
});

test("Fail.catchAll replaces a typed failure with a new computation", () => {
  const k = Kyoot.gen(function* () {
    yield* Fail.fail("bad");
    return "unreachable";
  }).pipe(Fail.catchAll((e: string) => Kyoot.succeed(`caught ${e}`)));
  assert.equal(Kyoot.runSync(k), "caught bad");
});

test("Fail.orThrow throws the error value at the edge", () => {
  const err = new RangeError("too big");
  assert.throws(
    () => Kyoot.runSync(Fail.fail(err).pipe(Fail.orThrow)),
    (e) => e === err,
  );
});

test("handler order: Var before Fail is transactional — failure carries no state", () => {
  const prog = Kyoot.gen(function* () {
    yield* Total.update((t) => t + 10);
    yield* Fail.fail("out of stock");
    return "unreachable";
  });
  const r = Kyoot.runSync(prog.pipe(Total.run(0), Fail.run));
  assert.equal(r.ok, false);
});

test("handler order: Fail before Var — state survives failure", () => {
  const prog = Kyoot.gen(function* () {
    yield* Total.update((t) => t + 10);
    yield* Fail.fail("out of stock");
    return "unreachable";
  });
  const [r, state] = Kyoot.runSync(prog.pipe(Fail.run, Total.run(0)));
  assert.equal(r.ok, false);
  assert.equal(state, 10);
});

class NotFound {
  readonly _tag = "NotFound";
}
class Timeout {
  readonly _tag = "Timeout";
}

test("Fail.catchTag: handles one tag and re-fails the rest", () => {
  const prog = (e: NotFound | Timeout) =>
    Fail.fail(e).pipe(
      Fail.catchTag("NotFound", () => Kyoot.succeed("recovered")),
      Fail.run,
    );
  assert.deepEqual(Kyoot.runSync(prog(new NotFound())), { ok: true, value: "recovered" });
  const r = Kyoot.runSync(prog(new Timeout()));
  assert.ok(!r.ok && r.cause._tag === "Fail" && r.cause.error instanceof Timeout);
});

test("Fail.mapError: rewrites the failure", () => {
  const r = Kyoot.runSync(
    Fail.fail(404).pipe(
      Fail.mapError((code: number) => `http ${code}`),
      Fail.run,
    ),
  );
  assert.deepEqual(r, { ok: false, cause: { _tag: "Fail", error: "http 404" } });
});
