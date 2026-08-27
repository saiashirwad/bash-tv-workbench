import { Fail, Kyoot, Log } from "kyoot";
import { FileSystem, Memory } from "@kyoot/platform";

const audit = FileSystem.intercept((op, next) =>
  Log.info(`${op.kind} ${op.path}`).map(() => next(op)),
);

const sandbox = (root: string) =>
  FileSystem.intercept((op, next) =>
    op.path.startsWith(root)
      ? next(op)
      : Fail.fail(new FileSystem.FsError(op.kind, op.path, "PermissionDenied", `outside ${root}`)),
  );

const writes = new Set(["writeFile", "appendFile", "mkdir", "remove", "rename"]);

const dryRun = FileSystem.intercept((op, next) =>
  writes.has(op.kind) ? Log.warn(`skipped ${op.kind} ${op.path}`) : next(op),
);

const program = Kyoot.gen(function* () {
  yield* FileSystem.writeFile("/work/report.txt", "draft");
  const listing = yield* FileSystem.readDir("/work");
  const leaked = yield* FileSystem.readFile("/etc/passwd").pipe(
    Fail.catchTag("FsError", (e: FileSystem.FsError) => Kyoot.succeed(e.code)),
  );
  return { listing, leaked };
});

const [result, files] = Kyoot.runSync(
  program.pipe(
    audit,
    sandbox("/work"),
    dryRun,
    Memory.fs({ "/work/old.txt": "", "/etc/passwd": "root:x:0:0" }),
    Log.print,
    Fail.orThrow,
  ),
);
console.log(result, files);
