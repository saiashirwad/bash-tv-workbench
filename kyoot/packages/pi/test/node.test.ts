import assert from "node:assert/strict";
import { test } from "node:test";
import path from "node:path";
import { Emit, Fail, Kyoot } from "kyoot";
import { service } from "../src/node.ts";
import { Pi } from "../src/index.ts";

const fixture = path.resolve("test/fixtures/rpc-child.mjs");
const options = {
  cwd: process.cwd(),
  sessionDir: path.resolve("test/session"),
  provider: "bashtv",
  model: "free",
  thinking: "low" as const,
};

const nodeService = () =>
  service({
    cliPath: fixture,
    providerExtension: "ignored-by-fixture",
    environment: () => ({ PATH: process.env.PATH ?? "" }),
    terminateGraceMs: 100,
  });

test("Node service correlates responses and broadcasts events", async () => {
  const program = Pi.scoped(options, (session) =>
    Kyoot.gen(function* () {
      const state = yield* Pi.state(session);
      const turn = yield* Pi.runTurn(session, "hello");
      return { state, turn };
    }),
  ).pipe(Pi.Service.provide(nodeService()), Emit.collect, Fail.orThrow);

  const [{ state, turn }, events] = await Kyoot.runPromise(program);
  assert.equal(state.sessionId, "fixture");
  assert.equal(turn.type, "agent_end");
  assert.deepEqual(
    events.map((event) => event.type),
    ["agent_start", "message_end", "agent_end"],
  );
});

test("Node service turns RPC failures into typed protocol failures", async () => {
  const program = Pi.scoped(options, (session) =>
    Kyoot.gen(function* () {
      const pi = yield* Pi.Service;
      yield* pi.request(session, { type: "compact" });
    }),
  ).pipe(Pi.Service.provide(nodeService()), Fail.run);

  const result = await Kyoot.runPromise(program);
  assert.ok(
    !result.ok && result.cause._tag === "Fail" && result.cause.error instanceof Pi.PiProtocolError,
  );
});
