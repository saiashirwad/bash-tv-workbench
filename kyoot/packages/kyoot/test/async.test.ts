import assert from "node:assert/strict";
import { test } from "node:test";
import {
  Async,
  Clock,
  effect,
  Emit,
  Env,
  Fail,
  InterruptedError,
  Kyoot,
  Log,
  Resource,
} from "../src/index.ts";

test("fromPromise resolves through runPromise", async () => {
  const r = await Kyoot.runPromise(Async.fromPromise(() => Promise.resolve(42)));
  assert.equal(r, 42);
});

test("fromPromise exposes an AbortSignal from day one", async () => {
  const r = await Kyoot.runPromise(Async.fromPromise((signal) => Promise.resolve(signal.aborted)));
  assert.equal(r, false);
});

test("fromPromise sends a synchronous throw to Fail.run as a defect", async () => {
  const boom = new Error("boom");
  const r = await Kyoot.runPromise(
    Async.fromPromise(() => {
      throw boom;
    }).pipe(Fail.run),
  );
  assert.ok(!r.ok && r.cause._tag === "Defect" && r.cause.defect === boom);
});

test("fork/join: a fiber is an independent interpreter loop", async () => {
  const prog = Kyoot.gen(function* () {
    const fiber = yield* Async.fork(
      Kyoot.gen(function* () {
        yield* Clock.sleep(10);
        return "fiber done";
      }),
    );
    return yield* fiber.join;
  });
  assert.equal(await Kyoot.runPromise(prog), "fiber done");
});

test("fiber.await returns a Result instead of throwing", async () => {
  const boom = new Error("boom");
  const prog = Kyoot.gen(function* () {
    const fiber = yield* Async.fork(
      Clock.sleep(1).map(() => {
        throw boom;
      }),
    );
    return yield* fiber.await;
  });
  const r = await Kyoot.runPromise(prog);
  assert.equal(r.ok, false);
  assert.equal(!r.ok && r.cause._tag === "Defect" && r.cause.defect, boom);
});

test("race: first to complete wins", async () => {
  const slow = Clock.sleep(50).map(() => "slow");
  const fast = Clock.sleep(5).map(() => "fast");
  assert.equal(await Kyoot.runPromise(Async.race(slow, fast)), "fast");
});

test("timeout: a slow computation fails with a typed Timeout", async () => {
  const r = await Kyoot.runPromise(Async.timeout(5, Clock.sleep(50)).pipe(Fail.run));
  assert.equal(r.ok, false);
  assert.ok(!r.ok && r.cause._tag === "Fail" && r.cause.error instanceof Async.Timeout);
});

test("timeout: a fast computation wins", async () => {
  const r = await Kyoot.runPromise(
    Async.timeout(
      50,
      Clock.sleep(5).map(() => "quick"),
    ).pipe(Fail.orThrow),
  );
  assert.equal(r, "quick");
});

test("timeout inside a gen resumes the surrounding computation", async () => {
  const prog = Kyoot.gen(function* () {
    const r = yield* Async.timeout(
      50,
      Clock.sleep(5).map(() => "quick"),
    ).pipe(Fail.run);
    return r.ok ? `${r.value} again` : "failed";
  });
  assert.equal(await Kyoot.runPromise(prog), "quick again");
});

test("runPromise surfaces defects as rejections", async () => {
  const boom = new Error("boom");
  const k = Kyoot.gen(function* () {
    yield* Clock.sleep(1);
    throw boom;
  });
  await assert.rejects(Kyoot.runPromise(k), (e) => e === boom);
});

test("runPromise on an unhandled non-async effect rejects loudly", async () => {
  const k = Fail.fail("still pending");
  await assert.rejects(
    Kyoot.runPromise(k as never),
    (e: unknown) => e instanceof Error && e.message.includes("unhandled effect 'fail'"),
  );
});

test("runSync rejects an async op at runtime", () => {
  assert.throws(
    () => Kyoot.runSync(Async.fromPromise(() => Promise.resolve()) as never),
    (e: unknown) => e instanceof Error && e.message.includes("unhandled effect 'async'"),
  );
});

test("interrupt: finalizers run and await reports Interrupted", async () => {
  const events: string[] = [];
  const prog = Kyoot.gen(function* () {
    const fiber = yield* Async.fork(
      Kyoot.gen(function* () {
        yield* Resource.acquire(
          () => "conn",
          () => events.push("release"),
        );
        yield* Clock.sleep(10_000);
        return "unreachable";
      }).pipe(Resource.run),
    );
    yield* fiber.interrupt;
    return yield* fiber.await;
  });
  const r = await Kyoot.runPromise(prog);
  assert.equal(r.ok, false);
  assert.ok(!r.ok && r.cause._tag === "Interrupted");
  assert.deepEqual(events, ["release"]);
});

test("structured concurrency: a completed parent interrupts its children", async () => {
  const events: string[] = [];
  await Kyoot.runPromise(
    Kyoot.gen(function* () {
      yield* Async.fork(
        Kyoot.gen(function* () {
          yield* Resource.acquire(
            () => "conn",
            () => events.push("release"),
          );
          yield* Clock.sleep(10_000);
        }).pipe(Resource.run),
      );
      return "parent done";
    }),
  );
  assert.deepEqual(events, ["release"]);
});

test("all: results come back in input order, not completion order", async () => {
  const slow = Clock.sleep(20).map(() => "slow");
  const fast = Clock.sleep(5).map(() => "fast");
  assert.deepEqual(await Kyoot.runPromise(Async.all([slow, fast])), ["slow", "fast"]);
});

test("all: branches run concurrently", async () => {
  const events: string[] = [];
  const branch = (tag: string, ms: number) =>
    Kyoot.gen(function* () {
      events.push(`start ${tag}`);
      yield* Clock.sleep(ms);
      events.push(`end ${tag}`);
    });
  await Kyoot.runPromise(Async.all([branch("a", 20), branch("b", 10)]));
  assert.deepEqual(events, ["start a", "start b", "end b", "end a"]);
});

test("all: empty array resolves immediately", async () => {
  assert.deepEqual(await Kyoot.runPromise(Async.all([])), []);
});

test("all: NaN concurrency runs every branch", async () => {
  const ks = [1, 2, 3].map((n) => Async.fromPromise(() => Promise.resolve(n)));
  assert.deepEqual(await Kyoot.runPromise(Async.all(ks, { concurrency: NaN })), [1, 2, 3]);
});

test("all: first failure interrupts the rest and runs their finalizers", async () => {
  const events: string[] = [];
  const boom = new Error("boom");
  const slow = Kyoot.gen(function* () {
    yield* Resource.acquire(
      () => "conn",
      () => events.push("release"),
    );
    yield* Clock.sleep(10_000);
    return "unreachable";
  }).pipe(Resource.run);
  const failing = Clock.sleep(5).map(() => {
    throw boom;
  });
  await assert.rejects(Kyoot.runPromise(Async.all([slow, failing])), (e) => e === boom);
  assert.deepEqual(events, ["release"]);
});

test("all: interrupting the parent interrupts every branch", async () => {
  const events: string[] = [];
  const branch = (tag: string) =>
    Kyoot.gen(function* () {
      yield* Resource.acquire(
        () => tag,
        () => events.push(`release ${tag}`),
      );
      yield* Clock.sleep(10_000);
    }).pipe(Resource.run);
  const prog = Kyoot.gen(function* () {
    const fiber = yield* Async.fork(Async.all([branch("a"), branch("b")]));
    yield* Clock.sleep(10);
    yield* fiber.interrupt;
    return yield* fiber.await;
  });
  const r = await Kyoot.runPromise(prog);
  assert.equal(r.ok, false);
  assert.ok(!r.ok && r.cause._tag === "Interrupted");
  assert.deepEqual(events.sort(), ["release a", "release b"]);
});

test("race interrupts the loser and runs its finalizers", async () => {
  const events: string[] = [];
  const slow = Kyoot.gen(function* () {
    yield* Resource.acquire(
      () => "slow",
      () => events.push("release slow"),
    );
    yield* Clock.sleep(10_000);
    return "slow";
  }).pipe(Resource.run);
  const fast = Clock.sleep(5).map(() => "fast");
  const r = await Kyoot.runPromise(Async.race(slow, fast));
  assert.equal(r, "fast");
  assert.deepEqual(events, ["release slow"]);
});

test("timeout interrupts the branch and runs its finalizers", async () => {
  const events: string[] = [];
  const slow = Kyoot.gen(function* () {
    yield* Resource.acquire(
      () => "conn",
      () => events.push("release"),
    );
    yield* Clock.sleep(10_000);
    return "unreachable";
  }).pipe(Resource.run);
  const r = await Kyoot.runPromise(Async.timeout(5, slow).pipe(Fail.run));
  assert.equal(r.ok, false);
  assert.deepEqual(events, ["release"]);
});

test("fromPromise's signal fires on interruption", async () => {
  let sawAbort = false;
  const prog = Kyoot.gen(function* () {
    const fiber = yield* Async.fork(
      Async.fromPromise(
        (signal) =>
          new Promise(() => {
            signal.addEventListener("abort", () => {
              sawAbort = true;
            });
          }),
      ),
    );
    yield* fiber.interrupt;
    yield* fiber.await;
    return sawAbort;
  });
  assert.equal(await Kyoot.runPromise(prog), true);
});

test("joining an interrupted fiber interrupts the joiner", async () => {
  const prog = Kyoot.gen(function* () {
    const fiber = yield* Async.fork(Clock.sleep(10_000));
    yield* fiber.interrupt;
    return yield* fiber.join;
  });
  await assert.rejects(Kyoot.runPromise(prog), (e) => e instanceof InterruptedError);
});

test("all: concurrency limit bounds in-flight fibers and keeps order", async () => {
  let inflight = 0;
  let peak = 0;
  const task = (n: number) =>
    Async.fromPromise(async () => {
      inflight++;
      peak = Math.max(peak, inflight);
      await new Promise((r) => setTimeout(r, 5));
      inflight--;
      return n;
    });
  const r = await Kyoot.runPromise(Async.all([1, 2, 3, 4, 5].map(task), { concurrency: 2 }));
  assert.deepEqual(r, [1, 2, 3, 4, 5]);
  assert.equal(peak, 2);
});

test("all: a failure stops scheduling the rest", async () => {
  let started = 0;
  const boom = new Error("boom");
  const task = (fail: boolean) =>
    Async.fromPromise(async () => {
      started++;
      await new Promise((r) => setTimeout(r, 2));
      if (fail) throw boom;
    });
  await assert.rejects(
    Kyoot.runPromise(
      Async.all([task(true), task(false), task(false), task(false)], { concurrency: 1 }),
    ),
    (e) => e === boom,
  );
  assert.equal(started, 1);
});

// ---------------------------------------------------------------------------
// Fibers inherit the handlers around the fork.
// ---------------------------------------------------------------------------

test("fork: a fiber sees the Env provided outside the fork", async () => {
  const Name = Env.tag<string>()("name");
  const prog = Kyoot.gen(function* () {
    const fiber = yield* Async.fork(Name.get().map((n) => `hi ${n}`));
    return yield* fiber.join;
  }).pipe(Name.provide("kyoot"));
  assert.equal(await Kyoot.runPromise(prog), "hi kyoot");
});

test("fork: Log.collect around the fork gathers the fiber's entries", async () => {
  const prog = Kyoot.gen(function* () {
    yield* Log.info("parent");
    const fiber = yield* Async.fork(Log.info("child").map(() => 1));
    yield* fiber.join;
    yield* Log.info("parent again");
    return "ok";
  }).pipe(Log.collect);
  const [a, entries] = await Kyoot.runPromise(prog);
  assert.equal(a, "ok");
  assert.deepEqual(
    entries.map((e) => e.message),
    ["parent", "child", "parent again"],
  );
});

test("fork: Emit.collect around the fork collects what fibers emit", async () => {
  const prog = Kyoot.gen(function* () {
    const fibers = yield* Async.all([Emit.value(1), Emit.value(2)]);
    yield* Emit.value(3);
    return fibers.length;
  }).pipe(Emit.collect);
  const [n, emitted] = await Kyoot.runPromise(prog);
  assert.equal(n, 2);
  assert.deepEqual([...emitted].sort(), [1, 2, 3]);
});

test("fork: a collecting handler is fresh per run, even when forked into", async () => {
  const prog = Kyoot.gen(function* () {
    const fiber = yield* Async.fork(Log.info("child"));
    yield* fiber.join;
  }).pipe(Log.collect);
  const [, first] = await Kyoot.runPromise(prog);
  const [, second] = await Kyoot.runPromise(prog);
  assert.equal(first.length, 1);
  assert.equal(second.length, 1);
});

test("fork: a typed failure in the fiber crosses join as a fail op", async () => {
  class Boom {
    readonly _tag = "Boom";
  }
  const prog = Kyoot.gen(function* () {
    const fiber = yield* Async.fork(
      Kyoot.gen(function* () {
        yield* Clock.sleep(1);
        return yield* Fail.fail(new Boom());
      }),
    );
    return yield* fiber.join;
  }).pipe(Fail.run);
  const r = await Kyoot.runPromise(prog);
  assert.equal(r.ok, false);
  assert.ok(!r.ok && r.cause._tag === "Fail" && r.cause.error instanceof Boom);
});

test("fork: fiber.await reports a typed failure as a Fail cause", async () => {
  const prog = Kyoot.gen(function* () {
    const fiber = yield* Async.fork(Fail.fail("nope" as const));
    return yield* fiber.await;
  });
  const r = await Kyoot.runPromise(prog);
  assert.ok(!r.ok && r.cause._tag === "Fail" && r.cause.error === "nope");
});

test("race: a failing branch that finishes first fails the race, typed", async () => {
  const r = await Kyoot.runPromise(
    Async.race(
      Clock.sleep(50).map(() => "slow"),
      Clock.sleep(1).map(() => Fail.fail("fast failure" as const)),
    ).pipe(Fail.run),
  );
  assert.ok(!r.ok && r.cause._tag === "Fail" && r.cause.error === "fast failure");
});

test("all: a typed failure in one branch fails the whole, and the rest are interrupted", async () => {
  const events: string[] = [];
  const slow = Kyoot.gen(function* () {
    yield* Resource.acquire(
      () => "conn",
      () => events.push("release"),
    );
    yield* Clock.sleep(10_000);
    return 1;
  }).pipe(Resource.run);
  const failing = Clock.sleep(1).map(() => Fail.fail("bad" as const));
  const r = await Kyoot.runPromise(Async.all([slow, failing]).pipe(Fail.run));
  assert.ok(!r.ok && r.cause._tag === "Fail" && r.cause.error === "bad");
  assert.deepEqual(events, ["release"]);
});

test("fork: Resource.run outside the fork gives the fiber a scope of its own", async () => {
  const events: string[] = [];
  const prog = Kyoot.gen(function* () {
    yield* Resource.acquire(
      () => "parent",
      () => events.push("release parent"),
    );
    const fiber = yield* Async.fork(
      Kyoot.gen(function* () {
        yield* Resource.acquire(
          () => "child",
          () => events.push("release child"),
        );
        yield* Clock.sleep(1);
      }),
    );
    yield* fiber.join;
    events.push("joined");
  }).pipe(Resource.run);
  await Kyoot.runPromise(prog);
  assert.deepEqual(events, ["release child", "joined", "release parent"]);
});

test("fork: Clock.virtual outside the fork makes the fiber's sleeps instant", async () => {
  const prog = Kyoot.gen(function* () {
    const fiber = yield* Async.fork(Clock.sleep(10_000).map(() => "woke"));
    return yield* fiber.join;
  }).pipe(Clock.virtual);
  assert.deepEqual(await Kyoot.runPromise(prog), ["woke", 0]);
});

test("fork: a copied handler that returns instead of resuming is a defect", async () => {
  const Ask = effect<string, number>()("ask");
  const prog = Kyoot.gen(function* () {
    const fiber = yield* Async.fork(Ask("n?"));
    return yield* fiber.await;
  }).pipe(Ask.handle({ onOp: () => Kyoot.succeed(0) }));
  const r = await Kyoot.runPromise(prog);
  assert.ok(typeof r === "object" && !r.ok && r.cause._tag === "Defect");
  assert.match(String((r.cause as { defect: Error }).defect.message), /returned a value/);
});

test("fork: a handler marked fork: none stops at the fiber, loudly", async () => {
  const Ask = effect<string, number>()("ask");
  const prog = Kyoot.gen(function* () {
    const fiber = yield* Async.fork(Ask("n?"));
    return yield* fiber.await;
  }).pipe(Ask.handle({ fork: "none", onOp: (_q, resume) => resume(1) }));
  const r = await Kyoot.runPromise(prog);
  assert.ok(!r.ok && r.cause._tag === "Defect");
  assert.match(String((r.cause as { defect: Error }).defect.message), /unhandled effect 'ask'/);
});

test("fork: a copied handler that fails in its own scope fails the fiber, typed", async () => {
  class Declined {
    readonly _tag = "Declined";
  }
  const Pay = effect<number, string>()("pay");
  const prog = Kyoot.gen(function* () {
    const fiber = yield* Async.fork(Pay(1));
    return yield* fiber.join;
  }).pipe(Pay.handle({ onOp: () => Fail.fail(new Declined()) }), Fail.run);
  const r = await Kyoot.runPromise(prog);
  assert.ok(!r.ok && r.cause._tag === "Fail" && r.cause.error instanceof Declined);
});

test("fork: a typed failure still ends the fiber's own scope", async () => {
  const events: string[] = [];
  const prog = Kyoot.gen(function* () {
    const fiber = yield* Async.fork(
      Kyoot.gen(function* () {
        yield* Resource.acquire(
          () => "conn",
          () => events.push("release"),
        );
        return yield* Fail.fail("bad" as const);
      }),
    );
    return yield* fiber.await;
  }).pipe(Resource.run);
  const r = await Kyoot.runPromise(prog);
  assert.ok(!r.ok && r.cause._tag === "Fail" && r.cause.error === "bad");
  assert.deepEqual(events, ["release"]);
});

test("fork: a user effect handled outside the fork answers inside it", async () => {
  const Ask = effect<string, number>()("ask");
  const prog = Kyoot.gen(function* () {
    const fibers = yield* Async.all([Ask("a"), Ask("bb")]);
    return fibers;
  }).pipe(Ask.handle({ onOp: (q, resume) => resume(q.length) }));
  assert.deepEqual(await Kyoot.runPromise(prog), [1, 2]);
});

// ---------------------------------------------------------------------------
// A fiber yields to the event loop every few thousand steps.
// ---------------------------------------------------------------------------

const hotLoop = (n: number) =>
  Kyoot.gen(function* () {
    let acc = 0;
    for (let i = 0; i < n; i++) acc += yield* Kyoot.succeed(i);
    return acc;
  });

test("scheduler: a hot loop in one fiber does not starve a sleeper", async () => {
  const events: string[] = [];
  const prog = Kyoot.gen(function* () {
    const fiber = yield* Async.fork(hotLoop(300_000).map(() => void events.push("hot done")));
    yield* Clock.sleep(1);
    events.push("slept");
    yield* fiber.join;
  });
  await Kyoot.runPromise(prog);
  assert.deepEqual(events, ["slept", "hot done"]);
});

test("scheduler: a hot loop can be interrupted", async () => {
  const prog = Kyoot.gen(function* () {
    const fiber = yield* Async.fork(hotLoop(Infinity));
    yield* Clock.sleep(1);
    yield* fiber.interrupt;
    return yield* fiber.await;
  });
  const r = await Kyoot.runPromise(prog);
  assert.ok(!r.ok && r.cause._tag === "Interrupted");
});

test("scheduler: runSync never yields", () => {
  assert.equal(Kyoot.runSync(hotLoop(50_000)), (50_000 * 49_999) / 2);
});

test("scheduler: yields keep handler state and continuations", async () => {
  const prog = Kyoot.gen(function* () {
    for (let i = 0; i < 20_000; i++) yield* Log.info(String(i));
    return "done";
  }).pipe(Log.collect);
  const [a, entries] = await Kyoot.runPromise(prog);
  assert.equal(a, "done");
  assert.equal(entries.length, 20_000);
  assert.equal(entries[19_999]!.message, "19999");
});
