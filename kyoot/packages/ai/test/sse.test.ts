import assert from "node:assert/strict";
import { test } from "node:test";
import { events } from "../src/sse.ts";

const stream = (chunks: string[]) =>
  new ReadableStream({
    start(controller) {
      for (const c of chunks) controller.enqueue(new TextEncoder().encode(c));
      controller.close();
    },
  });

test("sse: parses data events split across chunks and stops at [DONE]", async () => {
  const out: unknown[] = [];
  for await (const e of events(
    stream(['data: {"a":1}\n\nda', 'ta: {"b":2}\n\n', 'data: [DONE]\n\ndata: {"c":3}\n\n']),
  ))
    out.push(e);
  assert.deepEqual(out, [{ a: 1 }, { b: 2 }]);
});
