import assert from "node:assert/strict";
import * as fsp from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { Fail, Kyoot } from "kyoot";
import { FileSystem, Memory } from "@kyoot/platform";
import * as Node from "@kyoot/platform/node";

const scenario = (root: string) =>
  Kyoot.gen(function* () {
    yield* FileSystem.mkdir(`${root}/a/b`, { recursive: true });
    yield* FileSystem.writeFile(`${root}/a/b/hello.txt`, "hello");
    yield* FileSystem.appendFile(`${root}/a/b/hello.txt`, " world");
    yield* FileSystem.rename(`${root}/a/b/hello.txt`, `${root}/a/hi.txt`);
    const text = yield* FileSystem.readFile(`${root}/a/hi.txt`);
    const { type, size } = yield* FileSystem.stat(`${root}/a/hi.txt`);
    const listing = yield* FileSystem.readDir(`${root}/a`);
    yield* FileSystem.remove(`${root}/a/b`);
    const removed = !(yield* FileSystem.exists(`${root}/a/b`));
    return { text, type, size, listing: listing.sort(), removed };
  });

const expected = {
  text: "hello world",
  type: "file",
  size: 11,
  listing: ["b", "hi.txt"],
  removed: true,
};

test("the same program runs against the in-memory file system", () => {
  const [result, files] = Kyoot.runSync(scenario("/tmp").pipe(Memory.fs(), Fail.orThrow));
  assert.deepEqual(result, expected);
  assert.deepEqual(files, { "/tmp/a/hi.txt": "hello world" });
});

test("and against the real one", async () => {
  const root = await fsp.mkdtemp(join(tmpdir(), "kyoot-"));
  try {
    const result = await Kyoot.runPromise(scenario(root).pipe(Node.fs, Fail.orThrow));
    assert.deepEqual(result, expected);
    assert.equal(await fsp.readFile(`${root}/a/hi.txt`, "utf8"), "hello world");
  } finally {
    await fsp.rm(root, { recursive: true });
  }
});

const seed = { "/d/inner.txt": "1", "/f.txt": "x" };

const code = (k: Kyoot<unknown, { fs: FileSystem.Op; fail: FileSystem.FsError }>) => {
  const r = Kyoot.runSync(k.pipe(Memory.fs(seed), Fail.run));
  return r.ok ? "ok" : r.cause._tag === "Fail" ? r.cause.error.code : "defect";
};

test("memory: errors carry codes", () => {
  assert.equal(code(FileSystem.readFile("/nope")), "NotFound");
  assert.equal(code(FileSystem.readFile("/d")), "IsADirectory");
  assert.equal(code(FileSystem.readDir("/f.txt")), "NotADirectory");
  assert.equal(code(FileSystem.mkdir("/d")), "AlreadyExists");
  assert.equal(code(FileSystem.mkdir("/x/y")), "NotFound");
  assert.equal(code(FileSystem.writeFile("/x/y.txt", "")), "NotFound");
  assert.equal(code(FileSystem.remove("/d")), "NotEmpty");
  assert.equal(code(FileSystem.remove("/d", { recursive: true })), "ok");
  assert.equal(code(FileSystem.rename("/d", "/e")), "ok");
});

test("memory: recursive mkdir does not replace a file", () => {
  const r = Kyoot.runSync(
    FileSystem.mkdir("/file", { recursive: true }).pipe(Memory.fs({ "/file": "x" }), Fail.run),
  );
  assert.ok(!r.ok && r.cause._tag === "Fail");
  assert.equal(r.cause.error.code, "AlreadyExists");
});

test("node: errors carry codes", async () => {
  const r = await Kyoot.runPromise(FileSystem.readFile("/nope/nope").pipe(Node.fs, Fail.run));
  assert.ok(!r.ok && r.cause._tag === "Fail");
  assert.equal(r.cause.error.code, "NotFound");
  assert.equal(r.cause.error.op, "readFile");
});

test("node: exists returns false when a path component is not a directory", async () => {
  const root = await fsp.mkdtemp(join(tmpdir(), "kyoot-"));
  try {
    await fsp.writeFile(`${root}/file`, "x");
    const r = await Kyoot.runPromise(
      FileSystem.exists(`${root}/file/child`).pipe(Node.fs, Fail.orThrow),
    );
    assert.equal(r, false);
  } finally {
    await fsp.rm(root, { recursive: true });
  }
});
