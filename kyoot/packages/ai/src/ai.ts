import { Kyoot } from "kyoot";
import type { Kyoot as K } from "kyoot";
import { generate, type Options as Generate, type Requires } from "./generate.ts";
import type { Message } from "./model.ts";
import type { Schema } from "./schema.ts";
import type { Tool } from "./tool.ts";

export interface Options<T extends Tool = never> extends Omit<Generate<never, T>, "schema"> {
  readonly prompt?: string;
  readonly messages?: readonly Message[];
}

export interface AI<T extends Tool = never> {
  readonly messages: Message[];
  ask(input?: string): K<string, Requires<T>>;
  gen<A>(schema: Schema<A>, input?: string): K<A, Requires<T>>;
}

export const make = <T extends Tool = never>(options: Options<T> = {}): AI<T> => {
  const messages: Message[] = [...(options.messages ?? [])];
  const system: Message[] = options.prompt ? [{ role: "system", content: options.prompt }] : [];
  const step = <A>(input: string | undefined, schema?: Schema<A>): K<A, Requires<T>> =>
    Kyoot.gen(function* () {
      if (input !== undefined) messages.push({ role: "user", content: input });
      const all = [...system, ...messages];
      const [value, added] = yield* schema
        ? generate(all, { ...options, schema })
        : generate(all, options);
      messages.push(...added);
      return value as A;
    }) as never;
  return {
    messages,
    ask: (input) => step<string>(input),
    gen: (schema, input) => step(input, schema),
  };
};

export const ask = <T extends Tool = never>(input: string, options?: Options<T>) =>
  make(options).ask(input);

export const gen = <A, T extends Tool = never>(
  schema: Schema<A>,
  input: string,
  options?: Options<T>,
) => make(options).gen(schema, input);
