import { effect, Kyoot } from "kyoot";
import type { Kyoot as K, Row } from "kyoot";
import type { ToolSchema } from "./model.ts";
import { jsonSchema, type Schema } from "./schema.ts";

export interface Tool<A = any, R = unknown, S extends Row = any> {
  readonly name: string;
  readonly description: string;
  readonly args: Schema<A>;
  readonly run: (args: A) => K<R, S>;
}

export const Tool = <A, R, S extends Row>(
  name: string,
  description: string,
  args: Schema<A>,
  run: (args: A) => K<R, S>,
): Tool<A, R, S> => ({ name, description, args, run });

export const schemaOf = (t: Tool): ToolSchema => ({
  name: t.name,
  description: t.description,
  parameters: jsonSchema(t.args),
});

export const Approve = effect<{ readonly tool: string; readonly args: unknown }, boolean>()(
  "ai/approve",
);

export const needsApproval = <A, R, S extends Row>(tool: Tool<A, R, S>) =>
  Tool(tool.name, tool.description, tool.args, (args) =>
    Kyoot.gen(function* () {
      return (yield* Approve({ tool: tool.name, args })) ? yield* tool.run(args) : { denied: true };
    }),
  );
