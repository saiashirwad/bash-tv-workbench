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

test("CLI accepts Boolean global options before the command", async () => {
  const { stdout } = await execute(process.execPath, [
    cli,
    "--compact",
    "op",
    "list",
  ]);
  assert.ok(Array.isArray(JSON.parse(stdout)));
});

test("CLI gives command-specific help without contacting the server", async () => {
  const { stdout } = await execute(process.execPath, [
    cli,
    "runs",
    "create",
    "--help",
  ]);
  assert.match(stdout, /Usage: .*runs create/);
  assert.match(stdout, /--prompt/);
  assert.doesNotMatch(stdout, /Core commands:/);
});

test("CLI waits for health without parsing its printed JSON", async (t) => {
  let attempts = 0;
  const server = http.createServer((_request, response) => {
    attempts += 1;
    response.writeHead(attempts < 3 ? 503 : 200, {
      "content-type": "application/json",
    });
    response.end(JSON.stringify({ ok: attempts >= 3 }));
  });
  await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
  t.after(() => server.close());
  const address = server.address();
  const { stdout } = await execute(process.execPath, [
    cli,
    "status",
    "--wait",
    "--url",
    `http://127.0.0.1:${address.port}`,
    "--interval",
    "10",
    "--wait-timeout",
    "1000",
    "--compact",
  ]);
  assert.deepEqual(JSON.parse(stdout), { ok: true });
  assert.equal(attempts, 3);
});

test("CLI registers a user project through typed RPC", async (t) => {
  const server = http.createServer(async (request, response) => {
    const chunks = [];
    for await (const chunk of request) chunks.push(chunk);
    const call = JSON.parse(Buffer.concat(chunks).toString("utf8"));
    assert.equal(call.procedure, "projects.register");
    assert.deepEqual(call.input, {
      root: "/home/bashtv/weather-app",
      id: "weather-app",
      name: "Weather App",
    });
    response.writeHead(200, { "content-type": "application/json" });
    response.end(
      JSON.stringify({
        version: 1,
        id: call.id,
        ok: true,
        output: { ...call.input, writable: true },
      }),
    );
  });
  await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
  t.after(() => server.close());
  const address = server.address();

  const { stdout } = await execute(process.execPath, [
    cli,
    "projects",
    "register",
    "--root",
    "/home/bashtv/weather-app",
    "--id",
    "weather-app",
    "--name",
    "Weather App",
    "--url",
    `http://127.0.0.1:${address.port}`,
    "--compact",
  ]);
  assert.deepEqual(JSON.parse(stdout), {
    root: "/home/bashtv/weather-app",
    id: "weather-app",
    name: "Weather App",
    writable: true,
  });
});

test("CLI creates a bounded batch of runs concurrently", async (t) => {
  let active = 0;
  let maximumActive = 0;
  const server = http.createServer(async (request, response) => {
    const chunks = [];
    for await (const chunk of request) chunks.push(chunk);
    const call = JSON.parse(Buffer.concat(chunks).toString("utf8"));
    assert.equal(call.procedure, "runs.create");
    active += 1;
    maximumActive = Math.max(maximumActive, active);
    await new Promise((resolve) => setTimeout(resolve, 30));
    active -= 1;
    response.writeHead(200, { "content-type": "application/json" });
    response.end(
      JSON.stringify({
        version: 1,
        id: call.id,
        ok: true,
        output: {
          id: `run-${call.input.title}`,
          project: call.input.project,
          title: call.input.title,
          status: "queued",
          prompt: call.input.prompt,
        },
      }),
    );
  });
  await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
  t.after(() => server.close());
  const address = server.address();
  const input = JSON.stringify([
    { project: "bash-workbench", title: "Prague", prompt: "Weather in Prague" },
    { project: "bash-workbench", title: "Mumbai", prompt: "Weather in Mumbai" },
  ]);
  const { stdout } = await execute(process.execPath, [
    cli,
    "runs",
    "batch",
    "--url",
    `http://127.0.0.1:${address.port}`,
    "--input",
    input,
    "--compact",
  ]);
  assert.deepEqual(JSON.parse(stdout), [
    {
      id: "run-Prague",
      project: "bash-workbench",
      title: "Prague",
      status: "queued",
    },
    {
      id: "run-Mumbai",
      project: "bash-workbench",
      title: "Mumbai",
      status: "queued",
    },
  ]);
  assert.ok(maximumActive > 1);
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
