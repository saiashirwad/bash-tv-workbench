import { Async, Emit, Env, Fail, Kyoot, Result, runFiber } from "kyoot";
import {
  parseAsync,
  ValidationError,
  type Input,
  type Output,
  type StandardSchema,
} from "@kyoot/schema";

export type Kind = "query" | "mutation" | "stream";
export interface Procedure<
  I extends StandardSchema,
  O extends StandardSchema,
  E extends StandardSchema | undefined = undefined,
  K extends Kind = Kind,
> {
  readonly kind: K;
  readonly input: I;
  readonly output: O;
  readonly error?: E;
}
export type AnyProcedure = Procedure<
  StandardSchema<any, any>,
  StandardSchema<any, any>,
  StandardSchema<any, any> | undefined,
  Kind
>;
export type Shape = { readonly [key: string]: AnyProcedure | Shape };
export interface Api<Name extends string, S extends Shape> {
  readonly name: Name;
  readonly shape: S;
}

const procedure = <
  K extends Kind,
  I extends StandardSchema,
  O extends StandardSchema,
  E extends StandardSchema | undefined = undefined,
>(
  kind: K,
  spec: { readonly input: I; readonly output: O; readonly error?: E },
): Procedure<I, O, E, K> => ({ kind, ...spec });
export const query = <
  I extends StandardSchema,
  O extends StandardSchema,
  E extends StandardSchema | undefined = undefined,
>(spec: {
  readonly input: I;
  readonly output: O;
  readonly error?: E;
}) => procedure("query", spec);
export const mutation = <
  I extends StandardSchema,
  O extends StandardSchema,
  E extends StandardSchema | undefined = undefined,
>(spec: {
  readonly input: I;
  readonly output: O;
  readonly error?: E;
}) => procedure("mutation", spec);
export const stream = <
  I extends StandardSchema,
  O extends StandardSchema,
  E extends StandardSchema | undefined = undefined,
>(spec: {
  readonly input: I;
  readonly output: O;
  readonly error?: E;
}) => procedure("stream", spec);
export const api = <const Name extends string, const S extends Shape>(
  name: Name,
  shape: S,
): Api<Name, S> => ({ name, shape });

export interface RequestEnvelope {
  readonly version: 1;
  readonly id: string;
  readonly procedure: string;
  readonly input: unknown;
}
export type ResponseEnvelope =
  | { readonly version: 1; readonly id: string; readonly ok: true; readonly output: unknown }
  | {
      readonly version: 1;
      readonly id: string;
      readonly ok: false;
      readonly error: unknown;
      readonly protocol?: boolean;
    };
export type StreamEnvelope =
  | {
      readonly version: 1;
      readonly id: string;
      readonly type: "data";
      readonly sequence: number;
      readonly value: unknown;
    }
  | { readonly version: 1; readonly id: string; readonly type: "end" }
  | {
      readonly version: 1;
      readonly id: string;
      readonly type: "error";
      readonly error: unknown;
      readonly protocol?: boolean;
    };

export class RpcProtocolError {
  readonly _tag = "RpcProtocolError";
  readonly code:
    | "not_found"
    | "invalid_input"
    | "invalid_output"
    | "invalid_error"
    | "invalid_envelope";
  readonly message: string;
  readonly issues?: ValidationError["issues"];
  constructor(code: RpcProtocolError["code"], message: string, issues?: ValidationError["issues"]) {
    this.code = code;
    this.message = message;
    this.issues = issues;
  }
}
export class RpcTransportError {
  readonly _tag = "RpcTransportError";
  readonly message: string;
  readonly status?: number;
  constructor(message: string, status?: number) {
    this.message = message;
    this.status = status;
  }
}

export interface Transport {
  request(request: RequestEnvelope, signal: AbortSignal): Promise<ResponseEnvelope>;
  subscribe(request: RequestEnvelope, signal: AbortSignal): AsyncIterable<StreamEnvelope>;
}
export const Transport = Env.tag<Transport>()("rpc/transport");

const show = (error: unknown) => (error instanceof Error ? error.message : String(error));
const validation = (code: RpcProtocolError["code"], error: unknown) =>
  error instanceof ValidationError
    ? new RpcProtocolError(code, error.message, error.issues)
    : new RpcProtocolError(code, show(error));

export type Handler<P extends AnyProcedure> = (
  input: Input<P["input"]>,
) => Kyoot<Output<P["output"]>, any>;
export type StreamHandler<P extends AnyProcedure> = (
  input: Input<P["input"]>,
) => Kyoot<void, { emit: Output<P["output"]> } & Record<string, unknown>>;
export type Handlers<S extends Shape> = {
  readonly [K in keyof S]: S[K] extends AnyProcedure
    ? S[K]["kind"] extends "stream"
      ? StreamHandler<S[K]>
      : Handler<S[K]>
    : S[K] extends Shape
      ? Handlers<S[K]>
      : never;
};

type Entry = {
  readonly procedure: AnyProcedure;
  readonly handler: (input: any) => Kyoot<any, any>;
};
const compile = (
  shape: Shape,
  handlers: Record<string, any>,
  prefix = "",
  out = new Map<string, Entry>(),
) => {
  for (const [key, value] of Object.entries(shape)) {
    const path = prefix ? `${prefix}.${key}` : key;
    if ("kind" in value)
      out.set(path, { procedure: value as AnyProcedure, handler: handlers[key] });
    else compile(value as Shape, handlers[key], path, out);
  }
  return out;
};

export interface Router {
  request(request: RequestEnvelope, signal?: AbortSignal): Promise<ResponseEnvelope>;
  subscribe(request: RequestEnvelope, signal?: AbortSignal): AsyncIterable<StreamEnvelope>;
}
const protocolFailure = (request: RequestEnvelope, error: RpcProtocolError): ResponseEnvelope => ({
  version: 1,
  id: request.id,
  ok: false,
  protocol: true,
  error,
});
const runHandler = async (
  program: Kyoot<any, any>,
  signal: AbortSignal,
): Promise<Result<any, any>> => {
  const fiber = runFiber(program.pipe(Fail.run) as never);
  const interrupt = () => fiber.interrupt();
  signal.addEventListener("abort", interrupt, { once: true });
  try {
    return (await fiber.promise) as Result<any, any>;
  } finally {
    signal.removeEventListener("abort", interrupt);
  }
};

export const router = <N extends string, S extends Shape>(
  definition: Api<N, S>,
  handlers: Handlers<S>,
): Router => {
  const entries = compile(definition.shape, handlers as Record<string, any>);
  return {
    async request(request, signal = new AbortController().signal) {
      const entry = entries.get(request.procedure);
      if (!entry || entry.procedure.kind === "stream")
        return protocolFailure(
          request,
          new RpcProtocolError("not_found", `unknown unary procedure ${request.procedure}`),
        );
      try {
        const parsed = await parseAsync(entry.procedure.input, request.input).catch((e) => {
          throw validation("invalid_input", e);
        });
        const result = await runHandler(entry.handler(parsed), signal);
        if (signal.aborted) throw signal.reason;
        if (result.ok) {
          const output = await parseAsync(entry.procedure.output, result.value).catch((e) => {
            throw validation("invalid_output", e);
          });
          return { version: 1, id: request.id, ok: true, output };
        }
        if (result.cause._tag !== "Fail")
          throw result.cause._tag === "Defect"
            ? result.cause.defect
            : new DOMException("Interrupted", "AbortError");
        if (!entry.procedure.error) throw validation("invalid_error", result.cause.error);
        const error = await parseAsync(entry.procedure.error, result.cause.error).catch((e) => {
          throw validation("invalid_error", e);
        });
        return { version: 1, id: request.id, ok: false, error };
      } catch (error) {
        if (error instanceof RpcProtocolError) return protocolFailure(request, error);
        throw error;
      }
    },
    subscribe(request, signal = new AbortController().signal) {
      const entry = entries.get(request.procedure);
      const definition = entry?.procedure;
      return {
        async *[Symbol.asyncIterator]() {
          if (!entry || definition?.kind !== "stream") {
            yield {
              version: 1,
              id: request.id,
              type: "error",
              protocol: true,
              error: new RpcProtocolError(
                "not_found",
                `unknown stream procedure ${request.procedure}`,
              ),
            } as const;
            return;
          }
          let sequence = 0;
          try {
            const parsed = await parseAsync(definition.input, request.input).catch((e) => {
              throw validation("invalid_input", e);
            });
            const program = entry
              .handler(parsed)
              .pipe(Emit.map(async (value: unknown) => parseAsync(definition.output, value)));
            const iterator = Emit.toAsyncIterable(program as never)[Symbol.asyncIterator]();
            try {
              while (!signal.aborted) {
                const next = await Promise.race([
                  iterator.next(),
                  new Promise<IteratorResult<unknown>>((resolve) =>
                    signal.addEventListener(
                      "abort",
                      () => resolve({ value: undefined, done: true }),
                      { once: true },
                    ),
                  ),
                ]);
                if (next.done) break;
                yield {
                  version: 1,
                  id: request.id,
                  type: "data",
                  sequence: sequence++,
                  value: await next.value,
                } as const;
              }
            } finally {
              await iterator.return?.();
            }
            if (!signal.aborted) yield { version: 1, id: request.id, type: "end" } as const;
          } catch (error) {
            const rpcError =
              error instanceof RpcProtocolError ? error : validation("invalid_output", error);
            yield {
              version: 1,
              id: request.id,
              type: "error",
              protocol: true,
              error: rpcError,
            } as const;
          }
        },
      };
    },
  };
};

const id = () => globalThis.crypto?.randomUUID?.() ?? `${Date.now()}-${Math.random()}`;
type ErrorOf<P extends AnyProcedure> =
  NonNullable<P["error"]> extends StandardSchema<any, infer E> ? E : never;
type ClientProcedure<P extends AnyProcedure> = P["kind"] extends "stream"
  ? (input: Input<P["input"]>) => Kyoot<
      void,
      {
        async: unknown;
        "env/rpc/transport": Transport;
        emit: Output<P["output"]>;
        fail: RpcTransportError | RpcProtocolError | ErrorOf<P>;
      }
    >
  : (input: Input<P["input"]>) => Kyoot<
      Output<P["output"]>,
      {
        async: unknown;
        "env/rpc/transport": Transport;
        fail: RpcTransportError | RpcProtocolError | ErrorOf<P>;
      }
    >;
export type Client<S extends Shape> = {
  readonly [K in keyof S]: S[K] extends AnyProcedure
    ? ClientProcedure<S[K]>
    : S[K] extends Shape
      ? Client<S[K]>
      : never;
};

const streamValues = (definition: AnyProcedure, events: AsyncIterable<StreamEnvelope>) => ({
  async *[Symbol.asyncIterator]() {
    for await (const event of events) {
      if (event.type === "data") yield await parseAsync(definition.output, event.value);
      else if (event.type === "error") throw event.error;
    }
  },
});
const clientShape = (shape: Shape, prefix = ""): any =>
  Object.fromEntries(
    Object.entries(shape).map(([key, value]) => {
      const path = prefix ? `${prefix}.${key}` : key;
      if (!("kind" in value)) return [key, clientShape(value as Shape, path)];
      const definition = value as AnyProcedure;
      return [
        key,
        (input: unknown) =>
          Kyoot.gen(function* () {
            const transport = yield* Transport;
            const request = { version: 1, id: id(), procedure: path, input } as const;
            if (definition.kind === "stream")
              return yield* Async.fromPromise((signal) =>
                Promise.resolve(transport.subscribe(request, signal)),
              ).map((events) => Emit.fromAsyncIterable(streamValues(definition, events)));
            const response = yield* Async.fromPromise((signal) =>
              transport
                .request(request, signal)
                .catch((e) => Promise.reject(new RpcTransportError(show(e)))),
            );
            if (response.ok)
              return yield* Async.fromPromise(() => parseAsync(definition.output, response.output));
            return yield* Fail.fail(response.error);
          }),
      ];
    }),
  );
export const client = <N extends string, S extends Shape>(definition: Api<N, S>): Client<S> =>
  clientShape(definition.shape);

export const inMemory = (server: Router): Transport => ({
  request: (request, signal) => server.request(request, signal),
  subscribe: (request, signal) => server.subscribe(request, signal),
});
export const provide = Transport.provide;
