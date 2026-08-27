import assert from "node:assert/strict";
import { test } from "node:test";
import { fileURLToPath } from "node:url";
import { AI, Model } from "@kyoot/ai";
import { Async, Clock, Emit, Fail, Kyoot } from "kyoot";
import { BashTvModelError, make } from "../src/node.ts";

const helperPath = fileURLToPath(new URL("./fixtures/helper.mjs", import.meta.url));
const BashTv = make({ helperPath, environment: () => ({ PATH: process.env.PATH ?? "" }) });

const Answer = {
  "~standard": {
    validate: (input: unknown) =>
      typeof input === "object" && input !== null && (input as { value?: unknown }).value === 42
        ? { value: input as { value: number } }
        : { issues: [{ message: "expected 42" }] },
    jsonSchema: {
      input: () => ({
        type: "object",
        properties: { value: { type: "number" } },
        required: ["value"],
      }),
    },
  },
};

test("BashTv.model handles ai/model and emits text", async () => {
  const [completion, events] = await Kyoot.runPromise(
    Model({ messages: [{ role: "user", content: "hello" }] }).pipe(
      BashTv.model("free", { thinking: "low" }),
      Emit.collect,
      Fail.orThrow,
    ),
  );
  assert.deepEqual(completion, {
    text: "fixture:low",
    toolCalls: [],
    usage: { input: 4, output: 1 },
  });
  assert.deepEqual(events, [{ type: "text", text: "fixture:low" }]);
});

test("BashTv.model emits deltas before the helper completes", async () => {
  const started = Date.now();
  const seen: number[] = [];
  const completion = await Kyoot.runPromise(
    Model({ messages: [{ role: "user", content: "stream" }] }).pipe(
      BashTv.model("free"),
      Emit.forEach(() => {
        seen.push(Date.now() - started);
      }),
      Fail.orThrow,
    ),
  );
  assert.equal(completion.text, "first");
  assert.equal(seen.length, 1);
  assert.ok(seen[0]! < 90, `delta arrived after ${seen[0]}ms`);
});

test("BashTv.model supports AI.gen structured output", async () => {
  const result = await Kyoot.runPromise(
    AI.gen(Answer, "answer").pipe(BashTv.model("free"), Emit.discard, Fail.orThrow),
  );
  assert.deepEqual(result, { value: 42 });
});

test("BashTv.model returns a typed and redacted helper error", async () => {
  const result = await Kyoot.runPromise(
    Model({ messages: [{ role: "user", content: "fail" }] }).pipe(
      BashTv.model("free"),
      Emit.discard,
      Fail.run,
    ),
  );
  assert.ok(
    !result.ok &&
      result.cause._tag === "Fail" &&
      result.cause.error instanceof BashTvModelError &&
      result.cause.error.kind === "fixture" &&
      !result.cause.error.message.includes("secret-value") &&
      result.cause.error.message.includes("[redacted]"),
  );
});

test("interrupting the model terminates its helper", async () => {
  const result = await Kyoot.runPromise(
    Kyoot.gen(function* () {
      const fiber = yield* Async.fork(
        Model({ messages: [{ role: "user", content: "hang" }] }).pipe(
          BashTv.model("free"),
          Emit.discard,
        ),
      );
      yield* Clock.sleep(20);
      yield* fiber.interrupt;
      return yield* fiber.await;
    }),
  );
  assert.ok(!result.ok && result.cause._tag === "Interrupted");
});
