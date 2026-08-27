import assert from "node:assert/strict";
import test from "node:test";
import fsp from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { makeWorkbenchPlatform } from "../workbench-platform.mjs";

async function fixture(t) {
  const root = await fsp.mkdtemp(path.join(os.tmpdir(), "workbench-security-"));
  const projectRoot = path.join(root, "project");
  const outside = path.join(root, "outside");
  await fsp.mkdir(projectRoot); await fsp.mkdir(outside); await fsp.writeFile(path.join(outside, "secret.txt"), "outside-secret");
  await fsp.symlink(outside, path.join(projectRoot, "escape"));
  const platform = makeWorkbenchPlatform({ projects: new Map([["test", { id: "test", root: projectRoot }]]), stateRoot: path.join(root, "state") });
  t.after(() => fsp.rm(root, { recursive: true, force: true }));
  return { platform, root, projectRoot };
}

test("project-scoped mutations reject traversal and symlink escapes", async (t) => {
  const { platform } = await fixture(t);
  await assert.rejects(platform.fsMutate({ project: "test", operation: "mkdir", path: "../outside/new" }), /escapes project root/);
  await assert.rejects(platform.fsMutate({ project: "test", operation: "delete", path: "escape/secret.txt", confirm: true }), /Symlink escapes project root/);
});

test("child commands receive an explicit environment without server secrets", async (t) => {
  const { platform } = await fixture(t);
  process.env.WORKBENCH_TEST_SECRET = "must-not-leak";
  t.after(() => delete process.env.WORKBENCH_TEST_SECRET);
  const result = await platform.exec({ project: "test", command: "printf '%s' \"${WORKBENCH_TEST_SECRET-unset}\"" });
  assert.equal(result.stdout, "unset");
  assert.doesNotMatch(JSON.stringify(result), /must-not-leak/);
});

test("extra child environment variables require the controlled allowlist", async (t) => {
  const { platform } = await fixture(t);
  await assert.rejects(platform.exec({ project: "test", command: "true", env: { NOT_ALLOWED: "value" } }), /not allowlisted/);
});
