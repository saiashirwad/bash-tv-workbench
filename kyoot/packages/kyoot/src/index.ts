import { succeed } from "./core.ts";
import { gen } from "./gen.ts";
import type { Kyoot as KyootType } from "./model.ts";
import { runPromise, runSync } from "./runtime.ts";
import type { Row } from "./types.ts";

export { effect, InterruptedError, makeHandler, op } from "./core.ts";
export { runFiber } from "./runtime.ts";
export type { Resume } from "./core.ts";
export type { AsyncOp, AsyncRuntime, FiberHandle } from "./runtime.ts";
export type { Pipeable } from "./pipe.ts";
export { Result } from "./result.ts";
export type { Cause, DefectCause, Err, FailCause, InterruptedCause, Ok } from "./result.ts";
export type { Merge, MergeAll, Only, Row, Simplify, Unhandled } from "./types.ts";
export type { AnyKyoot, MapResult, RowOf, RowsOf } from "./model.ts";

export * as Async from "./effects/async.ts";
export * as Clock from "./effects/clock.ts";
export * as Deferred from "./effects/deferred.ts";
export * as Emit from "./effects/emit.ts";
export * as Env from "./effects/env.ts";
export * as Fail from "./effects/fail.ts";
export * as Log from "./effects/log.ts";
export * as Queue from "./effects/queue.ts";
export * as Random from "./effects/random.ts";
export * as Ref from "./effects/ref.ts";
export * as Resource from "./effects/resource.ts";
export * as Retry from "./effects/retry.ts";
export * as Semaphore from "./effects/semaphore.ts";
export * as Sync from "./effects/sync.ts";
export * as Var from "./effects/var.ts";

export type Kyoot<A, S extends Row = {}> = KyootType<A, S>;
export const Kyoot = { succeed, gen, runSync, runPromise };
