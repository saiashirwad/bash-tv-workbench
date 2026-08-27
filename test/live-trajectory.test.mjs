import assert from "node:assert/strict";
import test from "node:test";
import { LiveTrajectoryIndex } from "../live-trajectory.mjs";

const rows = [
  {
    id: "user-1",
    type: "message",
    timestamp: "2026-01-01T00:00:00.000Z",
    message: {
      role: "user",
      content: [{ type: "text", text: "Inspect the build" }],
    },
  },
  {
    id: "assistant-1",
    type: "message",
    timestamp: "2026-01-01T00:00:01.000Z",
    message: {
      role: "assistant",
      content: [
        { type: "thinking", thinking: "I will inspect it" },
        {
          type: "toolCall",
          id: "call-1",
          name: "bash",
          arguments: { command: "npm test", payload: "x".repeat(20_000) },
        },
      ],
    },
  },
  {
    id: "result-1",
    type: "message",
    timestamp: "2026-01-01T00:00:03.000Z",
    message: {
      role: "toolResult",
      toolCallId: "call-1",
      toolName: "bash",
      content: [{ type: "text", text: "ok" }],
    },
  },
];

test("trajectory pages stay compact and event details load separately", () => {
  const index = new LiveTrajectoryIndex().update("session-one", rows);
  const page = index.page({ limit: 2 });
  assert.equal(page.events.length, 2);
  assert.equal(page.moreBefore, true);
  assert.equal(page.events[0].sequence, 3);
  assert.ok(Buffer.byteLength(JSON.stringify(page)) < 4_000);
  assert.equal("args" in page.events[0], false);

  const detail = index.event("call-1");
  assert.equal(detail.args.command, "npm test");
  assert.equal(detail.turn, 1);
  assert.equal(index.event("result-1").durationMs, 2_000);
});

test("trajectory indexing is incremental, searchable, and reset-safe", () => {
  const index = new LiveTrajectoryIndex();
  index.update("session-one", rows.slice(0, 1));
  assert.equal(index.page().total, 1);
  index.update("session-one", rows);
  assert.equal(index.page().total, 4);
  index.update("session-one", rows);
  assert.equal(index.page().total, 4, "unchanged rows were indexed twice");
  assert.equal(index.page({ query: "npm test" }).total, 1);
  index.update("session-two", rows.slice(0, 1));
  assert.equal(index.page().total, 1);
});
