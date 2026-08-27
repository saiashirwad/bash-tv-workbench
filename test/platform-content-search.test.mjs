import assert from "node:assert/strict";
import { mkdtemp, mkdir, symlink, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { makeWorkbenchPlatform } from "../workbench-platform.mjs";

async function fixture(t) {
  const root = await mkdtemp(
    path.join(os.tmpdir(), "workbench-content-search-"),
  );
  const stateRoot = path.join(root, ".state");
  await mkdir(path.join(root, "src"));
  await mkdir(path.join(root, "docs"));
  await writeFile(
    path.join(root, "src", "one.ts"),
    "before\nneedle literal\nafter\nconst item42 = true;\nneedle again\n",
  );
  await writeFile(path.join(root, "docs", "one.md"), "needle docs\n");
  await writeFile(
    path.join(root, "src", "large.txt"),
    `needle ${"x".repeat(2000)}\n`,
  );
  await writeFile(
    path.join(root, "src", "binary.bin"),
    Buffer.from("needle\0binary\n"),
  );
  const outside = await mkdtemp(
    path.join(os.tmpdir(), "workbench-search-outside-"),
  );
  await writeFile(path.join(outside, "secret.txt"), "needle outside\n");
  await symlink(outside, path.join(root, "escape"));
  const platform = makeWorkbenchPlatform({
    projects: new Map([["p", { id: "p", root }]]),
    stateRoot,
  });
  t.after(() => platform.shutdown());
  return platform;
}

test("content search supports literal/regex queries, context, globs, binary and file-size exclusion", async (t) => {
  const platform = await fixture(t);
  const literal = await platform.contentSearch({
    project: "p",
    query: "needle literal",
    contextLines: 1,
  });
  assert.deepEqual(
    literal.matches.map((match) => [match.path, match.line, match.text]),
    [["src/one.ts", 2, "needle literal"]],
  );
  assert.deepEqual(literal.matches[0].contextBefore, [
    { line: 1, text: "before" },
  ]);
  assert.deepEqual(literal.matches[0].contextAfter, [
    { line: 3, text: "after" },
  ]);
  assert.equal(literal.truncated, false);

  const regex = await platform.contentSearch({
    project: "p",
    query: "item\\d+",
    regex: true,
  });
  assert.equal(regex.matches[0].line, 4);
  const globbed = await platform.contentSearch({
    project: "p",
    query: "needle",
    include: ["*.ts"],
    exclude: ["docs/**"],
    maxFileSize: 1000,
  });
  assert.ok(globbed.matches.every((match) => match.path === "src/one.ts"));
  assert.ok(
    !globbed.matches.some(
      (match) =>
        match.path.endsWith("binary.bin") ||
        match.path.endsWith("large.txt") ||
        match.path.startsWith("escape/"),
    ),
  );
});

test("content search reports truncation and timeout explicitly", async (t) => {
  const platform = await fixture(t);
  const limited = await platform.contentSearch({
    project: "p",
    query: "needle",
    limit: 1,
  });
  assert.equal(limited.matches.length, 1);
  assert.equal(limited.truncated, true);
  await assert.rejects(
    platform.contentSearch({ project: "p", query: "needle", timeoutMs: 1 }),
    (error) => error._tag === "SearchTimeout",
  );
});
