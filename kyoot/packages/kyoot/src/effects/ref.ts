import type { Kyoot } from "../model.ts";
import * as Sync from "./sync.ts";

export interface Ref<A> {
  readonly get: Kyoot<A, { sync: () => unknown }>;
  set(value: A): Kyoot<void, { sync: () => unknown }>;
  update(f: (value: A) => A): Kyoot<void, { sync: () => unknown }>;
  modify<B>(f: (value: A) => readonly [result: B, value: A]): Kyoot<B, { sync: () => unknown }>;
}

/**
 * A shared synchronous reference. Unlike Var, updates are visible across
 * fibers. `modify` cannot yield, so each update is atomic between effect steps.
 */
export const make = <A>(initial: A): Kyoot<Ref<A>, { sync: () => unknown }> =>
  Sync.defer(() => {
    let current = initial;
    return {
      get: Sync.defer(() => current),
      set: (value) =>
        Sync.defer(() => {
          current = value;
        }),
      update: (f) =>
        Sync.defer(() => {
          current = f(current);
        }),
      modify: (f) =>
        Sync.defer(() => {
          const [result, value] = f(current);
          current = value;
          return result;
        }),
    };
  });
