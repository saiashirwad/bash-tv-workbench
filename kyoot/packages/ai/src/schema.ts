export {
  jsonSchema,
  parse,
  parseAsync,
  safeParse,
  safeParseAsync,
  ValidationError,
  type Input,
  type Issue,
  type Output,
  type StandardSchema,
} from "@kyoot/schema";

export type Schema<A> = import("@kyoot/schema").StandardSchema<unknown, A>;
