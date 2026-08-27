import assert from "node:assert/strict";
import { test } from "node:test";
import { Fail, Kyoot, Log } from "kyoot";
import { FileSystem, Memory } from "@kyoot/platform";
import * as Node from "@kyoot/platform/node";

test("a failure lands at the op, where the program's own catch sees it", async () => {
  const program = FileSystem.readFile("/nope").pipe(
    Fail.catchTag("FsError", (e: FileSystem.FsError) => Kyoot.succeed(e.code)),
  );
  assert.equal(Kyoot.runSync(program.pipe(Memory.fs()))[0], "NotFound");
  assert.equal(await Kyoot.runPromise(program.pipe(Node.fs)), "NotFound");
});

test("handlers between the program and the file system see every op", () => {
  const audit = FileSystem.intercept((op, next) =>
    Log.info(`${op.kind} ${op.path}`).map(() => next(op)),
  );
  const sandbox = (root: string) =>
    FileSystem.intercept((op, next) =>
      op.path.startsWith(root)
        ? next(op)
        : Fail.fail(new FileSystem.FsError(op.kind, op.path, "PermissionDenied", "sandbox")),
    );
  const dryRun = FileSystem.intercept((op, next) =>
    op.kind === "writeFile" ? Log.warn(`skipped ${op.path}`) : next(op),
  );
  const program = Kyoot.gen(function* () {
    yield* FileSystem.writeFile("/work/new.txt", "x");
    const listing = yield* FileSystem.readDir("/work");
    const leaked = yield* FileSystem.readFile("/etc/passwd").pipe(
      Fail.catchTag("FsError", (e: FileSystem.FsError) => Kyoot.succeed(e.code)),
    );
    return { listing, leaked };
  });
  const [[result, files], logs] = Kyoot.runSync(
    program.pipe(
      audit,
      sandbox("/work"),
      dryRun,
      Memory.fs({ "/work/old.txt": "", "/etc/passwd": "root" }),
      Log.collect,
      Fail.orThrow,
    ),
  );
  assert.deepEqual(result, { listing: ["old.txt"], leaked: "PermissionDenied" });
  assert.deepEqual(files, { "/work/old.txt": "", "/etc/passwd": "root" });
  assert.deepEqual(
    logs.map((l) => l.message),
    ["writeFile /work/new.txt", "skipped /work/new.txt", "readDir /work", "readFile /etc/passwd"],
  );
});
