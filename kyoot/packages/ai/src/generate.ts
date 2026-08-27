import { Fail, InterruptedError, Kyoot } from "kyoot";
import type { Kyoot as K, MergeAll } from "kyoot";
import * as Events from "./events.ts";
import { Model, type Message, type Request } from "./model.ts";
import * as Schema from "./schema.ts";
import { schemaOf, type Tool } from "./tool.ts";

export class TooManyRounds {
  readonly _tag = "TooManyRounds";
}

export interface Options<A, T extends Tool> {
  readonly tools?: readonly T[];
  readonly rounds?: number;
  readonly schema?: Schema.Schema<A>;
}

export type Requires<T extends Tool> = MergeAll<
  | { "ai/model": Request; emit: Events.Event; fail: TooManyRounds }
  | (T extends Tool<any, any, infer S> ? Omit<S, "fail"> : never)
>;

const show = (e: unknown) => (e instanceof Error ? e.message : JSON.stringify(e));

const parse = <A>(schema: Schema.Schema<A>, raw: string): { args: A } | { error: string } => {
  try {
    return { args: Schema.parse(schema, JSON.parse(raw)) };
  } catch (e) {
    return { error: show(e) };
  }
};

const run = (tool: Tool, args: unknown) =>
  tool
    .run(args)
    .pipe(Fail.run)
    .map((r) => {
      if (r.ok) return JSON.stringify(r.value);
      if (r.cause._tag === "Fail") return `error: ${show(r.cause.error)}`;
      throw r.cause._tag === "Defect" ? r.cause.defect : new InterruptedError();
    });

export function generate<T extends Tool = never>(
  messages: readonly Message[],
  options?: Options<string, T> & { readonly schema?: undefined },
): K<readonly [string, Message[]], Requires<T>>;
export function generate<A, T extends Tool = never>(
  messages: readonly Message[],
  options: Options<A, T> & { readonly schema: Schema.Schema<A> },
): K<readonly [A, Message[]], Requires<T>>;
export function generate<A = string, T extends Tool = never>(
  messages: readonly Message[],
  { tools = [], rounds = 8, schema }: Options<A, T> = {},
): K<readonly [A, Message[]], Requires<T>> {
  return Kyoot.gen(function* () {
    const schemas = tools.map(schemaOf);
    if (schema)
      schemas.push({
        name: "answer",
        description: "Give the final answer",
        parameters: Schema.jsonSchema(schema),
      });
    const added: Message[] = [];
    for (let round = 0; round < rounds; round++) {
      const { text, toolCalls } = yield* Model({
        messages: [...messages, ...added],
        tools: schemas.length > 0 ? schemas : undefined,
        toolChoice: schema ? "required" : "auto",
      });
      added.push({ role: "assistant", content: text, ...(toolCalls.length > 0 && { toolCalls }) });
      if (!schema && toolCalls.length === 0) return [text as A, added] as const;
      for (const call of toolCalls) {
        yield* Events.emit({ type: "call", call });
        const tool = tools.find((t) => t.name === call.name);
        const args = schema && call.name === "answer" ? schema : tool?.args;
        const r = args ? parse(args, call.arguments) : { error: `unknown tool ${call.name}` };
        const content = "error" in r ? r.error : tool ? yield* run(tool, r.args) : "ok";
        added.push({ role: "tool", toolCallId: call.id, content });
        yield* Events.emit({ type: "result", call, content });
        if (!("error" in r) && !tool) return [r.args as A, added] as const;
      }
    }
    return yield* Fail.fail(new TooManyRounds());
  }) as never;
}
