import assert from "node:assert/strict";
import { test } from "node:test";
import { WorkbenchClient, WorkbenchRpc, SyncMutations } from "@kyoot/workbench-protocol";

test("workbench protocol separates replicated mutations from on-demand queries", () => {
  assert.equal(WorkbenchRpc.shape.runs.create.kind, "mutation");
  assert.equal(WorkbenchRpc.shape.files.read.kind, "query");
  assert.equal(WorkbenchRpc.shape.live.session.kind, "query");
  assert.deepEqual(SyncMutations.stopRun("r1"), { type: "runs/stop", input: { id: "r1" } });
  assert.equal(typeof WorkbenchClient.files.search, "function");
});
