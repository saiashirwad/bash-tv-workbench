import assert from "node:assert/strict";
import { test } from "node:test";
import { Clock, Emit, Fail, Kyoot } from "kyoot";
import { chatCompletions, Model, ProviderError, type Request } from "@kyoot/ai";

const options = { url: "https://example.test/chat", model: "test", apiKey: "secret" };
const request: Request = { messages: [{ role: "user", content: "hello" }] };
const event = (value: unknown) => `data: ${JSON.stringify(value)}\n\n`;

const response = (chunks: string[], status = 200) => {
  const encoder = new TextEncoder();
  return new Response(
    new ReadableStream({
      start(controller) {
        for (const chunk of chunks) controller.enqueue(encoder.encode(chunk));
        controller.close();
      },
    }),
    { status },
  );
};

test("chatCompletions streams text, a split tool call, and usage", async () => {
  const fetch = globalThis.fetch;
  globalThis.fetch = async () =>
    response([
      event({
        choices: [
          {
            delta: {
              content: "Hello ",
              tool_calls: [
                { index: 0, id: "call-1", function: { name: "wea", arguments: '{"city"' } },
              ],
            },
          },
        ],
      }),
      event({
        choices: [
          {
            delta: {
              content: "there",
              tool_calls: [{ index: 0, function: { name: "ther", arguments: ':"Pune"}' } }],
            },
          },
        ],
      }),
      event({ choices: [], usage: { prompt_tokens: 7, completion_tokens: 3 } }),
      "data: [DONE]\n\n",
    ]);

  try {
    const [completion, events] = await Kyoot.runPromise(
      Model(request).pipe(chatCompletions(options), Emit.collect, Fail.orThrow),
    );
    assert.deepEqual(completion, {
      text: "Hello there",
      toolCalls: [{ id: "call-1", name: "weather", arguments: '{"city":"Pune"}' }],
      usage: { input: 7, output: 3 },
    });
    assert.deepEqual(events, [
      { type: "text", text: "Hello " },
      { type: "text", text: "there" },
    ]);
  } finally {
    globalThis.fetch = fetch;
  }
});

test("chatCompletions retries 429 with virtual backoff", async () => {
  const fetch = globalThis.fetch;
  let calls = 0;
  globalThis.fetch = async () => {
    calls++;
    if (calls === 1) return new Response("slow down", { status: 429 });
    return response([event({ choices: [{ delta: { content: "ok" } }] }), "data: [DONE]\n\n"]);
  };

  try {
    const r = await Kyoot.runPromise(
      Model(request).pipe(chatCompletions(options), Emit.discard, Fail.orThrow, Clock.virtual),
    );
    assert.deepEqual(r, [{ text: "ok", toolCalls: [], usage: { input: 0, output: 0 } }, 500]);
    assert.equal(calls, 2);
  } finally {
    globalThis.fetch = fetch;
  }
});

test("chatCompletions does not retry 401", async () => {
  const fetch = globalThis.fetch;
  let calls = 0;
  globalThis.fetch = async () => {
    calls++;
    return new Response("bad key", { status: 401 });
  };

  try {
    const [r, elapsed] = await Kyoot.runPromise(
      Model(request).pipe(chatCompletions(options), Emit.discard, Fail.run, Clock.virtual),
    );
    assert.equal(r.ok, false);
    assert.ok(
      !r.ok &&
        r.cause._tag === "Fail" &&
        r.cause.error instanceof ProviderError &&
        r.cause.error.status === 401 &&
        r.cause.error.message === "bad key",
    );
    assert.equal(elapsed, 0);
    assert.equal(calls, 1);
  } finally {
    globalThis.fetch = fetch;
  }
});
