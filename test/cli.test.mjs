import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import http from "node:http";
import path from "node:path";
import { promisify } from "node:util";
import test from "node:test";

const execute = promisify(execFile);
const cli = path.resolve("bin/bash-workbench.mjs");

test("CLI discovers platform operations without a server", async () => {
  const { stdout } = await execute(process.execPath, [
    cli,
    "op",
    "list",
    "--compact",
  ]);
  const operations = JSON.parse(stdout);
  assert.ok(operations.length >= 25);
  assert.ok(
    operations.some((operation) => operation.name === "workbench_exec"),
  );
});

test("CLI sends typed RPC commands and prints JSON", async (t) => {
  const server = http.createServer(async (request, response) => {
    const chunks = [];
    for await (const chunk of request) chunks.push(chunk);
    const call = JSON.parse(Buffer.concat(chunks).toString("utf8"));
    assert.equal(call.procedure, "runs.list");
    response.writeHead(200, { "content-type": "application/json" });
    response.end(
      JSON.stringify({
        version: 1,
        id: call.id,
        ok: true,
        output: [{ id: "run-one", status: "running" }],
      }),
    );
  });
  await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
  t.after(() => server.close());
  const address = server.address();
  const { stdout } = await execute(process.execPath, [
    cli,
    "--url",
    `http://127.0.0.1:${address.port}`,
    "runs",
    "list",
    "--limit",
    "1",
    "--compact",
  ]);
  assert.deepEqual(JSON.parse(stdout), [{ id: "run-one", status: "running" }]);
});
