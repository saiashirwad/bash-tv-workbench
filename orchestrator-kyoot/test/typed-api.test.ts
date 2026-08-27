import assert from "node:assert/strict";
import { test } from "node:test";
import { client, provide } from "@kyoot/rpc";
import { fetchTransport } from "@kyoot/rpc/http";
import { make } from "@kyoot/sync";
import { fromRpc, SyncRpc } from "@kyoot/sync/rpc";
import { Kyoot, Fail } from "kyoot";
import {
  WorkbenchClient,
  type Run,
  type RunSummary,
} from "@kyoot/workbench-protocol";
import {
  makeTypedApi,
  summarizeRun,
  type WorkbenchBackend,
} from "../src/typed-api.ts";

const now = new Date(0).toISOString();
const runs = new Map<string, Run>();
const backend: WorkbenchBackend = {
  listRuns: async () => [...runs.values()].map(summarizeRun),
  listProjects: async () => [{ id: "kyoot", name: "Kyoot", writable: true }],
  liveSession: async (input) => ({ id: "live", ...input }),
  getRun: async (id) => runs.get(id)!,
  createRun: async ({ project, prompt, title }) => {
    const run: Run = {
      id: `r${runs.size + 1}`,
      project,
      prompt,
      title,
      status: "queued",
      createdAt: now,
      updatedAt: now,
    };
    runs.set(run.id, run);
    return run;
  },
  messageRun: async ({ id }) => ({ ...runs.get(id)!, status: "running" }),
  compactRun: async (id) => ({ ...runs.get(id)!, status: "compacting" }),
  stopRun: async (id) => ({ ...runs.get(id)!, status: "cancelled" }),
  fileTree: async () => [
    { name: "README.md", path: "README.md", type: "file", size: 5 },
  ],
  readFile: async (_project, path) => ({
    path,
    content: "hello",
    revision: "one",
    binary: false,
    mime: "text/plain",
    editable: true,
  }),
  writeFile: async ({ path }) => ({ path, revision: "two" }),
  searchFiles: async () => [],
  gitInfo: async () => ({
    branch: "main",
    upstream: "",
    ahead: 0,
    behind: 0,
    status: "",
    commits: [],
    latest: null,
    detail: null,
  }),
  gitCommits: async () => [],
  gitDiff: async (_project, commit) => ({ commit, diff: "" }),
};

const transportFor = (
  app: (request: Request) => Promise<Response>,
  path: string,
) =>
  fetchTransport({
    url: `https://workbench.test/${path}`,
    fetch: async (input, init) => app(new Request(input, init)),
  });

test("run summaries exclude transcript and full prompt payloads", () => {
  const summary = summarizeRun({
    id: "large",
    project: "kyoot",
    title: "Large",
    prompt: "p".repeat(20_000),
    status: "running",
    createdAt: now,
    updatedAt: now,
    events: [{ id: "event", sequence: 9, text: "x".repeat(100_000) }],
    toolCount: 1,
    turnCount: 1,
  });
  assert.equal(summary.promptPreview.length, 240);
  assert.equal(summary.eventCursor, 9);
  assert.equal("prompt" in summary, false);
  assert.equal("events" in summary, false);
  assert.ok(Buffer.byteLength(JSON.stringify(summary)) < 1_000);
});

test("RPC request cancellation reaches typed platform operations", async () => {
  let operationSignal: AbortSignal | undefined;
  const api = await makeTypedApi({
    ...backend,
    invokePlatform: (_operation, _input, options) => {
      operationSignal = options?.signal;
      return new Promise((_resolve, reject) => {
        const abort = () =>
          reject(options?.signal?.reason ?? new Error("aborted"));
        options?.signal?.addEventListener("abort", abort, { once: true });
      });
    },
  });
  const controller = new AbortController();
  const pending = api.workbenchApp(
    new Request("https://workbench.test/rpc", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        version: 1,
        id: "cancel-platform",
        procedure: "platform.call",
        input: { operation: "workbench_exec", input: {} },
      }),
      signal: controller.signal,
    }),
  );
  await new Promise((resolve) => setTimeout(resolve, 10));
  controller.abort();
  await pending;
  assert.equal(operationSignal?.aborted, true);
});

test("RPC request cancellation reaches typed content search", async () => {
  let searchSignal: AbortSignal | undefined;
  const api = await makeTypedApi({
    ...backend,
    contentSearch: (_input, options) => {
      searchSignal = options?.signal;
      return new Promise((_resolve, reject) => {
        const abort = () =>
          reject(options?.signal?.reason ?? new Error("aborted"));
        options?.signal?.addEventListener("abort", abort, { once: true });
      });
    },
  });
  const controller = new AbortController();
  const pending = api.workbenchApp(
    new Request("https://workbench.test/rpc", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        version: 1,
        id: "cancel-search",
        procedure: "files.contentSearch",
        input: { project: "kyoot", query: "needle" },
      }),
      signal: controller.signal,
    }),
  );
  await new Promise((resolve) => setTimeout(resolve, 10));
  controller.abort();
  await pending;
  assert.equal(searchSignal?.aborted, true);
});

test("an external agent creation appears in an already-connected Workbench run collection", async () => {
  runs.clear();
  const api = await makeTypedApi(backend);
  const externalRpc = transportFor(api.workbenchApp, "rpc");
  const workbenchSync = make(
    fromRpc(client(SyncRpc), transportFor(api.syncApp, "sync")),
    { reconnectMs: 1 },
  );
  await workbenchSync.start();

  const observed: RunSummary[][] = [];
  const collection = workbenchSync.collection<RunSummary>("runs");
  const unsubscribe = collection.subscribe((next) => observed.push([...next]));
  const created = await Kyoot.runPromise(
    WorkbenchClient.runs
      .create({
        project: "kyoot",
        prompt: "created by external WebMCP client",
        title: "External task",
      })
      .pipe(provide(externalRpc), Fail.orThrow),
  );

  const deadline = Date.now() + 1_000;
  while (!collection.get(created.id) && Date.now() < deadline)
    await new Promise((resolve) => setTimeout(resolve, 10));
  assert.equal(collection.get(created.id)?.title, "External task");
  assert.ok(
    observed.some((snapshot) => snapshot.some((run) => run.id === created.id)),
    "subscribed Workbench collection did not observe the external run",
  );

  unsubscribe();
  workbenchSync.stop();
});

test("typed Workbench RPC and sync collections share one backend", async () => {
  runs.clear();
  const api = await makeTypedApi(backend);
  const rpcTransport = transportFor(api.workbenchApp, "rpc");
  const syncTransport = transportFor(api.syncApp, "sync");
  const sync = make(fromRpc(client(SyncRpc), syncTransport), {
    reconnectMs: 1,
  });
  await sync.start();

  const run = await Kyoot.runPromise(
    WorkbenchClient.runs
      .create({ project: "kyoot", prompt: "test" })
      .pipe(provide(rpcTransport), Fail.orThrow),
  );
  await new Promise((resolve) => setTimeout(resolve, 10));
  assert.equal(
    sync.collection<RunSummary>("runs").get(run.id)?.promptPreview,
    "test",
  );
  const live = await Kyoot.runPromise(
    WorkbenchClient.live
      .session({ messages: true, trajectory: false })
      .pipe(provide(rpcTransport), Fail.orThrow),
  );
  assert.deepEqual(live, { id: "live", messages: true, trajectory: false });

  await Kyoot.runPromise(
    WorkbenchClient.files
      .write({ project: "kyoot", path: "README.md", content: "next" })
      .pipe(provide(rpcTransport), Fail.orThrow),
  );
  const invalidations = await Kyoot.runPromise(
    WorkbenchClient.invalidations
      .since({ after: 0 })
      .pipe(provide(rpcTransport), Fail.orThrow),
  );
  assert.deepEqual(invalidations.items[0]?.keys, [
    ["file", "kyoot", "README.md"],
    ["tree", "kyoot"],
    ["git", "status", "kyoot"],
  ]);
  sync.stop();
});
