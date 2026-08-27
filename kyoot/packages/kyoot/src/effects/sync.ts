import { makeHandler, op } from "../core.ts";
import type { Kyoot } from "../model.ts";
import type { Row } from "../types.ts";

// The row records `() => unknown`, not `() => A`: `A` already lives in the
// value slot, and the row is contravariant, so a precise thunk type would
// make `{ sync: () => unknown }` in a hand-written signature reject every
// implementation. One fixed type per effect keeps rows composable.
export const defer = <A>(f: () => A) => op<A>()("sync", f as () => unknown);

export const run = <A, S extends Row & { sync?: () => unknown }>(k: Kyoot<A, S>) =>
  makeHandler("sync", k, { onOp: (f, resume) => resume(f()) });
