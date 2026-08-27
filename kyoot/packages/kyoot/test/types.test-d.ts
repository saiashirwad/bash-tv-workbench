import {
  Async,
  Clock,
  effect,
  Emit,
  Env,
  Fail,
  Kyoot,
  makeHandler,
  op,
  Resource,
  Retry,
  Semaphore,
  Sync,
  Var,
} from "../src/index.ts";
import type { AsyncOp, Kyoot as KyootT, Result, RowsOf } from "../src/index.ts";

type Expect<T extends true> = T;
type Equal<A, B> = [A] extends [B] ? ([B] extends [A] ? true : false) : false;

class FetchFailed {
  readonly _tag = "FetchFailed";
}

interface Greeter {
  greet(name: string): string;
}
const Greeter = Env.tag<Greeter>()("greeter");

const Total = Var.tag<number>()("Total");

const mixed = Kyoot.gen(function* () {
  yield* Fail.fail(new FetchFailed());
  yield* Async.fromPromise(() => Promise.resolve(1));
  yield* Clock.sleep(1);
  yield* Sync.defer(() => 1);
  return "done";
});
type MixedRows = RowsOf<typeof mixed>;
type _mixedKeys = Expect<Equal<keyof MixedRows, "fail" | "async" | "clock" | "sync">>;
type _mixedFail = Expect<Equal<MixedRows["fail"], FetchFailed>>;
// the row value is the op's payload type
type _mixedAsync = Expect<Equal<MixedRows["async"], AsyncOp>>;
type _mixedSync = Expect<Equal<MixedRows["sync"], () => unknown>>;
type _mixedClock = Expect<Equal<MixedRows["clock"], number>>;
type _mixedValue = Expect<Equal<typeof mixed extends KyootT<infer A, any> ? A : never, string>>;

// @ts-expect-error runSync rejects clock rows; runPromise serves them
Kyoot.runSync(Clock.sleep(1));
const slept: Promise<void> = Kyoot.runPromise(Clock.sleep(1));

// @ts-expect-error runSync names every unhandled key: Unhandled<"fail" | "async" | "clock" | "sync">
Kyoot.runSync(mixed);

const syncProg = Sync.defer(() => 1);
// @ts-expect-error runSync requires an empty row
Kyoot.runSync(syncProg);
const s1: number = Kyoot.runSync(syncProg.pipe(Sync.run));

const p1: Promise<number> = Kyoot.runPromise(Async.fromPromise(() => Promise.resolve(1)));

// @ts-expect-error runPromise rejects rows the driver cannot satisfy
Kyoot.runPromise(Fail.fail(new FetchFailed()));

const fp = Async.fromPromise((signal) => fetch("https://example.com", { signal }));
type _fpKeys = Expect<Equal<keyof RowsOf<typeof fp>, "async">>;
type _fpValue = Expect<Equal<typeof fp extends KyootT<infer A, any> ? A : never, Response>>;

// the branches run in fibers, whose driver serves `clock`, so it does not surface
const timed = Async.timeout(100, Clock.sleep(1));
type _timedKeys = Expect<Equal<keyof RowsOf<typeof timed>, "async" | "fail">>;
type _timedFail = Expect<Equal<RowsOf<typeof timed>["fail"], Async.Timeout>>;

const greeted = Kyoot.gen(function* () {
  const g = yield* Greeter;
  return g.greet("kyoot");
}).pipe(Greeter.provide({ greet: (n) => `hi ${n}` }));
const g1: string = Kyoot.runSync(greeted);
// @ts-expect-error provide returns A, not a tuple
const g2: [string, Greeter] = Kyoot.runSync(greeted);

const handled = Kyoot.gen(function* () {
  yield* Fail.fail(new FetchFailed());
  return 1;
}).pipe(Fail.run);
const f1: Result<FetchFailed, number> = Kyoot.runSync(handled);

const counted = Kyoot.gen(function* () {
  yield* Total.update((t) => t + 1);
  return yield* Total.get();
}).pipe(Total.run(0));
const v1: readonly [number, number] = Kyoot.runSync(counted);

const emitted = Kyoot.gen(function* () {
  yield* Emit.value("a");
  return 1;
}).pipe(Emit.collect);
const e1: readonly [number, string[]] = Kyoot.runSync(emitted);

const logOp = op<void>()("log", "hello");
type _logKeys = Expect<Equal<keyof RowsOf<typeof logOp>, "log">>;
type _logPayload = Expect<Equal<RowsOf<typeof logOp>["log"], string>>;
// @ts-expect-error runSync names the unhandled custom effect: Unhandled<"log">
Kyoot.runSync(logOp);

// effect: a declared op with a typed answer; handle() infers the wrapper.
const Ask = effect<{ q: string }, number>()("ask");
const asked = Ask({ q: "n?" }).map((n) => n + 1);
type _askRow = Expect<Equal<RowsOf<typeof asked>, { ask: { q: string } }>>;
const answered: number = asked.pipe(
  Ask.handle({ onOp: ({ q }, resume) => resume(q.length) }),
  Kyoot.runSync,
);
// @ts-expect-error resume is typed to the answer
Ask.handle({ onOp: (_p, resume) => resume("no") });
// @ts-expect-error the payload is typed by the declaration
Ask.handle({ onOp: ({ nope }, resume) => resume(1) });
// a handler that fails instead of resuming adds `fail` to the row
const refused = asked.pipe(Ask.handle({ onOp: () => Fail.fail("refused" as const) }));
type _refusedRow = Expect<Equal<keyof RowsOf<typeof refused>, "fail">>;
// a handler that returns instead of resuming adds its value to the result
const cached = asked.pipe(Ask.handle({ onOp: () => Kyoot.succeed("cached" as const) }));
type _cachedValue = Expect<Equal<ValueOf<typeof cached>, number | "cached">>;

const clockProg = Clock.sleep(5).pipe(Clock.virtual);
const c1: readonly [void, number] = Kyoot.runSync(clockProg);

// A semaphore tag describes admission; provide selects the implementation and capacity.
const AgentSlot = Semaphore.tag("agent-slot");
const limited = AgentSlot.run(Clock.sleep(1).map(() => 1));
type _limitedKeys = Expect<Equal<keyof RowsOf<typeof limited>, "clock" | "semaphore/agent-slot">>;
// @ts-expect-error the tagged semaphore still needs its provider
Kyoot.runPromise(limited);
const admitted = limited.pipe(AgentSlot.provide({ permits: 2 }));
type _admittedKeys = Expect<Equal<keyof RowsOf<typeof admitted>, "async" | "clock">>;
const admittedValue: Promise<number> = Kyoot.runPromise(admitted);
const aliasLimited = AgentSlot.withPermit(Kyoot.succeed("ok" as const));
type _aliasLimitedKeys = Expect<Equal<keyof RowsOf<typeof aliasLimited>, "semaphore/agent-slot">>;
const aliasValue: Promise<"ok"> = Kyoot.runPromise(
  aliasLimited.pipe(AgentSlot.provide({ permits: 1 })),
);

// Retry keeps the failure and adds the clock; the value type is unchanged.
const retried = Kyoot.gen(function* () {
  yield* Fail.fail(new FetchFailed());
  return 1;
}).pipe(Retry.run({ times: 3, delay: 10 }));
type _retryKeys = Expect<Equal<keyof RowsOf<typeof retried>, "fail" | "clock">>;
type _retryFail = Expect<Equal<RowsOf<typeof retried>["fail"], FetchFailed>>;
type _retryValue = Expect<Equal<ValueOf<typeof retried>, number>>;

// pure map (including throw → never) must keep the effect row; no Row pollution
const pureMapped = Async.fromPromise(() => Promise.resolve()).map((_) => 1);
type _pureMapKeys = Expect<Equal<keyof RowsOf<typeof pureMapped>, "async">>;
type _pureMapValue = Expect<
  Equal<typeof pureMapped extends KyootT<infer A, any> ? A : never, number>
>;

const neverMapped = Async.fromPromise(() => Promise.resolve()).map(() => {
  throw new Error("boom");
});
type _neverMapKeys = Expect<Equal<keyof RowsOf<typeof neverMapped>, "async">>;
// fork accepts a pure-mapped body (Only<"async">, not a widened Row)
const forked = Async.fork(neverMapped);
type _forkKeys = Expect<Equal<keyof RowsOf<typeof forked>, "async">>;

// nested Kyoot from map still flattens and merges rows
const flatMapped = Kyoot.succeed(1).map((n) => Fail.fail(String(n)));
type _flatKeys = Expect<Equal<keyof RowsOf<typeof flatMapped>, "fail">>;
type _flatFail = Expect<Equal<RowsOf<typeof flatMapped>["fail"], string>>;

// ---------------------------------------------------------------------------
// Handler result types are inferred by makeHandler, not annotated.
// ---------------------------------------------------------------------------
import type { DefectCause, Err, FailCause, Ok } from "../src/index.ts";
type ValueOf<K> = K extends KyootT<infer A, any> ? A : never;

// Fail.run: a union of the branches its callbacks build — which is a Result.
type _failRunValue = Expect<
  Equal<ValueOf<typeof handled>, Ok<number> | Err<FailCause<FetchFailed>> | Err<DefectCause>>
>;
type _failRunKeys = Expect<Equal<keyof RowsOf<typeof handled>, never>>;

// catchAll: the recovery's value and row join the result.
const recovered = Kyoot.gen(function* () {
  yield* Fail.fail(new FetchFailed());
  return 1;
}).pipe(Fail.catchAll(() => Clock.sleep(1).map(() => "fallback" as const)));
type _catchAllValue = Expect<Equal<ValueOf<typeof recovered>, number | "fallback">>;
type _catchAllKeys = Expect<Equal<keyof RowsOf<typeof recovered>, "clock">>;

// A handler whose onOp runs an async op adds `async` to the row.
const slowSync = Sync.defer(() => 1).pipe((k) =>
  makeHandler("sync", k, {
    onOp: (f, resume) => Clock.sleep(1).map(() => resume(f())), // f: () => unknown, from the row
    onInterrupt: () => Async.fromPromise(() => Promise.resolve()),
  }),
);
type _asyncHandlerValue = Expect<Equal<ValueOf<typeof slowSync>, number>>;
type _asyncHandlerKeys = Expect<Equal<keyof RowsOf<typeof slowSync>, "async" | "clock">>;

// catchTag removes only the handled tag from the fail row
class Tagged1 {
  readonly _tag = "One";
}
class Tagged2 {
  readonly _tag = "Two";
}
declare const flag: boolean;
const twoFails = Kyoot.gen(function* () {
  if (flag) yield* Fail.fail(new Tagged1());
  yield* Fail.fail(new Tagged2());
  return 1;
});
const oneLeft = twoFails.pipe(Fail.catchTag("One", () => Kyoot.succeed("r" as const)));
type _oneLeftFail = Expect<Equal<RowsOf<typeof oneLeft>["fail"], Tagged2>>;
type _oneLeftValue = Expect<Equal<ValueOf<typeof oneLeft>, number | "r">>;
const noneLeft = oneLeft.pipe(Fail.catchTag("Two", () => Kyoot.succeed(0)));
type _noneLeftKeys = Expect<Equal<keyof RowsOf<typeof noneLeft>, never>>;

// streams are programs that emit; the consumer's effects join the row
const tokens = Emit.fromIterable(["a", "b"]);
type _tokensRow = Expect<Equal<RowsOf<typeof tokens>, { emit: string }>>;
const mapped = tokens.pipe(Emit.map((t: string) => t.length));
type _mappedEmit = Expect<Equal<RowsOf<typeof mapped>["emit"], number>>;
const consumed = mapped.pipe(Emit.forEach((n: number) => Clock.sleep(n)));
type _consumedKeys = Expect<Equal<keyof RowsOf<typeof consumed>, "clock">>;
const iter: AsyncIterable<number> = Emit.toAsyncIterable(mapped);

// a program finalizer's effects join the row when the resource is run
const scoped = Resource.acquire(
  () => 1,
  () => Clock.sleep(1),
).pipe(Resource.run);
type _scopedKeys = Expect<Equal<keyof RowsOf<typeof scoped>, "clock">>;
const plainScoped = Resource.acquire(
  () => 1,
  () => {},
).pipe(Resource.run);
type _plainScopedKeys = Expect<Equal<keyof RowsOf<typeof plainScoped>, never>>;

// ---------------------------------------------------------------------------
// Fibers inherit the handlers around the fork: the fiber's row is pushed onto
// the parent's, and a typed failure crosses join.
// ---------------------------------------------------------------------------
const needsGreeter = Kyoot.gen(function* () {
  const g = yield* Greeter;
  if (g.greet("x") === "") yield* Fail.fail(new FetchFailed());
  yield* Clock.sleep(1);
  return 1;
});
const forkedNeedy = Async.fork(needsGreeter);
// env stays for the parent; clock and fail do not (the driver serves clock, join carries fail)
type _forkNeedyKeys = Expect<Equal<keyof RowsOf<typeof forkedNeedy>, "async" | "env/greeter">>;
type NeedyFiber = ValueOf<typeof forkedNeedy>;
type _joinKeys = Expect<Equal<keyof RowsOf<NeedyFiber["join"]>, "async" | "fail">>;
type _joinFail = Expect<Equal<RowsOf<NeedyFiber["join"]>["fail"], FetchFailed>>;
type _joinValue = Expect<Equal<ValueOf<NeedyFiber["join"]>, number>>;
type _awaitValue = Expect<Equal<ValueOf<NeedyFiber["await"]>, Result<FetchFailed, number>>>;

// a fiber that cannot fail has no fail key on join
type PureFiber = ValueOf<typeof forked>;
type _pureJoinKeys = Expect<Equal<keyof RowsOf<PureFiber["join"]>, "async">>;

// the parent handles what the fiber needs, around the fork
const joined = Kyoot.gen(function* () {
  const fiber = yield* Async.fork(needsGreeter);
  return yield* fiber.join;
}).pipe(Greeter.provide({ greet: (n) => n }), Fail.run);
const j1: Promise<Result<FetchFailed, number>> = Kyoot.runPromise(joined);

// race and all merge the branches' leftover rows and failures
const raced = Async.race(needsGreeter, Fail.fail("other" as const));
type _raceKeys = Expect<Equal<keyof RowsOf<typeof raced>, "async" | "env/greeter" | "fail">>;
type _raceFail = Expect<Equal<RowsOf<typeof raced>["fail"], FetchFailed | "other">>;
const allOf = Async.all([needsGreeter, needsGreeter]);
type _allKeys = Expect<Equal<keyof RowsOf<typeof allOf>, "async" | "env/greeter" | "fail">>;
type _allValue = Expect<Equal<ValueOf<typeof allOf>, number[]>>;
const none = Async.all([]);
type _noneKeys = Expect<Equal<keyof RowsOf<typeof none>, "async">>;

// a handler may say what it does at a fork
const Ask2 = effect<string, number>()("ask2");
Ask2.handle({ fork: "none", onOp: (_q, resume) => resume(1) });
Ask2.handle({
  fork: "scope",
  create: () => [] as string[],
  onOp: (q, resume, seen) => resume(seen.push(q)),
});
// @ts-expect-error fork takes one of the three modes
Ask2.handle({ fork: "share", onOp: (_q, resume) => resume(1) });
