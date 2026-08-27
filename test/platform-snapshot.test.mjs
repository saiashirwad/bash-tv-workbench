import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import test from "node:test";
import fsp from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { makeWorkbenchPlatform } from "../workbench-platform.mjs";

function git(cwd, ...args) {
  const result = spawnSync("git", args, { cwd, encoding: "utf8" });
  assert.equal(result.status, 0, result.stderr);
  return result.stdout.trim();
}

test("versioned snapshot restores Git refs, dirty tracked files, and untracked files without archiving .git", async (t) => {
  const root = await fsp.mkdtemp(path.join(os.tmpdir(), "workbench-snapshot-test-"));
  const source = path.join(root, "source"), destination = path.join(root, "destination"), stateRoot = path.join(root, "state");
  await fsp.mkdir(source); await fsp.mkdir(destination);
  git(source, "init", "-b", "snapshot-branch"); git(source, "config", "user.name", "Snapshot Test"); git(source, "config", "user.email", "snapshot@example.test");
  await fsp.writeFile(path.join(source, "tracked.txt"), "committed\n");
  await fsp.writeFile(path.join(source, ".gitignore"), "ignored.txt\n");
  git(source, "add", "tracked.txt", ".gitignore"); git(source, "commit", "-m", "snapshot base");
  const commit = git(source, "rev-parse", "HEAD");
  await fsp.writeFile(path.join(source, "tracked.txt"), "dirty tracked\n");
  await fsp.writeFile(path.join(source, "untracked.txt"), "untracked\n");
  await fsp.writeFile(path.join(source, "ignored.txt"), "ignored\n");
  await fsp.writeFile(path.join(destination, "obsolete.txt"), "remove me\n");

  const projects = new Map([["source", { id: "source", root: source }], ["destination", { id: "destination", root: destination }]]);
  const platform = makeWorkbenchPlatform({ projects, stateRoot });
  t.after(async () => { await platform.shutdown(); await fsp.rm(root, { recursive: true, force: true }); });

  const snapshot = await platform.createSnapshot({ project: "source", name: "dirty" });
  assert.equal(snapshot.format, "snapshot-v1");
  assert.equal(snapshot.snapshot.formatVersion, 1);
  assert.equal(snapshot.snapshot.commit.oid, commit);
  assert.equal(snapshot.snapshot.branch, "snapshot-branch");
  assert.equal(snapshot.snapshot.dirty.isDirty, true);
  assert.deepEqual(snapshot.snapshot.dirty.untracked, ["untracked.txt"]);
  assert.equal(snapshot.snapshot.ignoredPolicy, "excluded");
  assert.ok(snapshot.snapshot.gitBundle?.sha256);
  assert.match(snapshot.snapshot.worktree.sha256, /^[a-f0-9]{64}$/);

  await platform.restoreSnapshot({ project: "destination", id: snapshot.id, confirm: true });
  assert.equal(await fsp.readFile(path.join(destination, "tracked.txt"), "utf8"), "dirty tracked\n");
  assert.equal(await fsp.readFile(path.join(destination, "untracked.txt"), "utf8"), "untracked\n");
  await assert.rejects(fsp.access(path.join(destination, "ignored.txt")));
  await assert.rejects(fsp.access(path.join(destination, "obsolete.txt")));
  assert.equal(git(destination, "rev-parse", "HEAD"), commit);
  assert.equal(git(destination, "branch", "--show-current"), "snapshot-branch");
  assert.match(git(destination, "status", "--porcelain=v1", "--untracked-files=all"), /^M tracked\.txt\n\?\? untracked\.txt$/);
  assert.ok((await fsp.stat(path.join(destination, ".git"))).isDirectory());
});
