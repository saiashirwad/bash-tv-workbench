import {
  NodeSym,
  type AnyKyoot,
  type Continuation,
  type ForkMode,
  type HandlerNode,
  type Kyoot,
  type RowOf,
  type RuntimeNode,
} from "./model.ts";
import { pipeArguments, type Pipeable } from "./pipe.ts";
import type { FailRow, MergeAll, Row, Simplify } from "./types.ts";

// The interface carries pipe's overloads; the class merges with it.
// oxlint-disable-next-line no-unused-vars, typescript/no-unsafe-declaration-merging
export interface KyootImpl<A, S extends Row = {}> extends Pipeable {}
export class KyootImpl<A, S extends Row = {}> implements Kyoot<A, S> {
  readonly [NodeSym]: RuntimeNode;

  constructor(node: RuntimeNode) {
    this[NodeSym] = node;
  }

  // Parameter typed by A so a KyootImpl never infers A as `any` downstream;
  // return stays `any` so KyootImpl is assignable to Kyoot under MapResult.
  map(mapper: (a: A) => any): any {
    return new KyootImpl({ _tag: "map", self: this as AnyKyoot, mapper });
  }

  [Symbol.iterator]() {
    let used = false;
    return {
      next: (v: unknown): IteratorResult<Kyoot<unknown, S>, A> => {
        if (used) return { done: true, value: v as A };
        used = true;
        return { done: false, value: this };
      },
    };
  }
}

export const isKyoot = (value: unknown): value is AnyKyoot => value instanceof KyootImpl;

export const succeed = <A>(value: A): Kyoot<A, {}> => new KyootImpl({ _tag: "pure", value });

export const makeOp = (key: PropertyKey, payload: unknown) =>
  new KyootImpl({ _tag: "op", effectKey: key, payload });

// Typed op constructor. The row records the key and the payload type, so a
// handler's `onOp` can read the payload type back off the row. `A` is what
// the op resumes with; TS can't infer it, hence the two-step call.
export const op =
  <A>() =>
  <const K extends string, P>(key: K, payload: P): Kyoot<A, { [k in K]: P }> =>
    makeOp(key, payload) as Kyoot<A, { [k in K]: P }>;

// resume's result is opaque: the handler's type comes from `self`, not from
// what resume hands back. Returning `never` keeps it out of inference.
// `resume.with` continues the program with a computation instead of a value,
// run where the op was performed, so the program's own handlers see it.
export interface Resume<A, St> {
  (value: A, state?: St): Kyoot<never, {}>;
  with(program: Kyoot<A, any>, state?: St): Kyoot<never, {}>;
}

type Performed<K extends string, P, A, E> = Kyoot<A, Simplify<{ [k in K]: P } & FailRow<E>>>;

// What a handler is made of. State is `initial`, threaded through `resume`,
// or `create()`, called when the frame is entered: a cell that is fresh per
// run and shared with fibers forked under the handler.
export interface Hooks<P, A, St, X1, R1 extends Row, X2, R2 extends Row, R3 extends Row> {
  initial?: St;
  create?: () => St;
  fork?: ForkMode;
  onOp: (payload: P, resume: Resume<A, St>, state: St) => Kyoot<X1, R1>;
  onDefect?: (d: unknown, state: St) => Kyoot<X2, R2>;
  onInterrupt?: (state: St) => void | Kyoot<unknown, R3>;
}

// A declared effect: key, payload type, answer type, and the failure type a
// handler may hand back with `resume.with(Fail.fail(e))`. Calling it performs
// the op; `handle` builds a handler whose `resume` is typed to the answer.
// Like makeHandler, a callback that returns instead of resuming adds its
// value and row to the result. `intercept` sits between the program and the
// handlers outside it: `next` performs the op again for them to answer.
export const effect =
  <P, A, E = never>() =>
  <const K extends string>(key: K) => {
    const perform = (payload: P) => makeOp(key, payload) as Performed<K, P, A, E>;
    const handle =
      <
        St = undefined,
        X1 = never,
        X2 = never,
        R1 extends Row = {},
        R2 extends Row = {},
        R3 extends Row = {},
      >(
        hooks: Hooks<P, A, St, X1, R1, X2, R2, R3>,
      ) =>
      <B, S extends Row & { [k in K]?: P }>(
        k: Kyoot<B, S>,
      ): Kyoot<B | X1 | X2, MergeAll<Omit<S, K> | R1 | R2 | R3>> =>
        makeHandler(key, k, hooks);
    // Whatever `f` does, its outcome is delivered where the op was performed:
    // a value resumes, a failure is raised there for the program to catch.
    const intercept = <Ret extends Kyoot<A, any>>(
      f: (payload: P, next: (payload: P) => Performed<K, P, A, E>) => Ret,
    ) =>
      handle({
        onOp: (payload, resume) =>
          makeHandler("fail", f(payload, perform) as AnyKyoot, {
            onOp: (e) => resume.with(makeOp("fail", e) as AnyKyoot),
            onSuccess: (a) => resume(a),
          }) as Kyoot<never, RowOf<Ret>>,
      });
    return Object.assign(perform, { key, handle, intercept });
  };

// The payload type an effect key carries in the row, if the row has it.
export type Payload<S, K extends PropertyKey> = K extends keyof S
  ? Exclude<S[K], undefined>
  : never;

// Build a handler node and infer its type: the result is what onSuccess
// returns (default: the inner value) plus anything onOp / onDefect
// short-circuit with; the row is the inner row minus K plus whatever the
// callbacks introduce.
export function makeHandler<
  K extends PropertyKey,
  A,
  S extends Row,
  St = undefined,
  // Ops built with `op` put their payload type in the row, so this default is
  // right for them. Env and Var record something else (the service / state
  // type) and annotate the payload themselves.
  P = Payload<S, K>,
  B = A,
  B2 = never,
  B3 = never,
  R1 extends Row = {},
  R2 extends Row = {},
  R3 extends Row = {},
  R4 extends Row = {},
>(
  effectKey: K,
  self: Kyoot<A, S>,
  hooks: Hooks<P, any, St, B2, R1, B3, R3, R4> & {
    onSuccess?: (a: A, state: St) => Kyoot<B, R2>;
  },
): Kyoot<B | B2 | B3, MergeAll<Omit<S, K> | R1 | R2 | R3 | R4>> {
  const { initial } = hooks;
  const h = hooks as unknown as HandlerNode;
  const create = h.create ?? (initial === undefined ? undefined : () => initial);
  // One fixed shape for every handler node. A frame with a cell to make is
  // entered on its first step; the rest start entered, state in hand.
  return new KyootImpl({
    _tag: "handler",
    effectKey,
    self,
    state: initial,
    entered: h.create === undefined,
    create,
    fork: h.fork,
    onOp: h.onOp,
    onSuccess: h.onSuccess,
    onDefect: h.onDefect,
    onInterrupt: h.onInterrupt,
  }) as AnyKyoot;
}

export class EscapedOp {
  readonly _tag = "EscapedOp";
  readonly key: PropertyKey;
  readonly payload: unknown;
  readonly resumeWith: (k: AnyKyoot) => AnyKyoot;
  // The handlers an `async` op crossed on its way out, innermost first, so a
  // fiber spawned by the op can inherit them.
  handlers: HandlerNode[] | undefined;
  constructor(
    key: PropertyKey,
    payload: unknown,
    resumeWith: (k: AnyKyoot) => AnyKyoot,
    handlers?: HandlerNode[],
  ) {
    this.key = key;
    this.payload = payload;
    this.resumeWith = resumeWith;
    this.handlers = handlers;
  }
  resume(v: unknown) {
    return this.resumeWith(succeed(v));
  }
  resumeError(err: unknown) {
    return this.resumeWith(new KyootImpl({ _tag: "raise", error: err }));
  }
}

export class InterruptedError extends Error {
  readonly _tag = "InterruptedError";
  constructor(message = "fiber interrupted") {
    super(message);
    this.name = "InterruptedError";
  }
}

// Wrap a fiber's program in the handlers that enclosed the fork.
export const inherit = (k: AnyKyoot, handlers: readonly HandlerNode[] = []): AnyKyoot => {
  for (const h of handlers) {
    switch (h.fork ?? "copy") {
      case "copy":
        k = new KyootImpl({
          ...h,
          self: k,
          onSuccess: undefined,
          onDefect: undefined,
          onInterrupt: undefined,
        });
        break;
      case "scope": {
        // The end hook runs, but the fiber's value stays its own.
        const { onSuccess } = h;
        k = new KyootImpl({
          ...h,
          self: k,
          state: undefined,
          entered: false,
          onSuccess: onSuccess && ((a, st) => onSuccess(a, st).map(() => a)),
        });
        break;
      }
      case "none":
        break;
    }
  }
  return k;
};

// An async driver sets a step budget; when a program runs past it, stepAll
// escapes with this key so the driver can let other fibers run.
export const yieldKey: unique symbol = Symbol("kyoot.yield");

let remaining = Infinity;

export function withBudget<T>(steps: number, f: () => T): T {
  const prev = remaining;
  remaining = steps;
  try {
    return f();
  } finally {
    remaining = prev;
  }
}

const reify = (conts: Array<Continuation>, inner: AnyKyoot): AnyKyoot => {
  for (let i = conts.length - 1; i >= 0; i--) {
    inner = new KyootImpl({ _tag: "map", self: inner, mapper: conts[i]! });
  }
  return inner;
};

// Capture the pending continuations into a one-shot escape.
const escape = (
  continuations: Array<Continuation>,
  key: PropertyKey,
  payload: unknown,
  onResume: (k: AnyKyoot) => AnyKyoot,
  handlers?: HandlerNode[],
): EscapedOp => {
  // The frame is abandoned by the throw, so its array is the capture.
  const captured = continuations;
  let used = false;
  return new EscapedOp(
    key,
    payload,
    (k) => {
      if (used) throw new Error("continuation resumed twice (one-shot law)");
      used = true;
      return reify(captured, onResume(k));
    },
    handlers,
  );
};

const identity = (k: AnyKyoot) => k;

export function stepAll(k: AnyKyoot): unknown {
  const continuations: Array<Continuation> = [];
  let current: AnyKyoot = k;

  while (true) {
    if (--remaining < 0) {
      // Resumed with a value, carry on from here; resumed with an error
      // (an interrupt), raise it here.
      const here = current;
      throw escape(continuations, yieldKey, undefined, (k) => k.map(() => here));
    }
    const currentNode = current[NodeSym];
    switch (currentNode._tag) {
      case "pure": {
        const f = continuations.pop();
        if (f === undefined) return currentNode.value;
        const out = f(currentNode.value);
        current = isKyoot(out) ? out : succeed(out);
        break;
      }
      case "map": {
        continuations.push(currentNode.mapper);
        current = currentNode.self;
        break;
      }
      case "op": {
        throw escape(continuations, currentNode.effectKey, currentNode.payload, identity);
      }
      case "raise": {
        throw currentNode.error;
      }
      case "handler": {
        let handler: HandlerNode = currentNode;
        if (!handler.entered) handler = { ...handler, state: handler.create?.(), entered: true };
        const rewrap = (self: AnyKyoot, state: unknown = handler.state): AnyKyoot =>
          new KyootImpl({ ...handler, self, state });
        // A throw inside onOp, or any exception that is not one of our two
        // control exceptions, is a defect of this handler's scope.
        const defect = (d: unknown): AnyKyoot => {
          if (handler.onDefect === undefined) throw d;
          return handler.onDefect(d, handler.state);
        };
        let inner: unknown;
        try {
          inner = stepAll(handler.self);
        } catch (e) {
          if (e instanceof InterruptedError) {
            const fin = handler.onInterrupt?.(handler.state);
            if (!isKyoot(fin)) throw e;
            current = fin.map(() => {
              throw e;
            });
            break;
          }
          if (e instanceof EscapedOp) {
            if (e.key === handler.effectKey) {
              const state = (next: unknown[]) => (next.length > 0 ? next[0] : handler.state);
              const resume = Object.assign(
                (v: unknown, ...next: unknown[]) => rewrap(e.resume(v), state(next)),
                { with: (k: AnyKyoot, ...next: unknown[]) => rewrap(e.resumeWith(k), state(next)) },
              );
              try {
                current = handler.onOp(e.payload, resume, handler.state);
              } catch (d) {
                current = defect(d);
              }
              break;
            }
            if (e.key === "async" && handler.fork !== "none") (e.handlers ??= []).push(handler);
            throw escape(
              continuations,
              e.key,
              e.payload,
              (k) => rewrap(e.resumeWith(k)),
              e.handlers,
            );
          }
          current = defect(e);
          break;
        }
        current = (handler.onSuccess ?? succeed)(inner, handler.state);
        break;
      }
    }
  }
}

KyootImpl.prototype.pipe = function (this: unknown, ...fns: Array<(x: any) => any>) {
  return pipeArguments(this, fns);
};
