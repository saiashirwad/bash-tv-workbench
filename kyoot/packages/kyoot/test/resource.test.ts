import assert from "node:assert/strict";
import { test } from "node:test";
import { Async, Clock, Fail, Kyoot, Resource } from "../src/index.ts";

test("Resource: release runs on success", () => {
  const events: string[] = [];
  const prog = Kyoot.gen(function* () {
    const conn = yield* Resource.acquire(
      () => {
        events.push("acquire");
        return "conn";
      },
      () => events.push("release"),
    );
    events.push(`use ${conn}`);
    return "done";
  });
  assert.equal(Kyoot.runSync(prog.pipe(Resource.run)), "done");
  assert.deepEqual(events, ["acquire", "use conn", "release"]);
});

test("Resource: finalizers run in LIFO order", () => {
  const events: string[] = [];
  const prog = Kyoot.gen(function* () {
    yield* Resource.acquire(
      () => "a",
      () => events.push("release a"),
    );
    yield* Resource.acquire(
      () => "b",
      () => events.push("release b"),
    );
    return null;
  });
  Kyoot.runSync(prog.pipe(Resource.run));
  assert.deepEqual(events, ["release b", "release a"]);
});

test("Resource: release runs on typed failure (Resource outside Fail)", () => {
  const events: string[] = [];
  const prog = Kyoot.gen(function* () {
    yield* Resource.acquire(
      () => "conn",
      () => events.push("release"),
    );
    yield* Fail.fail("boom");
    return "unreachable";
  }).pipe(Fail.run, Resource.run);
  assert.deepEqual(Kyoot.runSync(prog), { ok: false, cause: { _tag: "Fail", error: "boom" } });
  assert.deepEqual(events, ["release"]);
});

test("Resource: release runs on defect", () => {
  const events: string[] = [];
  const boom = new Error("boom");
  const prog = Kyoot.gen(function* () {
    yield* Resource.acquire(
      () => "conn",
      () => events.push("release"),
    );
    yield* Kyoot.succeed(0).map(() => {
      throw boom;
    });
    return "unreachable";
  }).pipe(Resource.run);
  assert.throws(
    () => Kyoot.runSync(prog),
    (e) => e === boom,
  );
  assert.deepEqual(events, ["release"]);
});

const slowClose = (events: string[], name: string) =>
  Resource.acquire(
    () => events.push(`open ${name}`),
    () => Clock.sleep(5).map(() => void events.push(`close ${name}`)),
  );

test("Resource: a finalizer may be a program (runs on success)", async () => {
  const events: string[] = [];
  const prog = Kyoot.gen(function* () {
    yield* slowClose(events, "a");
    yield* slowClose(events, "b");
    return "done";
  });
  assert.equal(await Kyoot.runPromise(prog.pipe(Resource.run)), "done");
  assert.deepEqual(events, ["open a", "open b", "close b", "close a"]);
});

test("Resource: program finalizers run on defect and the defect wins", async () => {
  const events: string[] = [];
  const boom = new Error("boom");
  const prog = Kyoot.gen(function* () {
    yield* slowClose(events, "a");
    yield* Async.fromPromise(() => Promise.reject(boom));
  });
  await assert.rejects(Kyoot.runPromise(prog.pipe(Resource.run)), (e) => e === boom);
  assert.deepEqual(events, ["open a", "close a"]);
});

test("Resource: program finalizers run to completion on interrupt", async () => {
  const events: string[] = [];
  const r = await Kyoot.runPromise(
    Kyoot.gen(function* () {
      const fiber = yield* Async.fork(
        Kyoot.gen(function* () {
          yield* slowClose(events, "a");
          yield* Clock.sleep(10_000);
        }).pipe(Resource.run),
      );
      yield* Clock.sleep(5);
      yield* fiber.interrupt;
      return yield* fiber.await;
    }),
  );
  assert.ok(!r.ok && r.cause._tag === "Interrupted");
  assert.deepEqual(events, ["open a", "close a"]);
});

test("a rejected async op is a defect that handlers see", async () => {
  const boom = new Error("boom");
  const events: string[] = [];
  const r = await Kyoot.runPromise(
    Kyoot.gen(function* () {
      yield* Resource.acquire(
        () => events.push("open"),
        () => events.push("close"),
      );
      yield* Async.fromPromise(() => Promise.reject(boom));
    }).pipe(Resource.run, Fail.run),
  );
  assert.ok(!r.ok && r.cause._tag === "Defect" && r.cause.defect === boom);
  assert.deepEqual(events, ["open", "close"]);
});

test("Resource: an acquire that throws releases what the scope already holds", () => {
  const events: string[] = [];
  const boom = new Error("boom");
  const prog = Kyoot.gen(function* () {
    yield* Resource.acquire(
      () => events.push("open a"),
      () => events.push("close a"),
    );
    yield* Resource.acquire(
      () => {
        throw boom;
      },
      () => events.push("never"),
    );
  }).pipe(Resource.run);
  assert.throws(
    () => Kyoot.runSync(prog),
    (e) => e === boom,
  );
  assert.deepEqual(events, ["open a", "close a"]);
});
