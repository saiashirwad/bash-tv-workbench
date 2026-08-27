import assert from "node:assert/strict";
import { test } from "node:test";
import { Emit, Fail, Kyoot } from "kyoot";
import { Pi } from "../src/index.ts";
import { scripted } from "../src/testing.ts";

const options = {
  cwd: "/work",
  sessionDir: "/state/session",
  provider: "bashtv",
  model: "free",
  thinking: "low" as const,
};

test("runTurn emits scripted Pi events and returns agent_end", async () => {
  const service = scripted({
    events: [
      { type: "agent_start" },
      { type: "message_end", message: { role: "assistant" } },
      { type: "agent_end", messages: [] },
    ],
  });
  const program = Kyoot.gen(function* () {
    const pi = yield* Pi.Service;
    const session = yield* pi.open(options);
    return yield* Pi.runTurn(session, "hello");
  }).pipe(Pi.Service.provide(service), Emit.collect, Fail.orThrow);
  const [result, events] = await Kyoot.runPromise(program);
  assert.equal(result.type, "agent_end");
  assert.deepEqual(
    events.map((event) => event.type),
    ["agent_start", "message_end", "agent_end"],
  );
});

test("runTurn fails when the Pi event stream closes early", async () => {
  const service = scripted({ events: [{ type: "agent_start" }] });
  const program = Kyoot.gen(function* () {
    const pi = yield* Pi.Service;
    const session = yield* pi.open(options);
    return yield* Pi.runTurn(session, "hello");
  }).pipe(Pi.Service.provide(service), Emit.discard, Fail.run);
  const result = await Kyoot.runPromise(program);
  assert.ok(
    !result.ok && result.cause._tag === "Fail" && result.cause.error instanceof Pi.PiTransportError,
  );
});
