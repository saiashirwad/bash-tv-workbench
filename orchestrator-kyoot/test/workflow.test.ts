import assert from "node:assert/strict";
import { test } from "node:test";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { makeEngine, type TaskExecutor } from "../src/workflow-engine.ts";
import { createWorkflow, InvalidWorkflow, type TaskRecord } from "../src/workflow.ts";
import { directory, memory } from "../src/workflow-store.ts";

const waitFor = async (check: () => Promise<boolean>, timeout = 2_000) => {
  const end = Date.now() + timeout;
  while (!(await check())) {
    if (Date.now() > end) throw new Error("Timed out waiting for workflow");
    await new Promise((resolve) => setTimeout(resolve, 2));
  }
};
const complete = (engine: Awaited<ReturnType<typeof makeEngine>>, id: string) =>
  waitFor(async () => ["completed", "failed", "cancelled"].includes((await engine.get(id)).status));
const definition = (tasks: Array<{ id: string; dependsOn?: string[]; retries?: number; timeoutMs?: number; continueOnError?: boolean }>) => ({
  id: "flow",
  title: "Test flow",
  maxConcurrency: 3,
  tasks: tasks.map((task) => ({ ...task, prompt: task.id, project: "kyoot" })),
});

test("validates missing dependencies and cycles", () => {
  assert.throws(() => createWorkflow(definition([{ id: "a", dependsOn: ["x"] }])), InvalidWorkflow);
  assert.throws(() => createWorkflow(definition([{ id: "a", dependsOn: ["b"] }, { id: "b", dependsOn: ["a"] }])), InvalidWorkflow);
});

test("DAG dependencies run after fan-out and join", async () => {
  const order: string[] = [];
  let active = 0;
  let peak = 0;
  const executor: TaskExecutor = { execute: async (task) => {
    active++;
    peak = Math.max(peak, active);
    order.push(`start:${task.id}`);
    await new Promise((resolve) => setTimeout(resolve, task.id === "root" ? 2 : 10));
    order.push(`end:${task.id}`);
    active--;
    return task.id;
  } };
  const engine = await makeEngine(memory(), executor, { maxConcurrency: 3, coldStartSpacingMs: 0 });
  await engine.submit(definition([
    { id: "root" },
    { id: "left", dependsOn: ["root"] },
    { id: "right", dependsOn: ["root"] },
    { id: "join", dependsOn: ["left", "right"] },
  ]));
  await complete(engine, "flow");
  assert.ok(order.indexOf("start:left") > order.indexOf("end:root"));
  assert.ok(order.indexOf("start:join") > order.indexOf("end:left"));
  assert.ok(order.indexOf("start:join") > order.indexOf("end:right"));
  assert.equal(peak, 2);
  await engine.shutdown();
});

test("running tasks can append dynamic work", async () => {
  const seen: string[] = [];
  const engine = await makeEngine(memory(), { execute: async (task, context) => {
    seen.push(task.id);
    if (task.id === "planner")
      await context.addTasks([
        { id: "child-a", prompt: "a", project: "kyoot", dependsOn: ["planner"] },
        { id: "child-b", prompt: "b", project: "kyoot", dependsOn: ["planner"] },
      ]);
    return task.id;
  } }, { coldStartSpacingMs: 0 });
  await engine.submit(definition([{ id: "planner" }]));
  await complete(engine, "flow");
  assert.deepEqual(new Set(seen), new Set(["planner", "child-a", "child-b"]));
  assert.equal(Object.keys((await engine.get("flow")).tasks).length, 3);
  await engine.shutdown();
});

test("rejected dynamic expansion does not poison the workflow lock", async () => {
  const engine = await makeEngine(memory(), { execute: async () => "ok" }, { coldStartSpacingMs: 0 });
  await engine.submit(definition([{ id: "one" }]));
  await complete(engine, "flow");
  await assert.rejects(
    engine.addTasks("flow", [{ id: "late", prompt: "late", project: "kyoot" }]),
    /Cannot add tasks/,
  );
  assert.equal((await engine.get("flow")).status, "completed");
  await engine.shutdown();
});

test("retries failures and records progress events", async () => {
  let attempts = 0;
  const store = memory();
  const engine = await makeEngine(store, { execute: async (_task, context) => {
    attempts++;
    await context.progress(0.5, "half");
    if (attempts === 1) throw new Error("retry me");
    return "ok";
  } }, { coldStartSpacingMs: 0 });
  await engine.submit(definition([{ id: "flaky", retries: 1 }]));
  await complete(engine, "flow");
  const task = (await engine.get("flow")).tasks.flaky!;
  assert.equal(task.status, "completed");
  assert.equal(task.attempt, 2);
  assert.ok((await store.events()).events.some((event) => event.type === "task.progress"));
  await engine.shutdown();
});

test("fail-fast skips dependents and cancels queued siblings", async () => {
  const engine = await makeEngine(memory(), { execute: async (task) => {
    if (task.id === "bad") throw new Error("boom");
    await new Promise((resolve) => setTimeout(resolve, 20));
  } }, { maxConcurrency: 1, coldStartSpacingMs: 0 });
  await engine.submit({ ...definition([
    { id: "bad" },
    { id: "queued" },
    { id: "dependent", dependsOn: ["bad"] },
  ]), failurePolicy: "fail-fast" });
  await complete(engine, "flow");
  const workflow = await engine.get("flow");
  assert.equal(workflow.status, "failed");
  assert.equal(workflow.tasks.bad?.status, "failed");
  assert.equal(workflow.tasks.queued?.status, "cancelled");
  assert.equal(workflow.tasks.dependent?.status, "skipped");
  await engine.shutdown();
});

test("timeouts and keyed task cancellation are observable", async () => {
  const engine = await makeEngine(memory(), { execute: async (_task, context) =>
    new Promise((_resolve, reject) => context.signal.addEventListener("abort", () => reject(context.signal.reason), { once: true })),
  }, { maxConcurrency: 2, coldStartSpacingMs: 0 });
  await engine.submit(definition([{ id: "timeout", timeoutMs: 10 }, { id: "cancel" }]));
  await waitFor(async () => (await engine.get("flow")).tasks.cancel?.status === "running");
  await engine.cancelTask("flow", "cancel");
  await complete(engine, "flow");
  const workflow = await engine.get("flow");
  assert.equal(workflow.tasks.timeout?.status, "failed");
  assert.equal(workflow.tasks.cancel?.status, "cancelled");
  await engine.shutdown();
});

test("journal supports collective and individual replay plus reset detection", async () => {
  const store = memory([], { eventLimit: 3 });
  const engine = await makeEngine(store, { execute: async (task, context) => {
    await context.emit("agent.delta", task.id);
  } }, { coldStartSpacingMs: 0 });
  await engine.submit(definition([{ id: "one" }, { id: "two" }]));
  await complete(engine, "flow");
  const page = await engine.events({ workflowId: "flow", taskId: "one" });
  assert.ok(page.events.every((event) => event.workflowId === "flow" && event.taskId === "one"));
  const stale = await engine.events({ after: 1 });
  assert.equal(stale.reset, true);
  await engine.shutdown();
});

test("directory store atomically persists and recovers active workflows", async (t) => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "workflow-store-"));
  t.after(() => fs.rm(root, { recursive: true, force: true }));
  const store = await directory(root);
  const workflow = { ...createWorkflow(definition([{ id: "one" }])), status: "running" as const };
  await store.put({ ...workflow, tasks: { one: { ...workflow.tasks.one!, status: "running" } } });
  await store.append({ workflowId: "flow", workflowRevision: 1, at: new Date().toISOString(), type: "task.started", taskId: "one" });
  await store.flush();
  const reopened = await directory(root);
  const recovered = await reopened.get("flow");
  assert.equal(recovered?.status, "interrupted");
  assert.equal(recovered?.tasks.one?.status, "interrupted");
  assert.equal((await reopened.events()).events.length, 1);
  assert.equal((await fs.stat(path.join(root, "workflows", "flow.json"))).mode & 0o777, 0o600);
  assert.match(await fs.readFile(path.join(root, "events.jsonl"), "utf8"), /task.started/);
});
