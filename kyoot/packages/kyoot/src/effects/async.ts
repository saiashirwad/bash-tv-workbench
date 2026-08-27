import { inherit, InterruptedError, makeHandler, op, succeed, type Payload } from "../core.ts";
import { fail, fromResult } from "./fail.ts";
import { sleep } from "./clock.ts";
import { Result } from "../result.ts";
import type { AnyKyoot, Kyoot } from "../model.ts";
import type { AsyncOp, AsyncRuntime, FiberHandle, Served } from "../runtime.ts";
import type { FailRow, MergeAll, Row } from "../types.ts";

const asyncOp = <A>(execute: (rt: AsyncRuntime) => Promise<A>) =>
  op<A>()("async", { execute } as AsyncOp);

export const fromPromise = <A>(f: (signal: AbortSignal) => Promise<A>) =>
  asyncOp((rt) => f(rt.signal));

export const never = fromPromise<never>(() => new Promise(() => {}));

type FailOf<S> = Payload<S, "fail">;

// What a fiber leaves for the program that forks it: the driver serves
// `async` and `clock`, and a typed failure crosses `join` instead.
type Leftover<S extends Row> = Omit<S, Served | "fail">;

export interface Fiber<A, E = never> {
  readonly join: Kyoot<A, MergeAll<{ async: AsyncOp } | FailRow<E>>>;
  readonly await: Kyoot<Result<E, A>, { async: AsyncOp }>;
  readonly interrupt: Kyoot<void, { async: AsyncOp }>;
}

// A fiber's program ends in one of these; anything else means a handler
// copied into the fiber returned a value instead of resuming.
class Exit {
  readonly result: Result<unknown, unknown>;
  constructor(result: Result<unknown, unknown>) {
    this.result = result;
  }
}

const catchFail = (k: AnyKyoot): AnyKyoot =>
  makeHandler("fail", k, { fork: "none", onOp: (e) => succeed(new Exit(Result.fail(e))) });

// A fiber catches `fail` at both ends: innermost for the program, so a scope
// around it still ends normally, and outermost for a copied handler that
// fails in its own scope. `fail` handlers themselves never cross into a
// fiber; the failure crosses `join` and meets the handlers there.
const spawn = (rt: AsyncRuntime, k: AnyKyoot) => {
  const program = catchFail(k.map((a: unknown) => new Exit(Result.ok(a))));
  const handlers = rt.handlers?.filter((h) => h.effectKey !== "fail");
  return rt.spawn(catchFail(inherit(program, handlers)));
};

const outcome = <A, E>(h: FiberHandle): Promise<Result<E, A>> =>
  h.promise.then(
    (v) =>
      v instanceof Exit
        ? (v.result as Result<E, A>)
        : Result.defect(
            new Error(
              'a handler copied into a fiber returned a value instead of resuming; give it fork: "none"',
            ),
          ),
    (e: unknown) => (e instanceof InterruptedError ? Result.interrupted() : Result.defect(e)),
  );

const fiber = <A, E>(h: FiberHandle): Fiber<A, E> => ({
  join: asyncOp(() => outcome<A, E>(h)).map(fromResult) as never,
  await: asyncOp(() => outcome<A, E>(h)),
  interrupt: asyncOp(async () => h.interrupt()),
});

const settle = (fibers: ReadonlyArray<FiberHandle>) =>
  Promise.allSettled(fibers.map((f) => (f.interrupt(), f.promise)));

// The fiber inherits the handlers around the fork, so the child's row is
// pushed onto the parent's: handle `env/db` outside the fork and the fiber
// sees it.
export const fork = <A, S extends Row>(
  k: Kyoot<A, S>,
): Kyoot<Fiber<A, FailOf<S>>, MergeAll<{ async: AsyncOp } | Leftover<S>>> =>
  asyncOp((rt) => Promise.resolve(fiber(spawn(rt, k)))) as never;

export const race = <A, B, S1 extends Row, S2 extends Row>(
  a: Kyoot<A, S1>,
  b: Kyoot<B, S2>,
): Kyoot<
  A | B,
  MergeAll<{ async: AsyncOp } | Leftover<S1> | Leftover<S2> | FailRow<FailOf<S1> | FailOf<S2>>>
> =>
  asyncOp((rt) => {
    const fibers = [spawn(rt, a), spawn(rt, b)];
    return Promise.race(fibers.map(outcome)).finally(() => settle(fibers));
  }).map(fromResult) as never;

export const all = <A, S extends Row = {}>(
  ks: ReadonlyArray<Kyoot<A, S>>,
  options: { readonly concurrency?: number } = {},
): Kyoot<A[], MergeAll<{ async: AsyncOp } | Leftover<S> | FailRow<FailOf<S>>>> =>
  asyncOp(async (rt): Promise<Result<unknown, A[]>> => {
    const concurrency = options.concurrency ?? ks.length;
    const workers = Math.min(
      ks.length,
      Math.max(1, Number.isNaN(concurrency) ? ks.length : Math.floor(concurrency)),
    );
    const results: A[] = new Array(ks.length);
    const fibers: FiberHandle[] = [];
    let next = 0;
    let stopped: Result<unknown, A[]> | undefined;
    const worker = async () => {
      while (stopped === undefined && next < ks.length) {
        const i = next++;
        const f = spawn(rt, ks[i]!);
        fibers.push(f);
        const r = await outcome<A, unknown>(f);
        if (r.ok) {
          results[i] = r.value;
          continue;
        }
        // The first failure wins; the branches still running are interrupted now.
        if (stopped === undefined) {
          stopped = r;
          for (const other of fibers) other.interrupt();
        }
      }
    };
    await Promise.all(Array.from({ length: workers }, worker));
    if (stopped === undefined) return Result.ok(results);
    await settle(fibers);
    return stopped;
  }).map(fromResult) as never;

export class Timeout {
  readonly _tag = "Timeout";
  readonly ms: number;
  constructor(ms: number) {
    this.ms = ms;
  }
}

const timedOut = Symbol("timeout");

export const timeout = <A, S extends Row>(ms: number, k: Kyoot<A, S>) =>
  race(
    k,
    sleep(ms).map(() => timedOut),
  ).map((r) => (r === timedOut ? fail(new Timeout(ms)) : succeed(r as A)));
