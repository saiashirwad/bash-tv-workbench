import { makeHandler, op, succeed } from "../core.ts";
import { gen } from "../gen.ts";
import type { Kyoot, RowOf } from "../model.ts";
import type { MergeAll, Row } from "../types.ts";

type Finalizer = () => unknown;

export interface ResourceOp<S extends Row = {}> {
  readonly _?: (s: S) => void;
  readonly acquire: () => unknown;
  readonly release: (r: unknown) => unknown;
}

export const acquire = <R, C>(open: () => R, close: (r: R) => C) =>
  op<R>()("resource", { acquire: open, release: close } as ResourceOp<RowOf<C>>);

const attempt = (f: Finalizer, errors: unknown[]) =>
  makeHandler("resource/finalizer", succeed(undefined).map(f), {
    onOp: (_, resume) => resume(undefined),
    onDefect: (d) => {
      errors.push(d);
      return succeed(undefined);
    },
  });

const finalize = (finalizers: readonly Finalizer[], rethrow: boolean) =>
  gen(function* () {
    const errors: unknown[] = [];
    for (let i = finalizers.length - 1; i >= 0; i--) yield* attempt(finalizers[i]!, errors);
    if (rethrow && errors.length > 0) throw errors[0];
  });

type ReleaseRow<R> = R extends ResourceOp<infer S> ? S : never;

export const run = <A, S extends Row & { resource?: ResourceOp<any> }>(
  k: Kyoot<A, S>,
): Kyoot<A, MergeAll<Omit<S, "resource"> | ReleaseRow<S["resource"]>>> =>
  makeHandler("resource", k, {
    // A fiber gets a scope of its own, released when the fiber ends.
    fork: "scope",
    initial: [] as Finalizer[],
    onOp: (res, resume, finalizers) => {
      const r = res.acquire();
      return resume(r, [...finalizers, () => res.release(r)]);
    },
    onSuccess: (a, finalizers) => finalize(finalizers, true).map(() => a),
    onDefect: (d, finalizers) =>
      finalize(finalizers, false).map(() => {
        throw d;
      }),
    onInterrupt: (finalizers) => finalize(finalizers, false),
  }) as never;
