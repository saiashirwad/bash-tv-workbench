import type { Completion, Request } from "@kyoot/ai";

export type ModelId = "free";
export type Thinking = "off" | "low";

export interface CompleteCommand {
  readonly type: "complete";
  readonly model: ModelId;
  readonly thinking: Thinking;
  readonly request: Request;
}

export type HelperEvent =
  | { readonly type: "text"; readonly text: string }
  | { readonly type: "result"; readonly completion: Completion }
  | {
      readonly type: "error";
      readonly error: {
        readonly kind: string;
        readonly message: string;
      };
    };
