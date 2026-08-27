import type { Kyoot } from "../model.ts";
import type { AsyncOp } from "../runtime.ts";
import type { FailRow, MergeAll } from "../types.ts";
import { Result } from "../result.ts";
import * as Async from "./async.ts";
import * as Fail from "./fail.ts";
import * as Sync from "./sync.ts";

export interface Deferred<A, E = never> {
  readonly await: Kyoot<A, MergeAll<{ async: AsyncOp } | FailRow<E>>>;
  succeed(value: A): Kyoot<boolean, { sync: () => unknown }>;
  fail(error: E): Kyoot<boolean, { sync: () => unknown }>;
  readonly done: Kyoot<boolean, { sync: () => unknown }>;
}

/** A single-assignment value. Interrupting a waiter does not complete the deferred. */
export const make = <A, E = never>(): Kyoot<Deferred<A, E>, { sync: () => unknown }> =>
  Sync.defer(() => {
    let result: Result<E, A> | undefined;
    const waiters = new Set<(result: Result<E, A>) => void>();

    const complete = (next: Result<E, A>) => {
      if (result !== undefined) return false;
      result = next;
      for (const resume of waiters) resume(next);
      waiters.clear();
      return true;
    };

    const awaitResult = Async.fromPromise<Result<E, A>>(
      (signal) =>
        new Promise((resolve) => {
          if (result !== undefined) {
            resolve(result);
            return;
          }
          const resume = (next: Result<E, A>) => {
            signal.removeEventListener("abort", onAbort);
            resolve(next);
          };
          const onAbort = () => waiters.delete(resume);
          waiters.add(resume);
          signal.addEventListener("abort", onAbort, { once: true });
        }),
    ).map(Fail.fromResult) as Kyoot<A, MergeAll<{ async: AsyncOp } | FailRow<E>>>;

    return {
      await: awaitResult,
      succeed: (value) => Sync.defer(() => complete(Result.ok(value))),
      fail: (error) => Sync.defer(() => complete(Result.fail(error))),
      done: Sync.defer(() => result !== undefined),
    };
  });
