import assert from "node:assert/strict";
import { test } from "node:test";
import { Emit, Env, Kyoot, Sync, Var } from "../src/index.ts";

const Count = Var.tag<number>()("Count");
const Retries = Var.tag<number>()("Retries");

test("Env: provide answers the service key", () => {
  interface Greeter {
    greet(name: string): string;
  }
  const Greeter = Env.tag<Greeter>()("greeter");
  const prog = Kyoot.gen(function* () {
    const g = yield* Greeter.get();
    return g.greet("kyo");
  });
  const r = Kyoot.runSync(prog.pipe(Greeter.provide({ greet: (n: string) => `hi ${n}` })));
  assert.equal(r, "hi kyo");
});

test("Env: tags yield directly", () => {
  interface Greeter {
    greet(name: string): string;
  }
  const Greeter = Env.tag<Greeter>()("greeter");
  const prog = Kyoot.gen(function* () {
    const g = yield* Greeter;
    return g.greet("kyo");
  });
  const r = Kyoot.runSync(prog.pipe(Greeter.provide({ greet: (n: string) => `hi ${n}` })));
  assert.equal(r, "hi kyo");
});

test("Env: multiple services get distinct keys", () => {
  const A = Env.tag<{ a: number }>()("a");
  const B = Env.tag<{ b: number }>()("b");
  const prog = Kyoot.gen(function* () {
    const { a } = yield* A.get();
    const { b } = yield* B.get();
    return a + b;
  });
  const r = Kyoot.runSync(prog.pipe(A.provide({ a: 1 }), B.provide({ b: 2 })));
  assert.equal(r, 3);
});

test("Var: get/set/update", () => {
  const prog = Kyoot.gen(function* () {
    yield* Count.set(1);
    yield* Count.update((v) => v + 1);
    return yield* Count.get();
  });
  assert.deepEqual(Kyoot.runSync(prog.pipe(Count.run(0))), [2, 2]);
});

test("Var: same-typed tags stay independent", () => {
  const prog = Kyoot.gen(function* () {
    yield* Count.update((value) => value + 1);
    yield* Retries.update((value) => value + 2);
    return {
      count: yield* Count.get(),
      retries: yield* Retries.get(),
    };
  }).pipe(Retries.run(10), Count.run(0));

  assert.deepEqual(Kyoot.runSync(prog), [[{ count: 1, retries: 12 }, 12], 1]);
});

test("Var: nested scopes shadow and restore", () => {
  const inner = Kyoot.gen(function* () {
    yield* Count.set(100);
    return yield* Count.get();
  }).pipe(Count.run(100));

  const outer = Kyoot.gen(function* () {
    const before = yield* Count.get();
    const nested = yield* inner;
    const after = yield* Count.get();
    return { before, nested, after };
  }).pipe(Count.run(0));

  assert.deepEqual(Kyoot.runSync(outer), [{ before: 0, nested: [100, 100], after: 0 }, 0]);
});

test("Var: each execution gets a fresh state frame", () => {
  const prog = Kyoot.gen(function* () {
    yield* Count.update((value) => value + 1);
    return yield* Count.get();
  }).pipe(Count.run(0));

  assert.deepEqual(Kyoot.runSync(prog), [1, 1]);
  assert.deepEqual(Kyoot.runSync(prog), [1, 1]);
});

test("Emit.collect collects everything emitted", () => {
  const prog = Kyoot.gen(function* () {
    yield* Emit.value("a");
    yield* Emit.value("b");
    return 7;
  });
  assert.deepEqual(Kyoot.runSync(prog.pipe(Emit.collect)), [7, ["a", "b"]]);
});

test("Emit.forEach consumes values as they happen", () => {
  const seen: string[] = [];
  const prog = Kyoot.gen(function* () {
    yield* Emit.value("x");
    yield* Emit.value("y");
    return "done";
  });
  const r = Kyoot.runSync(prog.pipe(Emit.forEach((e: string) => seen.push(e))));
  assert.equal(r, "done");
  assert.deepEqual(seen, ["x", "y"]);
});

test("Emit.discard drops the stream", () => {
  const prog = Kyoot.gen(function* () {
    yield* Emit.value(1);
    return "ok";
  });
  assert.equal(Kyoot.runSync(prog.pipe(Emit.discard)), "ok");
});

test("Sync.defer is lazy and Sync.run discharges it", () => {
  let calls = 0;
  const prog = Kyoot.gen(function* () {
    const a = yield* Sync.defer(() => {
      calls++;
      return 3;
    });
    return a * 2;
  });
  assert.equal(calls, 0);
  const r = Kyoot.runSync(prog.pipe(Sync.run));
  assert.equal(r, 6);
  assert.equal(calls, 1);
});

test("Sync.defer: a throwing thunk is a defect, not a typed failure", () => {
  const boom = new Error("boom");
  const prog = Sync.defer(() => {
    throw boom;
  });
  assert.throws(
    () => Kyoot.runSync(prog.pipe(Sync.run)),
    (e) => e === boom,
  );
});
