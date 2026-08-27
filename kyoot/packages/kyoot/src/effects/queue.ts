import type { Kyoot } from "../model.ts";
import type { AsyncOp } from "../runtime.ts";
import type { FailRow, MergeAll } from "../types.ts";
import { Result } from "../result.ts";
import * as Async from "./async.ts";
import * as Fail from "./fail.ts";
import * as Sync from "./sync.ts";

export class QueueShutdown {
  readonly _tag = "QueueShutdown";
}

type AsyncResult<A> = Kyoot<A, MergeAll<{ async: AsyncOp } | FailRow<QueueShutdown>>>;

export interface Queue<A> {
  offer(value: A): AsyncResult<void>;
  readonly take: AsyncResult<A>;
  tryOffer(value: A): Kyoot<boolean, { sync: () => unknown }>;
  readonly tryTake: Kyoot<A | undefined, { sync: () => unknown }>;
  readonly size: Kyoot<number, { sync: () => unknown }>;
  readonly shutdown: Kyoot<void, { sync: () => unknown }>;
  readonly isShutdown: Kyoot<boolean, { sync: () => unknown }>;
}

interface Taker<A> {
  readonly resolve: (result: Result<QueueShutdown, A>) => void;
}

interface Offerer<A> {
  readonly value: A;
  readonly resolve: (result: Result<QueueShutdown, void>) => void;
}

const remove = <A>(items: A[], item: A) => {
  const index = items.indexOf(item);
  if (index >= 0) items.splice(index, 1);
};

const make = <A>(capacity: number): Queue<A> => {
  const values: A[] = [];
  const takers: Taker<A>[] = [];
  const offerers: Offerer<A>[] = [];
  let closed = false;

  const admitOfferer = () => {
    const offerer = offerers.shift();
    if (!offerer) return;
    const taker = takers.shift();
    if (taker) taker.resolve(Result.ok(offerer.value));
    else values.push(offerer.value);
    offerer.resolve(Result.ok(undefined));
  };

  const tryOfferNow = (value: A) => {
    if (closed) return false;
    const taker = takers.shift();
    if (taker) {
      taker.resolve(Result.ok(value));
      return true;
    }
    if (values.length >= capacity) return false;
    values.push(value);
    return true;
  };

  const tryTakeNow = (): readonly [found: boolean, value: A | undefined] => {
    if (values.length > 0) {
      const value = values.shift()!;
      admitOfferer();
      return [true, value];
    }
    const offerer = offerers.shift();
    if (!offerer) return [false, undefined];
    offerer.resolve(Result.ok(undefined));
    return [true, offerer.value];
  };

  const offer = (value: A) =>
    Async.fromPromise<Result<QueueShutdown, void>>(
      (signal) =>
        new Promise((resolve) => {
          if (closed) {
            resolve(Result.fail(new QueueShutdown()));
            return;
          }
          if (tryOfferNow(value)) {
            resolve(Result.ok(undefined));
            return;
          }
          const offerer: Offerer<A> = {
            value,
            resolve: (result) => {
              signal.removeEventListener("abort", onAbort);
              resolve(result);
            },
          };
          const onAbort = () => remove(offerers, offerer);
          offerers.push(offerer);
          signal.addEventListener("abort", onAbort, { once: true });
        }),
    ).map(Fail.fromResult) as AsyncResult<void>;

  const take = Async.fromPromise<Result<QueueShutdown, A>>(
    (signal) =>
      new Promise((resolve) => {
        const [found, value] = tryTakeNow();
        if (found) {
          resolve(Result.ok(value as A));
          return;
        }
        if (closed) {
          resolve(Result.fail(new QueueShutdown()));
          return;
        }
        const taker: Taker<A> = {
          resolve: (result) => {
            signal.removeEventListener("abort", onAbort);
            resolve(result);
          },
        };
        const onAbort = () => remove(takers, taker);
        takers.push(taker);
        signal.addEventListener("abort", onAbort, { once: true });
      }),
  ).map(Fail.fromResult) as AsyncResult<A>;

  return {
    offer,
    take,
    tryOffer: (value) => Sync.defer(() => tryOfferNow(value)),
    tryTake: Sync.defer(() => {
      const [found, value] = tryTakeNow();
      return found ? value : undefined;
    }),
    size: Sync.defer(() => values.length),
    shutdown: Sync.defer(() => {
      if (closed) return;
      closed = true;
      const failure = Result.fail(new QueueShutdown());
      for (const taker of takers.splice(0)) taker.resolve(failure);
      for (const offerer of offerers.splice(0)) offerer.resolve(failure);
    }),
    isShutdown: Sync.defer(() => closed),
  };
};

/** A FIFO queue whose producers wait while `capacity` values are buffered. */
export const bounded = <A>(capacity: number): Kyoot<Queue<A>, { sync: () => unknown }> =>
  Sync.defer(() => {
    if (!Number.isInteger(capacity) || capacity < 0)
      throw new RangeError("Queue capacity must be a non-negative integer");
    return make<A>(capacity);
  });

export const unbounded = <A>(): Kyoot<Queue<A>, { sync: () => unknown }> =>
  Sync.defer(() => make<A>(Number.POSITIVE_INFINITY));
