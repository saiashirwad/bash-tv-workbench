import { makeHandler, op, succeed } from "../core.ts";
import type { Kyoot } from "../model.ts";
import type { Row } from "../types.ts";

// runPromise serves `clock` with real timers unless a handler is closer.
export const sleep = (ms: number) => op<void>()("clock", ms);

// Virtual time: every sleep completes at once; the result carries the elapsed ms.
// A fiber forked under it sleeps instantly too; its elapsed time is its own.
export const virtual = <A, S extends Row & { clock?: number }>(k: Kyoot<A, S>) =>
  makeHandler("clock", k, {
    initial: 0,
    onOp: (ms, resume, now) => resume(undefined, now + ms),
    onSuccess: (a, now) => succeed([a, now] as const),
  });
