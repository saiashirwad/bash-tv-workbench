import { Emit } from "kyoot";
import type { ToolCall } from "./model.ts";

export type Event =
  | { readonly type: "text"; readonly text: string }
  | { readonly type: "call"; readonly call: ToolCall }
  | { readonly type: "result"; readonly call: ToolCall; readonly content: string };

export const emit = (e: Event) => Emit.value(e);

export const print = Emit.forEach((e: Event) =>
  process.stdout.write(
    e.type === "text"
      ? e.text
      : e.type === "call"
        ? `\n→ ${e.call.name}(${e.call.arguments})\n`
        : `← ${e.content}\n`,
  ),
);
