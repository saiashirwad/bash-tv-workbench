import { Async, Fail, Kyoot, Retry } from "kyoot";
import { Model, type Message, type Request, type ToolCall } from "./model.ts";
import { events } from "./sse.ts";
import * as Events from "./events.ts";

export class ProviderError {
  readonly _tag = "ProviderError";
  readonly status: number;
  readonly message: string;
  constructor(status: number, message: string) {
    this.status = status;
    this.message = message;
  }
}

export interface Options {
  readonly url: string;
  readonly model: string;
  readonly apiKey: string;
  readonly retry?: Retry.Policy;
}

interface Chunk {
  readonly choices?: readonly {
    readonly delta: {
      readonly content?: string | null;
      readonly tool_calls?: readonly {
        readonly index: number;
        readonly id?: string;
        readonly function?: { readonly name?: string; readonly arguments?: string };
      }[];
    };
  }[];
  readonly usage?: { readonly prompt_tokens: number; readonly completion_tokens: number } | null;
}

const toApi = (m: Message) =>
  m.role === "tool"
    ? { role: "tool", content: m.content, tool_call_id: m.toolCallId }
    : m.role === "assistant"
      ? {
          role: "assistant",
          content: m.content,
          tool_calls: m.toolCalls?.map((c) => ({
            id: c.id,
            type: "function",
            function: { name: c.name, arguments: c.arguments },
          })),
        }
      : m;

const complete = ({ url, model, apiKey }: Options, req: Request) =>
  Kyoot.gen(function* () {
    const res = yield* Async.fromPromise((signal) =>
      fetch(url, {
        method: "POST",
        signal,
        headers: { "content-type": "application/json", authorization: `Bearer ${apiKey}` },
        body: JSON.stringify({
          model,
          stream: true,
          stream_options: { include_usage: true },
          messages: req.messages.map(toApi),
          tools: req.tools?.map((t) => ({ type: "function", function: t })),
          tool_choice: req.tools && req.toolChoice,
          temperature: req.temperature,
          max_tokens: req.maxTokens,
        }),
      }),
    );
    if (!res.ok) {
      const message = yield* Async.fromPromise(() => res.text());
      yield* Fail.fail(new ProviderError(res.status, message));
    }
    const it = events<Chunk>(res.body!)[Symbol.asyncIterator]();
    let text = "";
    let usage = { input: 0, output: 0 };
    const calls: { id: string; name: string; arguments: string }[] = [];
    while (true) {
      const r = yield* Async.fromPromise(() => it.next());
      if (r.done) break;
      const { content, tool_calls = [] } = r.value.choices?.[0]?.delta ?? {};
      if (content) {
        text += content;
        yield* Events.emit({ type: "text", text: content });
      }
      for (const tc of tool_calls) {
        const call = (calls[tc.index] ??= { id: "", name: "", arguments: "" });
        call.id ||= tc.id ?? "";
        call.name += tc.function?.name ?? "";
        call.arguments += tc.function?.arguments ?? "";
      }
      if (r.value.usage)
        usage = { input: r.value.usage.prompt_tokens, output: r.value.usage.completion_tokens };
    }
    return { text, toolCalls: calls.filter(Boolean) as ToolCall[], usage };
  });

export const chatCompletions = (options: Options) =>
  Model.handle({
    onOp: (req, resume) =>
      complete(options, req)
        .pipe(
          Retry.run(
            options.retry ?? {
              times: 3,
              delay: (n) => 500 * 2 ** n,
              while: (e) => e instanceof ProviderError && (e.status === 429 || e.status >= 500),
            },
          ),
        )
        .map(resume),
  });

export const Deepseek = (options: Partial<Options> = {}) => {
  const apiKey = options.apiKey ?? process.env.DEEPSEEK_API_KEY;
  if (!apiKey) throw new Error("DEEPSEEK_API_KEY is not set");
  return chatCompletions({
    url: "https://api.deepseek.com/chat/completions",
    model: "deepseek-chat",
    ...options,
    apiKey,
  });
};

export const OpenAI = (options: Partial<Options> = {}) => {
  const apiKey = options.apiKey ?? process.env.OPENAI_API_KEY;
  if (!apiKey) throw new Error("OPENAI_API_KEY is not set");
  return chatCompletions({
    url: "https://api.openai.com/v1/chat/completions",
    model: "gpt-4o-mini",
    ...options,
    apiKey,
  });
};
