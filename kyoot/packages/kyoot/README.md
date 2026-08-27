# kyoot

Algebraic effects for TypeScript. A program is a value whose type lists the effects it uses. You handle them one at a time with `pipe`, and run the program once the list is empty.

```ts
import { Env, Fail, Kyoot, Sync } from "kyoot";

const Db = Env.tag<{ find(id: string): string | undefined }>()("db");

class NotFound {
  readonly _tag = "NotFound";
}

const lookup = (id: string) =>
  Kyoot.gen(function* () {
    const db = yield* Db;
    const name = yield* Sync.defer(() => db.find(id));
    if (name === undefined) return yield* Fail.fail(new NotFound());
    return name;
  });
// Kyoot<string, { "env/db": { find: ... }; fail: NotFound; sync: () => unknown }>

const result = lookup("42").pipe(
  Db.provide({ find: (id) => (id === "42" ? "douglas" : undefined) }),
  Fail.run,
  Sync.run,
  Kyoot.runSync,
);
// Result<NotFound, string>, here { ok: true, value: "douglas" }
```

The second type parameter is the row: one key per effect still to handle. `runSync` and `runPromise` reject a program with keys left, and the error names them:

```ts
Kyoot.runSync(lookup("42"));
// Type error: Unhandled<"env/db" | "fail" | "sync">
```

## Effects and handlers

An effect is a key, a payload type, and an answer type. Calling it performs an op.

```ts
const Log = effect<string, void>()("log");
Log("hello");
// Kyoot<void, { log: string }>
```

A handler catches one key and resumes the program. `resume` is typed to the answer; `resume(value)` continues with a value, `resume.with(program)` with a computation run where the op was.

```ts
const printLogs = Log.handle({
  onOp: (line, resume) => Sync.defer(() => console.log(line)).map(resume),
});
// <A, S>(k: Kyoot<A, S>) => Kyoot<A, Omit<S, "log"> & { sync: () => unknown }>
```

`intercept` sits between the program and the handlers outside it. It gets the payload and a `next` that performs the op again for them to answer; whatever it returns is delivered where the op was performed. A cache, a sandbox, or a system prompt is an intercept.

```ts
const Fetch = effect<string, string>()("fetch");
const program = Fetch("hot");
const cache = Fetch.intercept((url, next) => (url === "hot" ? Kyoot.succeed("cached") : next(url)));
const live = Fetch.handle({ onOp: (url, resume) => resume(`fetched ${url}`) });
program.pipe(cache, live);
```

`makeHandler` is the full form. It can carry state — `initial`, threaded through `resume`, or `create()`, a cell made fresh per run — and reshape the final value with `onSuccess`. `Clock.virtual` is a handler with state:

```ts
const virtual = <A, S extends Row & { clock?: number }>(k: Kyoot<A, S>) =>
  makeHandler("clock", k, {
    initial: 0,
    onOp: (ms, resume, now) => resume(undefined, now + ms),
    onSuccess: (a, now) => Kyoot.succeed([a, now] as const),
  });
// Kyoot<readonly [A, number], Omit<S, "clock">>
```

The row is a plain object type: each key maps to its payload type. `yield*` unions rows, a handler removes its key, and `RowsOf<typeof program>` reads it back.

## Built-in effects

| Module      | Ops                                                                     | Handlers                                                                         |
| ----------- | ----------------------------------------------------------------------- | -------------------------------------------------------------------------------- |
| `Fail`      | `fail(e)`                                                               | `run` (to `Result`), `catchAll(f)`, `catchTag(tag, f)`, `mapError(f)`, `orThrow` |
| `Env`       | `tag<T>()("id").get()`                                                  | `tag.provide(impl)`                                                              |
| `Var`       | `tag.get()`, `tag.set(v)`, `tag.update(f)`                              | `tag.run(initial)` (to `[A, V]`)                                                 |
| `Log`       | `info(msg)`, `warn`, `error`, `debug`                                   | `print`, `collect` (to `[A, Entry[]]`), `discard`                                |
| `Random`    | `next()`, `int(max)`                                                    | `live`, `seeded(seed)`                                                           |
| `Emit`      | `value(e)`, `fromIterable(xs)`, `fromAsyncIterable(xs)`                 | `collect` (to `[A, E[]]`), `forEach(f)`, `map(f)`, `discard`, `toAsyncIterable`  |
| `Sync`      | `defer(() => x)`                                                        | `run`                                                                            |
| `Resource`  | `acquire(open, close)`                                                  | `run`                                                                            |
| `Clock`     | `sleep(ms)`                                                             | `virtual` (to `[A, elapsedMs]`), served by `Kyoot.runPromise`                    |
| `Retry`     |                                                                         | `run({ times, delay, while })`                                                   |
| `Async`     | `fromPromise(f)`, `fork`, `race`, `all(ks, { concurrency })`, `timeout` | served by `Kyoot.runPromise`; `timeout` can fail with `Timeout`                  |
| `Deferred`  | `make()`, then `await`, `succeed`, `fail`                               | interruptible single-assignment values shared by fibers                          |
| `Queue`     | `bounded(n)`, `unbounded()`, then `offer`, `take`, `shutdown`           | FIFO backpressure, rendezvous queues, interruption-safe waiters                  |
| `Ref`       | `make(a)`, then `get`, `set`, `update`, `modify`                        | shared atomic state; unlike `Var`, updates are visible across fibers             |
| `Semaphore` | `tag(id).run(body)`, `withPermit(body)`                                 | `tag.provide({ permits })`; FIFO, interruption-safe admission                    |

Tags are keyed by id: `Env.tag<A>()("a")` and `Env.tag<B>()("b")` are separate keys. `Env` hands out a constant; `Var` threads state.

`Resource.run` releases in reverse order on success, defect, or interrupt. `close` may return a program, so a finalizer can do async work. A finalizer that throws never hides a defect or an interrupt. After a success it is raised — and a typed failure that `Fail.run` inside has already turned into a `Result` counts as a success.

`Clock.sleep` runs on real timers under `runPromise` unless a handler is closer. `Clock.virtual` makes every sleep instant and reports the elapsed time, so a program that waits can run under `runSync` in tests.

`Retry.run` re-runs a program on a typed failure, sleeping between attempts (`delay` is a number or `(attempt) => ms`). Set `while` to retry only some failures. Defects are not retried; the last failure stays in the row.

## Semaphores

A semaphore tag describes an admission requirement without choosing its capacity or owning mutable state. Supply the implementation at the edge with `provide`:

```ts
const PiStartup = Semaphore.tag("pi-startup");

const start = (job: Job) => PiStartup.run(startPi(job));

await Async.all(jobs.map(start)).pipe(PiStartup.provide({ permits: 1 }), Kyoot.runPromise);
```

`withPermit(body)` is an alias for `run(body)`. The permit is returned when the body succeeds, fails, defects, or is interrupted. Waiters are admitted FIFO, and interrupting a waiter removes it without consuming a permit. Each execution of a provided program receives fresh semaphore state, shared by fibers forked beneath that provider.

Semaphores are strict and non-reentrant: nesting the same tag while already holding its only permit waits like any other acquisition. Use distinct tags for independent limits—for example, five active turns and one cold start:

```ts
const ActiveTurn = Semaphore.tag("active-turn");
const ColdStart = Semaphore.tag("cold-start");

const runAgent = (job: Job) =>
  ActiveTurn.run(ColdStart.run(openPi(job)).map((session) => runTurn(session, job)));

const main = Async.all(jobs.map(runAgent)).pipe(
  ActiveTurn.provide({ permits: 5 }),
  ColdStart.provide({ permits: 1 }),
);
```

The semaphore differs deliberately from Scala Kyo's concrete `Meter`: Kyo constructs a `Meter` value and calls `meter.run(body)`, while Kyoot's tag leaves the policy visible in the effect row and installs capacity in the pipe chain. The `run(body)` vocabulary follows Kyo's `Meter`; rate limiting, load shedding, and meter pipelines remain separate future policies rather than hidden semaphore behavior.

## Streams

A stream is a program that emits. `Emit.fromAsyncIterable` turns an async source into one; `Emit.map` and `Emit.forEach` transform and consume it, and a `forEach` callback may return a program, whose effects join the row. `Emit.toAsyncIterable(k, { buffer })` runs it in a fiber and hands values out as they arrive; the producer runs at most `buffer` values ahead (16 by default, 1 is pull), and breaking out of the loop interrupts it.

## Async

`runPromise` serves `async` and `clock` itself and knows nothing about any other effect.

```ts
const main = Kyoot.gen(function* () {
  const fast = yield* Async.race(fetchUser("a"), fetchUser("b"));
  const fiber = yield* Async.fork(slowJob);
  const result = yield* Async.timeout(5000, fiber.join).pipe(Fail.run);
  return [fast, result];
});

await Kyoot.runPromise(main);
```

`fork` returns a fiber with `join`, `await` (a `Result`), and `interrupt`. A fiber inherits the handlers around the fork, so the forked program's row lands on the parent's: fork something that needs `env/db`, and the `provide` outside the fork answers inside it. The fiber keeps only `async` and `clock`, which its driver serves; a typed failure crosses `join` (`Fiber<A, E>`). `race`, `all`, and `timeout` merge their branches' rows the same way. `all` runs all branches at once by default; set `concurrency` to limit them. If time runs out, `timeout` fails with `Timeout`.

```ts
const main = Kyoot.gen(function* () {
  const fiber = yield* Async.fork(lookup("42")); // needs env/db, may fail with NotFound
  return yield* fiber.join; // fail: NotFound, here
}).pipe(Db.provide(db), Fail.run, Sync.run);
```

A handler says what it does at a fork with `fork`:

- `"copy"` (default): the fiber gets `onOp` with the frame's state. A `create` cell is shared, so `Log.collect` and `Emit.collect` see the fiber's output; threaded state is a snapshot, so a `Var` set in a fiber is not seen after `join`.
- `"scope"`: the fiber gets a frame of its own, with `onSuccess` at its end. `Resource.run` does this, so each fiber has its own scope.
- `"none"`: the handler stops at the fiber.

`fail` handlers never cross into a fiber: the failure crosses `join` and meets the handlers there.

Interrupting a fiber interrupts its children and runs their finalizers; once an interrupt is delivered, the ops that follow are cleanup and run to completion. `fromPromise` passes an `AbortSignal`; give it to `fetch` and an interrupt cancels the request. A fiber yields to the event loop every few thousand steps, so a hot loop neither starves other fibers nor blocks its own interrupt (a loop inside one `Sync.defer` is one step). `runSync` never yields.

## Your own effect

Declare one `effect` and one handler per interpretation. `examples/checkout.ts` does this for a business program: `Inventory` and `Payments` are effects; the handlers are an in-memory stock table and a test double.

A handler may fail instead of resuming. The failure then belongs to the handler's scope and shows up in the row at that step; the program inside cannot catch it.

```ts
const Payments = effect<Charge, string>()("payments");
const declineAll = (reason: string) =>
  Payments.handle({ onOp: () => Fail.fail(new PaymentDeclined(reason)) });
```

When the failure is part of the effect's contract, declare it as the third type argument and hand it back with `resume.with`. It is raised where the op was performed, so the program's own `catchTag` sees it.

```ts
const Payments = effect<Charge, string, PaymentDeclined>()("payments");
const declineAll = (reason: string) =>
  Payments.handle({ onOp: (_, resume) => resume.with(Fail.fail(new PaymentDeclined(reason))) });
```

`op<A>()(key, payload)` is the one-off form underneath `effect`, for ops whose payload type varies per call.

`examples/service.ts` shows the shape for a service library: the model call and search are effects; providers and test doubles are handlers that may retry, stream tokens with `Emit`, log, and fail with a typed error, each showing in the row at the step that adds it. See `@kyoot/ai` for the real AI library.

## Rules

- `resume` works once; a second call throws.
- A thrown exception is a defect: it skips `onOp` and goes to the nearest `onDefect`, or out of `runSync`. Use `Fail` for errors you expect.
- A handler that does not resume drops the rest of the program, so handlers inside it never finish. Put `Fail.run` inside `Resource.run`; the other order leaves resources open on failure.
- A handler that returns a value instead of resuming must be `fork: "none"`, since a fiber's value is its own. A copy that does so anyway is reported as a defect.
- A handler's `onInterrupt` hook may return a program. Its effects join the handler's row.

## Name

After [Kyo](https://getkyo.io), the Scala library whose effect model this follows.

## License

MIT
