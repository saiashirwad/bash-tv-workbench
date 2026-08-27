import assert from "node:assert/strict";
import { test } from "node:test";
import { memory } from "../src/store.ts";
import { makeRunEngine, type RunExecutor } from "../src/run-engine.ts";

const waitFor = async (condition: () => Promise<boolean>) => {
  for (let index = 0; index < 200; index++) {
    if (await condition()) return;
    await new Promise((resolve) => setTimeout(resolve, 2));
  }
  throw new Error("condition timed out");
};

test("normal runs execute concurrently and serialize operations per run", async () => {
  let active = 0, maximum = 0;
  const releases: Array<() => void> = [];
  const executor: RunExecutor = {
    turn: async (run, prompt, _continuing, context) => {
      active++;
      maximum = Math.max(maximum, active);
      await context.started(100 + active);
      await new Promise<void>((resolve) => releases.push(resolve));
      active--;
      return { output: `${run.output}${prompt}` };
    },
    compact: async () => ({ output: "compacted" }),
  };
  const engine = await makeRunEngine(memory(), executor, {
    stateRoot: "/state",
    maxConcurrency: 3,
    coldStartSpacingMs: 0,
  });
  const first = await engine.create({ cwd: "/work", prompt: "one" });
  const second = await engine.create({ cwd: "/work", prompt: "two" });
  const third = await engine.create({ cwd: "/work", prompt: "three" });
  await waitFor(async () => (await engine.list()).filter((run) => run.status === "running").length === 3);
  assert.equal(maximum, 3);
  await assert.rejects(() => engine.message(first.id, "too soon"), /active operation/);
  releases.splice(0).forEach((release) => release());
  await waitFor(async () => (await engine.list()).every((run) => run.status === "completed"));
  const continued = await engine.message(first.id, " again");
  assert.equal(continued.status, "queued");
  await waitFor(async () => (engine.get(first.id).then((run) => run.status === "running")));
  releases.splice(0).forEach((release) => release());
  await waitFor(async () => (engine.get(first.id).then((run) => run.status === "completed")));
  assert.equal((await engine.get(first.id)).turnCount, 2);
  assert.equal((await engine.get(second.id)).output, "two");
  assert.equal((await engine.get(third.id)).output, "three");
  await engine.shutdown();
});

test("stopping one run does not interrupt concurrent siblings", async () => {
  const executor: RunExecutor = {
    turn: async (_run, prompt, _continuing, context) => {
      await context.started();
      await new Promise<void>((resolve, reject) => {
        const timer = setTimeout(resolve, prompt === "keep" ? 20 : 1_000);
        context.signal.addEventListener("abort", () => {
          clearTimeout(timer);
          reject(new Error("aborted"));
        }, { once: true });
      });
      return { output: prompt };
    },
    compact: async () => ({}),
  };
  const engine = await makeRunEngine(memory(), executor, {
    stateRoot: "/state",
    maxConcurrency: 2,
    coldStartSpacingMs: 0,
  });
  const stopped = await engine.create({ cwd: "/work", prompt: "stop" });
  const kept = await engine.create({ cwd: "/work", prompt: "keep" });
  await waitFor(async () => (await engine.list()).filter((run) => run.status === "running").length === 2);
  await engine.stop(stopped.id);
  await waitFor(async () => (await engine.get(stopped.id)).status === "stopped");
  await waitFor(async () => (await engine.get(kept.id)).status === "completed");
  await engine.shutdown();
});
