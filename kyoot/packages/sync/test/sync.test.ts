import assert from "node:assert/strict";
import { test } from "node:test";
import { authority, make, type Change, type Delta, type SyncClient } from "@kyoot/sync";

const put = (id: string, title: string): Change => ({
  collection: "runs",
  operation: "put",
  key: id,
  value: { id, title },
});

test("authority replays revisions, resets stale cursors, and deduplicates mutations", async () => {
  let applies = 0;
  const server = authority({
    historyLimit: 1,
    apply: async (mutation) => {
      applies++;
      return { changes: [put(String((mutation.input as any).id), "created")], result: "ok" };
    },
  });
  const mutation = { id: "m1", baseRevision: 0, type: "create", input: { id: "r1" } };
  const first = await server.mutate(mutation);
  const second = await server.mutate(mutation);
  assert.deepEqual(second, first);
  assert.equal(applies, 1);
  server.commit([put("r2", "second")]);
  const stale = await server.snapshot(0);
  assert.equal(stale.reset, true);
});

test("engine hydrates, receives changes, and exposes collection subscriptions", async () => {
  const server = authority({
    initial: { runs: [{ id: "r1", title: "one" }] },
    apply: async () => ({ changes: [] }),
  });
  const engine = make(server, { reconnectMs: 1 });
  const seen: string[][] = [];
  const unsubscribe = engine
    .collection<{ id: string; title: string }>("runs")
    .subscribe((runs) => seen.push(runs.map((run) => run.title)));
  await engine.start();
  server.commit([put("r2", "two")]);
  await new Promise((resolve) => setTimeout(resolve, 5));
  assert.deepEqual(
    engine
      .collection<{ id: string; title: string }>("runs")
      .all()
      .map((run) => run.title),
    ["one", "two"],
  );
  assert.ok(seen.some((values) => values.includes("two")));
  unsubscribe();
  engine.stop();
});

test("optimistic mutations are visible immediately and roll back on failure", async () => {
  let reject = false;
  const server = authority({
    apply: async () => {
      if (reject) throw new Error("rejected");
      return { changes: [put("r1", "server")] };
    },
  });
  let release = () => {};
  const client: SyncClient = {
    ...server,
    mutate: async (mutation) => {
      await new Promise<void>((resolve) => {
        release = resolve;
      });
      return server.mutate(mutation);
    },
  };
  let sequence = 0;
  const engine = make(client, { mutationId: () => `m${++sequence}` });
  const pending = engine.mutate("create", {}, [put("r1", "optimistic")]);
  assert.equal((engine.collection<any>("runs").get("r1") as any).title, "optimistic");
  release();
  await pending;
  assert.equal((engine.collection<any>("runs").get("r1") as any).title, "server");

  reject = true;
  const failing = engine.mutate("create", {}, [put("r2", "temporary")]);
  release();
  await assert.rejects(failing);
  assert.equal(engine.collection("runs").get("r2"), undefined);
});

test("functional optimistic projections compose over pending mutations and authoritative deltas", async () => {
  const releases: Array<() => void> = [];
  const server = authority({
    initial: { runs: [{ id: "r1", status: "completed", turnCount: 1 }] },
    apply: async (mutation) => {
      await new Promise<void>((resolve) => releases.push(resolve));
      return {
        changes: [
          {
            collection: "runs",
            operation: "put",
            key: "r1",
            value: {
              id: "r1",
              status: mutation.type,
              turnCount: mutation.type === "message" ? 2 : 1,
            },
          },
        ],
      };
    },
  });
  const engine = make(server);
  await engine.start();
  const patch =
    (status: string, increment = 0) =>
    (read: any) => {
      const current = read("runs", "r1");
      return [
        {
          collection: "runs",
          operation: "put" as const,
          key: "r1",
          value: { ...current, status, turnCount: current.turnCount + increment },
        },
      ];
    };
  const message = engine.mutate("message", {}, patch("queued", 1));
  const stop = engine.mutate("stop", {}, patch("stopping"));
  assert.deepEqual(engine.collection<any>("runs").get("r1"), {
    id: "r1",
    status: "stopping",
    turnCount: 2,
  });
  releases.shift()!();
  await message;
  assert.equal(engine.collection<any>("runs").get("r1")?.status, "stopping");
  releases.shift()!();
  await stop;
  assert.equal(engine.collection<any>("runs").get("r1")?.status, "stop");
  engine.stop();
});

test("functional projections can target entities created by earlier pending overlays", async () => {
  let releaseFirst = () => {},
    releaseSecond = () => {};
  let index = 0;
  const client: SyncClient = {
    snapshot: async () => ({ reset: true, snapshot: { revision: 0, collections: { runs: [] } } }),
    changes: (_after, signal) => ({
      async *[Symbol.asyncIterator]() {
        await new Promise<void>((resolve) =>
          signal.addEventListener("abort", () => resolve(), { once: true }),
        );
      },
    }),
    mutate: async (mutation) => {
      await new Promise<void>((resolve) => {
        if (index++ === 0) releaseFirst = resolve;
        else releaseSecond = resolve;
      });
      return { id: mutation.id, revision: 0, result: null };
    },
  };
  const engine = make(client);
  await engine.start();
  const create = engine.mutate("create", {}, [
    {
      collection: "runs",
      operation: "put",
      key: "new",
      value: { id: "new", status: "queued" },
    },
  ]);
  const stop = engine.mutate("stop", {}, (read) => {
    const current = read<any>("runs", "new");
    return current
      ? [
          {
            collection: "runs",
            operation: "put",
            key: "new",
            value: { ...current, status: "stopped" },
          },
        ]
      : [];
  });
  assert.equal(engine.collection<any>("runs").get("new")?.status, "stopped");
  releaseFirst();
  await create;
  assert.equal(engine.collection<any>("runs").get("new")?.status, undefined);
  releaseSecond();
  await stop;
  engine.stop();
});

test("a revision gap triggers snapshot recovery", async () => {
  let snapshots = 0;
  const gap: SyncClient = {
    snapshot: async () => {
      snapshots++;
      return {
        reset: true,
        snapshot: {
          revision: snapshots === 1 ? 0 : 2,
          collections: { runs: snapshots === 1 ? [] : [{ id: "r2", title: "recovered" }] },
        },
      };
    },
    changes: (_after, signal) => ({
      async *[Symbol.asyncIterator]() {
        yield { revision: 2, changes: [] } satisfies Delta;
        await new Promise<void>((resolve) =>
          signal.addEventListener("abort", () => resolve(), { once: true }),
        );
      },
    }),
    mutate: async () => ({ id: "m", revision: 0, result: null }),
  };
  const engine = make(gap, { reconnectMs: 1 });
  await engine.start();
  await new Promise((resolve) => setTimeout(resolve, 8));
  assert.ok(snapshots >= 2);
  assert.equal((engine.collection<any>("runs").get("r2") as any).title, "recovered");
  engine.stop();
});
