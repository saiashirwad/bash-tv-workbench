import assert from "node:assert/strict";
import { test } from "node:test";
import { inMemory, router } from "@kyoot/rpc";
import { authority } from "@kyoot/sync";
import { handlers, SyncRpc } from "@kyoot/sync/rpc";
import { browserStore } from "@kyoot/workbench-protocol/browser";
import type { RunSummary } from "@kyoot/workbench-protocol";

test("browser store projects every run mutation immediately and reconciles", async () => {
  const initial: RunSummary = {
    id: "r1",
    project: "kyoot",
    promptPreview: "test",
    title: "Test",
    status: "completed",
    createdAt: new Date(0).toISOString(),
    updatedAt: new Date(0).toISOString(),
    toolCount: 0,
    turnCount: 1,
    eventCursor: 0,
  };
  const releases: Array<() => void> = [];
  const releaseNext = async () => {
    for (let index = 0; index < 100 && releases.length === 0; index++)
      await new Promise((resolve) => setTimeout(resolve, 1));
    assert.ok(releases.length > 0, "mutation reached server");
    releases.shift()!();
  };
  const server = authority({
    initial: { runs: [initial] },
    apply: async (mutation) => {
      await new Promise<void>((resolve) => releases.push(resolve));
      const current = server.current().collections.runs?.[0] as RunSummary;
      const status = mutation.type === "runs/stop" ? "stopped" : "queued";
      const run = {
        ...current,
        status,
        updatedAt: new Date().toISOString(),
        turnCount: mutation.type === "runs/message" ? 2 : current.turnCount,
      } as RunSummary;
      return {
        changes: [
          {
            collection: "runs",
            operation: "put" as const,
            key: run.id,
            value: run,
          },
        ],
        result: run,
      };
    },
  });
  const store = browserStore({
    syncTransport: inMemory(router(SyncRpc, handlers(server))),
    rpcTransport: {
      request: async () => ({ version: 1, id: "x", ok: true, output: {} }),
      subscribe: () => ({ async *[Symbol.asyncIterator]() {} }),
    },
  });
  await store.start();
  const message = store.messageRun("r1", "next");
  assert.equal(store.runs.get("r1")?.status, "queued");
  assert.equal(store.runs.get("r1")?.turnCount, 2);
  await releaseNext();
  await message;

  const compact = store.compactRun("r1");
  assert.equal(store.runs.get("r1")?.status, "compacting");
  await releaseNext();
  await compact;

  const stop = store.stopRun("r1");
  assert.equal(store.runs.get("r1")?.status, "stopped");
  await releaseNext();
  await stop;
  assert.equal(store.runs.get("r1")?.status, "stopped");
  store.stop();
});

test("browser store rolls back generated optimistic entities on rejection", async () => {
  let release = () => {};
  const server = authority({
    apply: async () => {
      await new Promise<void>((resolve) => {
        release = resolve;
      });
      throw new Error("denied");
    },
  });
  const store = browserStore({
    syncTransport: inMemory(router(SyncRpc, handlers(server))),
    rpcTransport: {
      request: async () => ({ version: 1, id: "x", ok: true, output: {} }),
      subscribe: () => ({ async *[Symbol.asyncIterator]() {} }),
    },
  });
  await store.start();
  const pending = store.createRun({
    id: "optimistic-run",
    project: "kyoot",
    prompt: "test",
  });
  assert.equal(store.runs.get("optimistic-run")?.status, "queued");
  for (let index = 0; index < 100 && release.toString() === "() => {}"; index++)
    await new Promise((resolve) => setTimeout(resolve, 1));
  release();
  await assert.rejects(pending);
  assert.equal(store.runs.get("optimistic-run"), undefined);
  store.stop();
});

test("workflow controls project task state and roll back rejected changes", async () => {
  const createdAt = new Date(0).toISOString();
  const workflow: any = {
    version: 1,
    id: "w1",
    title: "Workflow",
    status: "running",
    revision: 1,
    createdAt,
    startedAt: createdAt,
    endedAt: null,
    maxConcurrency: 2,
    failurePolicy: "continue",
    metadata: {},
    error: null,
    counts: { failed: 1 },
    tasks: {
      task: {
        id: "task",
        workflowId: "w1",
        prompt: "test",
        project: "kyoot",
        status: "failed",
        attempt: 1,
        createdAt,
        startedAt: createdAt,
        endedAt: createdAt,
        progress: null,
        progressLabel: null,
        output: null,
        error: "failed",
      },
    },
  };
  let release = () => {};
  const server = authority({
    initial: { workflows: [workflow] },
    apply: async () => {
      await new Promise<void>((resolve) => {
        release = resolve;
      });
      throw new Error("denied");
    },
  });
  const store = browserStore({
    syncTransport: inMemory(router(SyncRpc, handlers(server))),
    rpcTransport: {
      request: async () => ({ version: 1, id: "x", ok: true, output: {} }),
      subscribe: () => ({ async *[Symbol.asyncIterator]() {} }),
    },
  });
  await store.start();
  const pending = store.retryWorkflowTask("w1", "task");
  assert.equal(store.workflows.get("w1")?.tasks.task?.status, "queued");
  assert.equal(store.workflows.get("w1")?.counts.queued, 1);
  for (let index = 0; index < 100 && release.toString() === "() => {}"; index++)
    await new Promise((resolve) => setTimeout(resolve, 1));
  release();
  await assert.rejects(pending);
  assert.equal(store.workflows.get("w1")?.tasks.task?.status, "failed");
  assert.equal(store.workflows.get("w1")?.counts.failed, 1);
  store.stop();
});

test("file writes optimistically replace cached content and restore exact state", async () => {
  let reject = true;
  let release = () => {};
  const server = authority({
    apply: async () => {
      await new Promise<void>((resolve) => {
        release = resolve;
      });
      if (reject) throw new Error("conflict");
      return { changes: [], result: { path: "README.md", revision: "v2" } };
    },
  });
  const store = browserStore({
    syncTransport: inMemory(router(SyncRpc, handlers(server))),
    rpcTransport: {
      request: async () => ({
        version: 1,
        id: "x",
        ok: true,
        output: {
          path: "README.md",
          content: "before",
          revision: "v1",
          version: "v1",
          binary: false,
          mime: "text/plain",
        },
      }),
      subscribe: () => ({ async *[Symbol.asyncIterator]() {} }),
    },
  });
  await store.start();
  const file = store.readFile("kyoot", "README.md");
  await file.load();
  const failed = store.writeFile({
    project: "kyoot",
    path: "README.md",
    content: "optimistic",
    expectedRevision: "v1",
  });
  assert.equal(file.get().value?.content, "optimistic");
  assert.equal(file.get().stale, true);
  for (let index = 0; index < 100 && release.toString() === "() => {}"; index++)
    await new Promise((resolve) => setTimeout(resolve, 1));
  release();
  await assert.rejects(failed);
  assert.equal(file.get().value?.content, "before");
  assert.equal(file.get().value?.revision, "v1");

  reject = false;
  release = () => {};
  const successful = store.writeFile({
    project: "kyoot",
    path: "README.md",
    content: "after",
    expectedRevision: "v1",
  });
  assert.equal(file.get().value?.content, "after");
  for (let index = 0; index < 100 && release.toString() === "() => {}"; index++)
    await new Promise((resolve) => setTimeout(resolve, 1));
  release();
  await successful;
  assert.equal(file.get().value?.revision, "v2");
  assert.equal(file.get().stale, false);
  store.stop();
});

test("browser store exposes collections and mutations without fetch calls", async () => {
  const run: RunSummary = {
    id: "r1",
    project: "kyoot",
    title: "Test",
    promptPreview: "test",
    status: "queued",
    createdAt: new Date(0).toISOString(),
    updatedAt: new Date(0).toISOString(),
    toolCount: 0,
    turnCount: 1,
    eventCursor: 0,
  };
  const server = authority({
    apply: async () => ({
      changes: [
        { collection: "runs", operation: "put", key: run.id, value: run },
      ],
    }),
  });
  const store = browserStore({
    syncTransport: inMemory(router(SyncRpc, handlers(server))),
    rpcTransport: {
      request: async () => ({ version: 1, id: "x", ok: true, output: {} }),
      subscribe: () => ({ async *[Symbol.asyncIterator]() {} }),
    },
  });
  await store.start();
  await store.createRun({ project: "kyoot", prompt: "test" });
  assert.equal(store.runs.get("r1")?.promptPreview, "test");
  store.stop();
});
