import assert from "node:assert/strict";
import test from "node:test";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import crypto from "node:crypto";
import { directory, RUN_INLINE_BYTES } from "../src/store.ts";
import { makeRunEngine } from "../src/run-engine.ts";

test("run events append to a versioned journal and paginate after restart", async (t) => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "run-journal-"));
  t.after(() => fs.rm(root, { recursive: true, force: true }));
  const store = await directory(root);
  const engine = await makeRunEngine(
    store,
    {
      turn: async (_run, _prompt, _continuing, context) => {
        await context.started();
        await context.emit({ type: "text", text: "one" });
        await context.emit({ type: "text", text: "two" });
        return { output: "done" };
      },
      compact: async () => ({}),
    },
    { stateRoot: root, coldStartSpacingMs: 0 },
  );
  const run = await engine.create({ prompt: "test", cwd: root });
  while ((await engine.get(run.id)).status !== "completed")
    await new Promise((resolve) => setTimeout(resolve, 5));
  const first = await engine.events(run.id, 0, 1);
  assert.equal(first.events.length, 1);
  assert.equal(first.more, true);
  assert.equal(first.events[0]!.sequence, 1);
  const second = await engine.events(run.id, first.nextCursor, 10);
  assert.equal(second.events[0]!.sequence, 2);
  assert.equal(second.completed, true);
  await engine.shutdown();
  const reopened = await directory(root);
  const restored = await reopened.get(run.id);
  assert.equal(restored?.events.length, 2);
  const summary = JSON.parse(await fs.readFile(path.join(root, run.id, "run.json"), "utf8"));
  assert.equal(summary.version, 3);
  assert.equal(summary.events, undefined);
});

test("large tool payloads and final output persist as checksummed run artifacts", async (t) => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "run-artifacts-"));
  t.after(() => fs.rm(root, { recursive: true, force: true }));
  const largeToolResult = "tool-result:" + "x".repeat(RUN_INLINE_BYTES * 2);
  const largeOutput = "final-output:" + "y".repeat(RUN_INLINE_BYTES * 2);
  const store = await directory(root);
  const engine = await makeRunEngine(
    store,
    {
      turn: async (_run, _prompt, _continuing, context) => {
        await context.started();
        await context.emit({ type: "tool", name: "read", result: largeToolResult });
        return { output: largeOutput };
      },
      compact: async () => ({}),
    },
    { stateRoot: root, coldStartSpacingMs: 0 },
  );
  const created = await engine.create({ prompt: "large", cwd: root });
  while ((await engine.get(created.id)).status !== "completed")
    await new Promise((resolve) => setTimeout(resolve, 5));

  const run = await engine.get(created.id);
  assert.ok(run.output.length < RUN_INLINE_BYTES);
  assert.ok(run.outputArtifact);
  assert.ok(run.artifactReferences?.some((item) => item.id === run.outputArtifact?.id));
  const page = await engine.events(created.id);
  const event = page.events[0]!;
  assert.equal(event.result, undefined);
  assert.ok(event.payloadArtifact);
  assert.ok(Buffer.byteLength(JSON.stringify(event)) < RUN_INLINE_BYTES);
  const eventReference = event.payloadArtifact as NonNullable<typeof run.outputArtifact>;
  const storedEvent = await store.readArtifact!(created.id, eventReference.id);
  assert.equal(storedEvent.metadata.contentType, "application/json");
  assert.equal(storedEvent.metadata.size, storedEvent.data.length);
  assert.equal(crypto.createHash("sha256").update(storedEvent.data).digest("hex"), eventReference.sha256);
  assert.equal(JSON.parse(storedEvent.data.toString()).result, largeToolResult);
  const storedOutput = await store.readArtifact!(created.id, run.outputArtifact!.id);
  assert.equal(storedOutput.data.toString(), largeOutput);
  assert.equal(crypto.createHash("sha256").update(storedOutput.data).digest("hex"), run.outputArtifact!.sha256);

  await engine.shutdown();
  const reopened = await directory(root);
  const restored = await reopened.get(created.id);
  assert.equal(restored?.outputArtifact?.sha256, run.outputArtifact!.sha256);
  assert.equal((await reopened.readArtifact!(created.id, run.outputArtifact!.id)).data.toString(), largeOutput);
  const journal = await fs.readFile(path.join(root, created.id, "events.jsonl"), "utf8");
  assert.ok(Buffer.byteLength(journal) < RUN_INLINE_BYTES);
  assert.doesNotMatch(journal, /tool-result:/);
});

test("run artifact retention removes expired and excess artifacts", async (t) => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "run-artifact-retention-"));
  t.after(() => fs.rm(root, { recursive: true, force: true }));
  const store = await directory(root, { maxArtifactsPerRun: 1, maxAgeMs: 20 });
  const engine = await makeRunEngine(
    store,
    {
      turn: async (_run, _prompt, _continuing, context) => {
        await context.started();
        await context.emit({ type: "tool", result: "a".repeat(RUN_INLINE_BYTES + 1) });
        await context.emit({ type: "tool", result: "b".repeat(RUN_INLINE_BYTES + 1) });
        return {};
      },
      compact: async () => ({}),
    },
    { stateRoot: root, coldStartSpacingMs: 0 },
  );
  const run = await engine.create({ prompt: "retention", cwd: root });
  while ((await engine.get(run.id)).status !== "completed")
    await new Promise((resolve) => setTimeout(resolve, 5));
  const refs = (await engine.events(run.id)).events.map((event) => event.payloadArtifact as { id: string });
  await assert.rejects(() => store.readArtifact!(run.id, refs[0]!.id), /not found/);
  assert.ok((await store.readArtifact!(run.id, refs[1]!.id)).data.length > RUN_INLINE_BYTES);
  await new Promise((resolve) => setTimeout(resolve, 25));
  assert.equal(await store.cleanupArtifacts!(run.id), 1);
  await assert.rejects(() => store.readArtifact!(run.id, refs[1]!.id), /not found/);
  await engine.shutdown();
});

test("version 1 and 2 run.json events migrate without loss", async (t) => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "run-old-"));
  t.after(() => fs.rm(root, { recursive: true, force: true }));
  for (const version of [1, 2] as const) {
    const id = `old-v${version}`;
    await fs.mkdir(path.join(root, id));
    await fs.writeFile(
      path.join(root, id, "run.json"),
      JSON.stringify({
        version,
        id,
        title: "old",
        prompt: "old",
        cwd: root,
        sessionDir: path.join(root, id, "session"),
        createdAt: new Date().toISOString(),
        status: "completed",
        startedAt: null,
        endedAt: null,
        pid: null,
        exitCode: 0,
        error: null,
        events: [{ id: `e${version}`, at: new Date().toISOString(), type: "text", text: `legacy-v${version}` }],
        output: "",
        turnCount: 1,
        creator: null,
        originChat: null,
      }),
    );
  }
  const store = await directory(root);
  for (const version of [1, 2] as const) {
    const id = `old-v${version}`;
    const restored = await store.get(id);
    assert.equal(restored?.events[0]?.sequence, 1);
    assert.match(await fs.readFile(path.join(root, id, "events.jsonl"), "utf8"), new RegExp(`legacy-v${version}`));
  }
});
