import assert from "node:assert/strict";
import { test } from "node:test";
import { queryCache } from "@kyoot/sync/query";

test("query cache deduplicates loads and supports prefix invalidation", async () => {
  const cache = queryCache();
  let calls = 0;
  const query = cache.query(["file", "kyoot", "README.md"], async () => ++calls);
  assert.equal(await query.load(), 1);
  assert.equal(await query.load(), 1);
  cache.invalidate(["file", "kyoot"]);
  assert.equal(query.get().stale, true);
  assert.equal(await query.load(), 2);
});

test("failed queries remain stale and can retry", async () => {
  const cache = queryCache();
  let calls = 0;
  const query = cache.query(["git", "status", "kyoot"], async () => {
    if (++calls === 1) throw new Error("offline");
    return "clean";
  });
  await assert.rejects(query.load());
  assert.equal(query.get().stale, true);
  assert.equal(await query.load(), "clean");
});

test("clear aborts in-flight queries", async () => {
  const cache = queryCache();
  let aborted = false;
  const query = cache.query(
    ["slow"],
    (signal) =>
      new Promise((_resolve, reject) =>
        signal.addEventListener("abort", () => {
          aborted = true;
          reject(new Error("aborted"));
        }),
      ),
  );
  const pending = query.load();
  cache.clear();
  await assert.rejects(pending);
  assert.equal(aborted, true);
});
