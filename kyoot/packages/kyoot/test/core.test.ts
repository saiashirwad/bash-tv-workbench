import assert from "node:assert/strict";
import { test } from "node:test";
import { KyootImpl, makeHandler, makeOp, succeed } from "../src/core.ts";
import { effect, Fail, Kyoot, Var } from "../src/index.ts";

const Count = Var.tag<number>()("Count");

test("map auto-flattens a returned Kyo", () => {
  const n = Kyoot.runSync(Kyoot.succeed(1).map((x) => Kyoot.succeed(x + 1)));
  assert.equal(n, 2);
});

test("map chains are trampolined: 100k maps, no stack overflow", () => {
  let k = Kyoot.succeed(0);
  for (let i = 0; i < 100_000; i++) k = k.map((x) => x + 1);
  assert.equal(Kyoot.runSync(k), 100_000);
});

test("pipe threads the computation through functions", () => {
  const n = Kyoot.succeed(2).pipe(
    (k) => k.map((x) => x + 1),
    (k) => k.map((x) => x * 10),
    Kyoot.runSync,
  );
  assert.equal(n, 30);
});

test("gen: yield* plain values and sub-computations", () => {
  const prog = Kyoot.gen(function* () {
    const a = yield* Kyoot.succeed(1);
    const b = yield* Kyoot.gen(function* () {
      return 2;
    });
    return a + b;
  });
  assert.equal(Kyoot.runSync(prog), 3);
});

test("gen with an effect, handled", () => {
  const prog = Kyoot.gen(function* () {
    yield* Count.set(5);
    const v = yield* Count.get();
    return v * 2;
  }).pipe(Count.run(0));
  assert.deepEqual(Kyoot.runSync(prog), [10, 5]);
});

test("a throw inside map is a defect and surfaces at the edge as-is", () => {
  const boom = new Error("boom");
  const k = Kyoot.succeed(1).map(() => {
    throw boom;
  });
  assert.throws(
    () => Kyoot.runSync(k),
    (e) => e === boom,
  );
});

test("a throw inside a gen body is a defect", () => {
  const boom = new Error("boom");
  const k = Kyoot.gen(function* () {
    yield* Kyoot.succeed(1);
    throw boom;
  });
  assert.throws(
    () => Kyoot.runSync(k),
    (e) => e === boom,
  );
});

test("runSync on an unhandled effect fails loudly at runtime", () => {
  const k = makeOp("nope", undefined);
  assert.throws(
    () => Kyoot.runSync(k as never),
    (e: unknown) => e instanceof Error && e.message.includes("unhandled effect 'nope'"),
  );
});

test("a continuation may only be resumed once", () => {
  const k = new KyootImpl({
    _tag: "handler",
    effectKey: "myfx",
    self: Kyoot.gen(function* () {
      const v = yield* makeOp("myfx", undefined);
      return (v as number) * 10;
    }),
    onOp: (_p, resume) => {
      const first = resume(1);
      return first.map(() => resume(2));
    },
  });
  assert.throws(() => Kyoot.runSync(k as never), /continuation resumed twice \(one-shot law\)/);
});

test("a handler that resumes zero times short-circuits", () => {
  const k = new KyootImpl({
    _tag: "handler",
    effectKey: "myfx",
    self: Kyoot.gen(function* () {
      yield* makeOp("myfx", undefined);
      return "unreachable";
    }).map(() => "also unreachable"),
    onOp: () => succeed("short"),
  });
  assert.equal(Kyoot.runSync(k as never), "short");
});

test("an op escaping a yielded handler node keeps the outer continuation", () => {
  const inner = new KyootImpl({
    _tag: "handler",
    effectKey: "inner",
    self: makeOp("outer", undefined),
    onOp: () => succeed("nope"),
  });
  const prog = Kyoot.gen(function* () {
    const v = yield* inner;
    return `${v} continued`;
  });
  const k = new KyootImpl({
    _tag: "handler",
    effectKey: "outer",
    self: prog,
    onOp: (_p, resume) => resume("handled"),
  });
  assert.equal(Kyoot.runSync(k as never), "handled continued");
});

test("a throw inside onOp goes to the same handler's onDefect", () => {
  const boom = new Error("boom");
  const k = makeHandler("myfx", makeOp("myfx", undefined) as never, {
    onOp: () => {
      throw boom;
    },
    onDefect: (d) => succeed(d === boom ? "caught" : "wrong"),
  });
  assert.equal(Kyoot.runSync(k as never), "caught");
});

test("resume.with continues the program at the op, where its own handlers see it", () => {
  const Fetch = effect<string, string, string>()("fetch");
  const program = Fetch("a").pipe(Fail.catchAll((e: string) => Kyoot.succeed(`caught ${e}`)));
  const failing = Fetch.handle({ onOp: (url, resume) => resume.with(Fail.fail(`no ${url}`)) });
  assert.equal(Kyoot.runSync(program.pipe(failing)), "caught no a");
});

test("intercept answers some ops and performs the rest for the handler outside", () => {
  const Fetch = effect<string, string>()("fetch");
  const cache = Fetch.intercept((url, next) =>
    url === "hot" ? Kyoot.succeed("cached") : next(url),
  );
  const live = Fetch.handle({ onOp: (url, resume) => resume(`fetched ${url}`) });
  const program = Kyoot.gen(function* () {
    return [yield* Fetch("hot"), yield* Fetch("cold")];
  });
  assert.deepEqual(Kyoot.runSync(program.pipe(cache, live)), ["cached", "fetched cold"]);
});
