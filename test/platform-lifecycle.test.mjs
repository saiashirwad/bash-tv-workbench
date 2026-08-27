import assert from "node:assert/strict";
import test from "node:test";
import fsp from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { makeWorkbenchPlatform } from "../workbench-platform.mjs";

const processExists = (pid) => {
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    if (error.code === "ESRCH") return false;
    throw error;
  }
};
const waitForFile = async (file) => {
  for (let attempt = 0; attempt < 100; attempt++) {
    try {
      return Number(await fsp.readFile(file, "utf8"));
    } catch (error) {
      if (error.code !== "ENOENT") throw error;
      await new Promise((resolve) => setTimeout(resolve, 10));
    }
  }
  throw new Error(`Timed out waiting for ${file}`);
};

async function fixture(t, platformOptions = {}) {
  const root = await fsp.mkdtemp(path.join(os.tmpdir(), "workbench-platform-"));
  const projectRoot = path.join(root, "project");
  await fsp.mkdir(projectRoot);
  await fsp.writeFile(path.join(projectRoot, "file.txt"), "hello");
  const { spawnSync } = await import("node:child_process");
  spawnSync("git", ["init", "-q"], { cwd: projectRoot });
  spawnSync("git", ["add", "file.txt"], { cwd: projectRoot });
  const platform = makeWorkbenchPlatform({
    projects: new Map([["test", { id: "test", root: projectRoot }]]),
    stateRoot: path.join(root, "state"),
    ...platformOptions,
  });
  t.after(async () => {
    await platform.shutdown();
    await fsp.rm(root, { recursive: true, force: true });
  });
  return { platform, root };
}

async function waitForProcess(platform, id, status = "exited") {
  for (let attempt = 0; attempt < 100; attempt++) {
    const record = await platform.readProcess({ id });
    if (record.status === status) return record;
    await new Promise((resolve) => setTimeout(resolve, 5));
  }
  throw new Error(`Timed out waiting for process ${id} to become ${status}`);
}

test("one-shot output uses independent byte cursors without duplication", async (t) => {
  const { platform } = await fixture(t);
  const first = await platform.exec({
    project: "test",
    command: "printf 'α-out'; printf 'β-err' >&2",
    maxOutputBytes: 1024,
  });
  assert.equal(first.stdout, "α-out");
  assert.equal(first.stderr, "β-err");
  const second = await platform.readOutput({
    outputId: first.outputId,
    stdoutCursor: first.stdoutCursor,
    stderrCursor: first.stderrCursor,
  });
  assert.equal(second.stdout, "");
  assert.equal(second.stderr, "");
  assert.equal(second.truncated, false);
});

test("one-shot cancellation promptly terminates its entire process group", async (t) => {
  const { platform, root } = await fixture(t);
  const pidFile = path.join(root, "cancelled-grandchild.pid");
  const controller = new AbortController();
  const started = Date.now();
  const running = platform.exec(
    {
      project: "test",
      command: `(trap '' TERM; sleep 30) & echo $! > '${pidFile}'; wait`,
      timeoutMs: 30_000,
    },
    { signal: controller.signal },
  );
  const grandchild = await waitForFile(pidFile);
  controller.abort();
  await assert.rejects(running, (error) => error._tag === "OperationCancelled");
  assert.ok(
    Date.now() - started < 1_000,
    "cancellation should settle promptly",
  );
  await new Promise((resolve) => setTimeout(resolve, 500));
  assert.equal(
    processExists(grandchild),
    false,
    "cancelled grandchild survived",
  );
});

test("one-shot timeout promptly terminates its entire process group", async (t) => {
  const { platform, root } = await fixture(t);
  const pidFile = path.join(root, "timed-out-grandchild.pid");
  const started = Date.now();
  const result = await platform.exec({
    project: "test",
    command: `(trap '' TERM; sleep 30) & echo $! > '${pidFile}'; wait`,
    timeoutMs: 100,
  });
  const grandchild = await waitForFile(pidFile);
  assert.equal(result.timedOut, true);
  assert.ok(Date.now() - started < 1_000, "timeout should settle promptly");
  await new Promise((resolve) => setTimeout(resolve, 500));
  assert.equal(
    processExists(grandchild),
    false,
    "timed-out grandchild survived",
  );
});

test("managed process reports interleaved streams and idempotent stop", async (t) => {
  const { platform } = await fixture(t);
  const started = await platform.startProcess({
    project: "test",
    command: "printf out; printf err >&2; sleep .05; printf done",
  });
  await waitForProcess(platform, started.id);
  const read = await platform.readProcess({
    id: started.id,
    stdoutCursor: 0,
    stderrCursor: 0,
  });
  assert.equal(read.stdout, "outdone");
  assert.equal(read.stderr, "err");
  assert.equal(read.status, "exited");
  const stopped = await platform.stopProcess({ id: started.id });
  assert.equal(stopped.status, "exited");
});

test("managed process retention expires completed records but not running records", async (t) => {
  let time = 1_000;
  const { platform } = await fixture(t, {
    clock: () => time,
    processRetentionMs: 100,
  });
  const completed = await platform.startProcess({
    project: "test",
    command: ":",
  });
  await waitForProcess(platform, completed.id);
  const running = await platform.startProcess({
    project: "test",
    command: "sleep 30",
  });

  time += 101;
  assert.deepEqual(
    platform.listProcesses().map((record) => record.id),
    [running.id],
  );
  await assert.rejects(
    platform.readProcess({ id: completed.id }),
    (error) => error._tag === "UnknownProcess",
  );
});

test("managed process record limits evict the oldest completed record", async (t) => {
  let time = 1_000;
  const { platform } = await fixture(t, {
    clock: () => time,
    processRetentionMs: 10_000,
    maxProcessRecords: 2,
  });
  const oldest = await platform.startProcess({ project: "test", command: ":" });
  await waitForProcess(platform, oldest.id);
  time += 10;
  const newest = await platform.startProcess({ project: "test", command: ":" });
  await waitForProcess(platform, newest.id);
  time += 10;

  const replacement = await platform.startProcess({
    project: "test",
    command: "sleep 30",
  });
  assert.deepEqual(
    platform.listProcesses().map((record) => record.id),
    [newest.id, replacement.id],
  );
  await assert.rejects(
    platform.readProcess({ id: oldest.id }),
    (error) => error._tag === "UnknownProcess",
  );
});

test("managed process record limits refuse overflow when all records are active", async (t) => {
  const { platform } = await fixture(t, { maxProcessRecords: 2 });
  const first = await platform.startProcess({
    project: "test",
    command: "sleep 30",
  });
  const second = await platform.startProcess({
    project: "test",
    command: "sleep 30",
  });

  await assert.rejects(
    platform.startProcess({ project: "test", command: "sleep 30" }),
    (error) => error._tag === "ProcessLimit",
  );
  assert.deepEqual(
    platform.listProcesses().map((record) => record.id),
    [first.id, second.id],
  );
});

test("artifact access verifies checksums", async (t) => {
  const { platform } = await fixture(t);
  const artifact = await platform.exportProject({
    project: "test",
    format: "zip",
  });
  const target = await platform.artifactPath(artifact.id);
  await fsp.appendFile(target, "tamper");
  await assert.rejects(
    platform.artifactPath(artifact.id),
    /checksum verification failed/,
  );
});
