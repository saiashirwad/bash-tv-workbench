import { makeHandler, op } from "../core.ts";
import type { Kyoot } from "../model.ts";
import type { Row } from "../types.ts";

export const next = () => op<number>()("random", undefined as void);

export const int = (max: number) => next().map((x) => Math.floor(x * max));

export const live = <A, S extends Row & { random?: void }>(k: Kyoot<A, S>) =>
  makeHandler("random", k, { onOp: (_, resume) => resume(Math.random()) });

const step = (seed: number) => {
  let t = (seed + 0x6d2b79f5) | 0;
  t = Math.imul(t ^ (t >>> 15), t | 1);
  t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
  return [((t ^ (t >>> 14)) >>> 0) / 4294967296, seed + 0x6d2b79f5] as const;
};

export const seeded =
  (seed: number) =>
  <A, S extends Row & { random?: void }>(k: Kyoot<A, S>) =>
    makeHandler("random", k, {
      initial: seed,
      onOp: (_, resume, s) => {
        const [x, s2] = step(s);
        return resume(x, s2);
      },
    });
