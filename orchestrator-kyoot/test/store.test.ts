import assert from "node:assert/strict";
import { test } from "node:test";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { InvalidTransition, transition, type Run } from "../src/run.ts";
import { directory } from "../src/store.ts";

const run = (status: Run["status"] = "queued"): Run => ({
  version: 1,
  id: "run-1",
  title: "Test",
  prompt: "Test",
  cwd: "/work",
  sessionDir: "/state/run-1/session",
  createdAt: new Date().toISOString(),
  startedAt: null,
  endedAt: null,
  status,
  pid: null,
  exitCode: null,
  error: null,
  events: [],
  output: "",
  turnCount: 1,
  creator: null,
  originChat: null,
});

test("run transitions reject impossible lifecycle edges", () => {
  assert.equal(transition(run(), "starting").status, "starting");
  assert.throws(() => transition(run(), "completed"), InvalidTransition);
});

test("directory store serializes atomic writes and keeps the newest value", async (t) => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "kyoot-runs-"));
  t.after(() => fs.rm(root, { recursive: true, force: true }));
  const store = await directory(root);
  const writes = Array.from({ length: 20 }, (_, index) =>
    store.put({ ...run(), output: String(index) }),
  );
  await Promise.all(writes);
  await store.flush();
  const parsed = JSON.parse(await fs.readFile(path.join(root, "run-1", "run.json"), "utf8"));
  assert.equal(parsed.output, "19");
  assert.equal((await fs.stat(path.join(root, "run-1", "run.json"))).mode & 0o777, 0o600);
  assert.deepEqual(
    (await fs.readdir(path.join(root, "run-1"))).filter((name) => name.endsWith(".tmp")),
    [],
  );
});

test("directory store recovers active records as interrupted", async (t) => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "kyoot-recovery-"));
  t.after(() => fs.rm(root, { recursive: true, force: true }));
  await fs.mkdir(path.join(root, "run-1"));
  await fs.writeFile(
    path.join(root, "run-1", "run.json"),
    JSON.stringify({ ...run("running"), pid: 123 }),
  );
  const store = await directory(root);
  const restored = await store.get("run-1");
  assert.equal(restored?.status, "interrupted");
  assert.equal(restored?.pid, null);
});
