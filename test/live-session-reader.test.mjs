import assert from "node:assert/strict";
import { mkdtemp, mkdir, writeFile, appendFile, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import {
  LiveSessionReader,
  liveCursor,
  paginateLiveMessages,
} from "../live-session-reader.mjs";

const messages = (count) =>
  Array.from({ length: count }, (_, index) => ({
    sequence: index + 1,
    id: `m${index + 1}`,
  }));

test("live message pages paginate and reconnect without duplicate delivery", () => {
  const all = messages(5);
  const first = paginateLiveMessages("file", all, null, 2);
  assert.deepEqual(
    first.messages.map((x) => x.id),
    ["m1", "m2"],
  );
  assert.equal(first.more, true);
  const second = paginateLiveMessages("file", all, first.nextCursor, 2);
  assert.deepEqual(
    second.messages.map((x) => x.id),
    ["m3", "m4"],
  );
  const reconnect = paginateLiveMessages("file", all, second.nextCursor, 2);
  assert.deepEqual(
    reconnect.messages.map((x) => x.id),
    ["m5"],
  );
  assert.equal(reconnect.more, false);
  assert.equal(reconnect.nextCursor, liveCursor("file", 5));
  assert.deepEqual(
    paginateLiveMessages("file", all, reconnect.nextCursor, 2).messages,
    [],
  );
});

test("live message pages reset stale and foreign cursors", () => {
  const all = messages(3);
  for (const cursor of ["old:2", "file:9", "invalid"]) {
    const page = paginateLiveMessages("file", all, cursor, 2);
    assert.equal(page.reset, true);
    assert.deepEqual(
      page.messages.map((x) => x.id),
      ["m1", "m2"],
    );
  }
});

test("reader keeps selected file and parses only complete appended JSONL", async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), "live-session-"));
  try {
    const directory = path.join(root, "project");
    const file = path.join(directory, "session.jsonl");
    await mkdir(directory);
    await writeFile(file, '{"type":"session","id":"one"}\n');
    let now = 1;
    const reader = new LiveSessionReader(root, {
      discoveryIntervalMs: 60_000,
      now: () => now,
    });
    const initial = await reader.refresh();
    assert.equal(initial.rows.length, 1);
    assert.equal(initial.reset, true);

    await appendFile(file, '{"type":"message","id":"two"');
    const partial = await reader.refresh();
    assert.equal(partial.rows.length, 1);
    await appendFile(file, "}\n");
    const appended = await reader.refresh();
    assert.deepEqual(
      appended.rows.map((row) => row.id),
      ["one", "two"],
    );
    assert.equal(appended.reset, false);

    now += 1;
    assert.strictEqual((await reader.refresh()).rows, appended.rows);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("reader reports reset when the selected session is replaced", async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), "live-session-reset-"));
  try {
    const directory = path.join(root, "project");
    await mkdir(directory);
    await writeFile(path.join(directory, "one.jsonl"), '{"id":"one"}\n');
    let now = 1;
    const reader = new LiveSessionReader(root, {
      discoveryIntervalMs: 0,
      now: () => now++,
    });
    const first = await reader.refresh();
    await new Promise((resolve) => setTimeout(resolve, 10));
    await writeFile(path.join(directory, "two.jsonl"), '{"id":"two"}\n');
    const second = await reader.refresh();
    assert.equal(second.reset, true);
    assert.deepEqual(
      second.rows.map((row) => row.id),
      ["two"],
    );
    assert.notEqual(second.identity, first.identity);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});
