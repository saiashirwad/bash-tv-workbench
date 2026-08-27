import type { Pipeable } from "./pipe.ts";
import type { Merge, Row } from "./types.ts";

export type AnyKyoot = Kyoot<any, any>;

export type OnOp = (
  payload: any,
  resume: ((value: any, state?: any) => AnyKyoot) & {
    with: (program: AnyKyoot, state?: any) => AnyKyoot;
  },
  state: any,
) => AnyKyoot;

export type Continuation = (v: any) => AnyKyoot;

// What a handler does at a fork. `copy`: the fiber gets `onOp` with the
// frame's state; the frame's end hooks stay with the parent. `scope`: the
// fiber gets a frame of its own, state from `create`, with the end hooks at
// the fiber's end. `none`: the handler stops at the fiber.
export type ForkMode = "copy" | "scope" | "none";

export type RuntimeNode =
  | { readonly _tag: "pure"; readonly value: unknown }
  | {
      readonly _tag: "op";
      readonly effectKey: PropertyKey;
      readonly payload: unknown;
    }
  | { readonly _tag: "map"; readonly self: AnyKyoot; readonly mapper: (a: any) => any }
  | {
      readonly _tag: "handler";
      readonly effectKey: PropertyKey;
      readonly self: AnyKyoot;
      readonly state?: unknown;
      readonly create?: () => unknown;
      readonly entered?: boolean;
      readonly fork?: ForkMode;
      readonly onOp: OnOp;
      readonly onSuccess?: (a: any, state: any) => AnyKyoot;
      readonly onDefect?: (d: unknown, state: any) => AnyKyoot;
      readonly onInterrupt?: (state: any) => void | AnyKyoot;
    }
  | { readonly _tag: "raise"; readonly error: unknown };

export type HandlerNode = Extract<RuntimeNode, { _tag: "handler" }>;

export const NodeSym: unique symbol = Symbol("kyoot.node");

/**
 * Result of `map`. Pure values (including `never` from `throw`) keep `S`.
 * Returning a nested Kyoot flattens and merges rows.
 *
 * Uses tuple checks so a free `S2 extends Row` is never introduced — that
 * unconstrained parameter used to collapse to `Row` and wipe real effect keys.
 */
export type MapResult<S extends Row, B> = [B] extends [never]
  ? Kyoot<never, S>
  : [B] extends [Kyoot<infer B2, infer S2>]
    ? Kyoot<B2, Merge<S, S2 extends Row ? S2 : {}>>
    : Kyoot<B, S>;

export interface Kyoot<A, S extends Row = {}> extends Pipeable {
  readonly _?: (s: S) => void;

  readonly [NodeSym]: RuntimeNode;

  map<B>(f: (a: A) => B): MapResult<S, B>;

  [Symbol.iterator](): Iterator<Kyoot<unknown, S>, A, unknown>;
}

export type RowsOf<Y> = Y extends Kyoot<any, infer S> ? S : never;

// The row of a callback's result: a program's row, or nothing for a plain value.
export type RowOf<R> = R extends Kyoot<any, infer S> ? (S extends Row ? S : {}) : {};
