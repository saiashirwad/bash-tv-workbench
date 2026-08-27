import { makeHandler, makeOp, succeed } from "../core.ts";
import type { AnyKyoot, Kyoot } from "../model.ts";
import type { AsyncOp } from "../runtime.ts";
import type { MergeAll, Row } from "../types.ts";
import * as Async from "./async.ts";
import * as Fail from "./fail.ts";

interface RunOp {
  readonly kind: "run";
  readonly body: AnyKyoot;
}

type SemaphoreRow<Id extends string> = {
  [K in `semaphore/${Id}`]: RunOp;
};

interface Waiter {
  status: "waiting" | "granted" | "cancelled" | "claimed";
  readonly resolve: (ticket: Ticket) => void;
  readonly signal: AbortSignal;
  readonly onAbort: () => void;
}

interface State {
  available: number;
  readonly waiters: Waiter[];
}

interface Ticket {
  claim(): boolean;
}

export interface Options {
  readonly permits: number;
}

export interface Tag<Id extends string> {
  readonly key: `semaphore/${Id}`;

  /** Describes running `body` after one permit has been admitted. */
  run<A, S extends Row>(body: Kyoot<A, S>): Kyoot<A, MergeAll<S | SemaphoreRow<Id>>>;

  /** Alias for `run`, for code that wants to emphasize permit ownership. */
  withPermit<A, S extends Row>(body: Kyoot<A, S>): Kyoot<A, MergeAll<S | SemaphoreRow<Id>>>;

  /** Supplies a fresh semaphore implementation each time the resulting program runs. */
  provide(
    options: Options,
  ): <A, S extends Row & Partial<SemaphoreRow<Id>>>(
    program: Kyoot<A, S>,
  ) => Kyoot<A, MergeAll<Omit<S, `semaphore/${Id}`> | { async: AsyncOp }>>;
}

const remove = <A>(items: A[], item: A) => {
  const index = items.indexOf(item);
  if (index >= 0) items.splice(index, 1);
};

const release = (state: State): void => {
  while (state.waiters.length > 0) {
    const waiter = state.waiters.shift()!;
    if (waiter.status !== "waiting") continue;
    waiter.status = "granted";
    waiter.resolve({
      claim: () => {
        if (waiter.status !== "granted") return false;
        waiter.status = "claimed";
        waiter.signal.removeEventListener("abort", waiter.onAbort);
        return true;
      },
    });
    return;
  }
  state.available++;
};

/**
 * Waits for a permit and returns a ticket that must be claimed by the resumed
 * continuation. The abort listener remains installed after promise resolution:
 * if interruption wins the runtime race before the continuation claims the
 * ticket, the permit is returned instead of being lost.
 */
const acquire = (state: State): Kyoot<Ticket, { async: AsyncOp }> =>
  Async.fromPromise(
    (signal) =>
      new Promise<Ticket>((resolve) => {
        let waiter!: Waiter;
        const onAbort = () => {
          if (waiter.status === "waiting") {
            waiter.status = "cancelled";
            remove(state.waiters, waiter);
          } else if (waiter.status === "granted") {
            waiter.status = "cancelled";
            release(state);
          }
        };
        waiter = { status: "waiting", resolve, signal, onAbort };
        signal.addEventListener("abort", onAbort, { once: true });

        if (signal.aborted) {
          onAbort();
          return;
        }
        if (state.available === 0) {
          state.waiters.push(waiter);
          return;
        }

        state.available--;
        waiter.status = "granted";
        resolve({
          claim: () => {
            if (waiter.status !== "granted") return false;
            waiter.status = "claimed";
            signal.removeEventListener("abort", onAbort);
            return true;
          },
        });
      }),
  );

/** Releases exactly once on success, typed failure, defect, or interruption. */
const scoped = <A, S extends Row>(body: Kyoot<A, S>, state: State): Kyoot<A, S> => {
  let held = true;
  const settle = () => {
    if (!held) return;
    held = false;
    release(state);
  };
  return makeHandler("fail", body, {
    onOp: (error) => {
      settle();
      return Fail.fail(error);
    },
    onSuccess: (value) => {
      settle();
      return succeed(value);
    },
    onDefect: (defect) => {
      settle();
      throw defect;
    },
    onInterrupt: settle,
  }) as Kyoot<A, S>;
};

export const tag = <const Id extends string>(id: Id): Tag<Id> => {
  const key = `semaphore/${id}` as const;
  const run = <A, S extends Row>(body: Kyoot<A, S>) =>
    makeOp(key, { kind: "run", body } satisfies RunOp) as Kyoot<A, MergeAll<S | SemaphoreRow<Id>>>;

  return {
    key,
    run,
    withPermit: run,
    provide: ({ permits }) => {
      if (!Number.isInteger(permits) || permits < 0)
        throw new RangeError("Semaphore permits must be a non-negative integer");

      return (program) =>
        makeHandler(key, program, {
          create: (): State => ({ available: permits, waiters: [] }),
          // Forked operations share admission state with their parent.
          fork: "copy",
          onOp: (operation: RunOp, resume, state) => {
            const admit = (): Kyoot<never, { async: AsyncOp }> =>
              acquire(state).map((ticket) =>
                ticket.claim() ? resume.with(scoped(operation.body, state)) : admit(),
              );
            return admit();
          },
        }) as never;
    },
  };
};
