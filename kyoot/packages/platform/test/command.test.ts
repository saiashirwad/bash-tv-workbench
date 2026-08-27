import assert from "node:assert/strict";
import { test } from "node:test";
import { Fail, Kyoot } from "kyoot";
import { Command } from "@kyoot/platform";
import * as Node from "@kyoot/platform/node";

const node = (script: string, options?: Command.Options) =>
  Command.run("node", ["-e", script], options).pipe(Node.command);

test("command: exit code and output", async () => {
  const out = await Kyoot.runPromise(
    node("process.stdout.write('hi'); process.stderr.write('!'); process.exit(3)").pipe(
      Fail.orThrow,
    ),
  );
  assert.deepEqual(out, { code: 3, stdout: "hi", stderr: "!" });
});

test("command: stdin, cwd, env", async () => {
  const out = await Kyoot.runPromise(
    node("process.stdin.pipe(process.stdout); console.error(process.cwd(), process.env.KYOOT)", {
      stdin: "ping",
      cwd: "/",
      env: { KYOOT: "yes" },
    }).pipe(Fail.orThrow),
  );
  assert.equal(out.stdout, "ping");
  assert.equal(out.stderr, "/ yes\n");
});

test("command: a program that cannot start is a CommandError", async () => {
  const r = await Kyoot.runPromise(
    Command.run("kyoot-no-such-binary").pipe(Node.command, Fail.run),
  );
  assert.ok(!r.ok && r.cause._tag === "Fail" && r.cause.error instanceof Command.CommandError);
});

test("command: a fake handler", () => {
  const out = Kyoot.runSync(
    Command.run("ls", ["-la"]).pipe(
      Command.handle({
        onOp: (op, resume) => resume({ code: 0, stdout: op.args.join(" "), stderr: "" }),
      }),
      Fail.orThrow,
    ),
  );
  assert.equal(out.stdout, "-la");
});
