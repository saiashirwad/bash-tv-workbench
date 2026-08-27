import assert from "node:assert/strict";
import test from "node:test";
import { LiveChatController } from "../public/live-chat.js";

const message = (sequence, id = String(sequence)) => ({
  sequence,
  id,
  role: "user",
  text: id,
});

function harness({ pages = [], snapshots = [] } = {}) {
  const appended = [];
  const resets = [];
  const completed = [];
  const errors = [];
  const delays = [];
  const pending = [];
  let disposed = 0;
  const scheduler = {
    set(callback, delay) {
      const task = { callback, delay, cleared: false };
      delays.push(delay);
      pending.push(task);
      return task;
    },
    clear(task) {
      task.cleared = true;
    },
  };
  const source = {
    async load() {
      const value = snapshots.shift();
      if (value instanceof Error) throw value;
      return value || { messages: [], cursor: null };
    },
    async page() {
      const value = pages.shift();
      if (value instanceof Error) throw value;
      return value;
    },
  };
  const view = {
    reset(messages) {
      resets.push([...messages]);
    },
    append(value, index) {
      appended.push({ value, index });
    },
    setCompleted(value) {
      completed.push(value);
    },
    showError(error, hasMessages) {
      errors.push({ error, hasMessages });
    },
    dispose() {
      disposed++;
    },
  };
  const controller = new LiveChatController(source, view, () => {}, scheduler);
  const runNext = async () => {
    const task = pending.shift();
    assert.ok(task, "expected a scheduled poll");
    if (!task.cleared) task.callback();
    await new Promise((resolve) => setImmediate(resolve));
    return task;
  };
  return {
    controller,
    appended,
    resets,
    completed,
    errors,
    delays,
    pending,
    runNext,
    disposed: () => disposed,
  };
}

test("Live Chat deduplicates messages repeated across incremental pages", async () => {
  const duplicate = message(2);
  const h = harness({
    snapshots: [{ messages: [message(1)], cursor: "one" }],
    pages: [
      { messages: [duplicate], nextCursor: "two" },
      { messages: [duplicate, message(3)], nextCursor: "three" },
    ],
  });

  await h.controller.load();
  await h.controller.pollOnce();
  await h.controller.pollOnce();

  assert.deepEqual(
    h.controller.messages.map((value) => value.sequence),
    [1, 2, 3],
  );
  assert.deepEqual(
    h.appended.map(({ value, index }) => [value.sequence, index]),
    [
      [2, 1],
      [3, 2],
    ],
  );
  assert.equal(h.controller.cursor, "three");
});

test("Live Chat reset force-loads and replaces cursor, messages, and dedupe state", async () => {
  const h = harness({
    snapshots: [
      { messages: [message(1)], cursor: "old" },
      { messages: [message(8)], cursor: "reset-cursor" },
    ],
    pages: [
      { reset: true, messages: [], nextCursor: null },
      { messages: [message(1)], nextCursor: "after-reset" },
    ],
  });

  await h.controller.load();
  await h.controller.pollOnce();
  await h.controller.pollOnce();

  assert.equal(h.resets.length, 2);
  assert.deepEqual(
    h.resets[1].map((value) => value.sequence),
    [8],
  );
  assert.deepEqual(
    h.controller.messages.map((value) => value.sequence),
    [8, 1],
  );
  assert.equal(h.controller.cursor, "after-reset");
});

test("Live Chat polling backs off after failures and resets delay after success", async () => {
  const h = harness({
    pages: [
      new Error("offline"),
      new Error("still offline"),
      { messages: [], nextCursor: "ok", completed: false },
    ],
  });

  h.controller.start();
  await h.runNext();
  await h.runNext();
  await h.runNext();

  assert.deepEqual(h.delays, [0, 2_000, 4_000, 1_500]);
});

test("Live Chat stop and dispose cancel polling, including in-flight rescheduling", async () => {
  let resolvePage;
  const page = new Promise((resolve) => (resolvePage = resolve));
  const h = harness({ pages: [page] });

  h.controller.start();
  const task = h.pending.shift();
  task.callback();
  h.controller.stop();
  resolvePage({ messages: [], nextCursor: "late", completed: false });
  await new Promise((resolve) => setImmediate(resolve));
  assert.deepEqual(h.delays, [0]);

  h.controller.start(25);
  h.controller.dispose();
  assert.equal(h.pending.at(-1).cleared, true);
  assert.equal(h.disposed(), 1);
});
