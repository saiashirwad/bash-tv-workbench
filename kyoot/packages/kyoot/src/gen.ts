import { succeed } from "./core.ts";
import type { AnyKyoot, Kyoot, RowsOf } from "./model.ts";
import type { MergeAll } from "./types.ts";

const step = (g: Generator<AnyKyoot, unknown, unknown>, input: unknown): AnyKyoot =>
  succeed(input).map((input) => {
    const s = g.next(input);
    return s.done ? succeed(s.value) : s.value.map((v) => step(g, v));
  });

export function gen<A, Y extends AnyKyoot>(
  f: () => Generator<Y, A, unknown>,
): Kyoot<A, MergeAll<RowsOf<Y>>> {
  return succeed(undefined).map(() => step(f(), undefined)) as Kyoot<A, any>;
}
