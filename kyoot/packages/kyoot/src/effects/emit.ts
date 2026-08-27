import { isKyoot, makeHandler, op, succeed } from "../core.ts";
import { gen } from "../gen.ts";
import type { Kyoot, RowOf } from "../model.ts";
import { runFiber, type Served } from "../runtime.ts";
import type { MergeAll, Only, Row } from "../types.ts";
import * as Async from "./async.ts";

export const value = <E>(e: E) => op<void>()("emit", e);

export const fromIterable = <E>(items: Iterable<E>) =>
  gen(function* () {
    for (const e of items) yield* value(e);
  });

export const fromAsyncIterable = <E>(items: AsyncIterable<E>) =>
  gen(function* () {
    const it = items[Symbol.asyncIterator]();
    while (true) {
      const r = yield* Async.fromPromise(async (signal) => {
        const onAbort = () => void it.return?.();
        signal.addEventListener("abort", onAbort, { once: true });
        try {
          return await it.next();
        } finally {
          signal.removeEventListener("abort", onAbort);
        }
      });
      if (r.done) return;
      yield* value(r.value);
    }
  });

// The list is a cell made per run, so fibers forked under the handler emit
// into the same list.
export const collect = <A, S extends Row & { emit?: unknown }>(k: Kyoot<A, S>) =>
  makeHandler("emit", k, {
    create: () => [] as Array<S["emit"]>,
    onOp: (e, resume, acc) => {
      acc.push(e);
      return resume(undefined);
    },
    onSuccess: (a, acc) => succeed([a, acc] as const),
  });

export const forEach =
  <E, R>(f: (e: E) => R) =>
  <A, S extends Row & { emit?: E }>(
    k: Kyoot<A, S>,
  ): Kyoot<A, MergeAll<Omit<S, "emit"> | RowOf<R>>> =>
    makeHandler("emit", k, {
      onOp: (e, resume) => {
        const r = f(e as E);
        return isKyoot(r) ? r.map(() => resume(undefined)) : resume(undefined);
      },
    }) as never;

export const map =
  <E, E2>(f: (e: E) => E2) =>
  <A, S extends Row & { emit?: E }>(k: Kyoot<A, S>) =>
    makeHandler("emit", k, {
      onOp: (e, resume) => value(f(e as E)).map(() => resume(undefined)),
    });

export const discard = <A, S extends Row & { emit?: unknown }>(k: Kyoot<A, S>) =>
  makeHandler("emit", k, { onOp: (_e, resume) => resume(undefined) });

// Runs the producer in a fiber and hands its values out as they arrive. The
// producer runs at most `buffer` values ahead of the consumer; past that it
// parks until the consumer takes one. Breaking out of the loop interrupts it.
export const toAsyncIterable = <S extends Row & { emit?: unknown }>(
  k: Kyoot<unknown, S> & Only<S, "emit" | Served>,
  options: { readonly buffer?: number } = {},
): AsyncIterable<S["emit"]> => ({
  [Symbol.asyncIterator]() {
    const capacity = Math.max(1, options.buffer ?? 16);
    const buffer: S["emit"][] = [];
    let finished = false;
    let failure: unknown;
    let wake = () => {};
    let drain = () => {};
    const fiber = runFiber(
      k.pipe(
        forEach((e: S["emit"]) => {
          buffer.push(e);
          wake();
          if (buffer.length < capacity) return;
          return Async.fromPromise(() => new Promise<void>((r) => (drain = r)));
        }),
      ),
    );
    fiber.promise.then(
      () => ((finished = true), wake()),
      (e: unknown) => ((failure = e), (finished = true), wake()),
    );
    return {
      async next() {
        while (buffer.length === 0 && !finished) await new Promise<void>((r) => (wake = r));
        if (buffer.length > 0) {
          const value = buffer.shift()!;
          drain();
          return { value, done: false };
        }
        if (failure !== undefined) throw failure;
        return { value: undefined, done: true };
      },
      async return() {
        fiber.interrupt();
        await fiber.promise.catch(() => {});
        return { value: undefined, done: true };
      },
    };
  },
});
