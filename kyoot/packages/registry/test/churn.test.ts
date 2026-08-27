import assert from "node:assert/strict";
import { test } from "node:test";
import { Kyoot, Resource } from "kyoot";
import * as Registry from "@kyoot/registry";
import { lifecycle, provider, X } from "./helpers.ts";

test("rapid provider churn keeps activations balanced", async () => {
  const events: string[] = [];
  const dependent = Registry.component({
    inject: { x: X },
    run: () => lifecycle(events, "dependent"),
  });

  await Kyoot.runPromise(
    Kyoot.gen(function* () {
      const registry = yield* Registry.make();
      const handle = yield* registry.use(dependent);
      for (let i = 0; i < 8; i++) {
        const p = yield* registry.use(provider(events, `P${i}`, X, { name: `${i}` }));
        yield* p.remove();
      }
      yield* registry.use(provider(events, "final", X, { name: "final" }));
      assert.equal(handle.active, true);
      assert.equal(events.filter((event) => event === "dependent up").length, 9);
      assert.equal(events.filter((event) => event === "dependent down").length, 8);
    }).pipe(Resource.run),
  );

  assert.equal(events.filter((event) => event === "dependent up").length, 9);
  assert.equal(events.filter((event) => event === "dependent down").length, 9);
});

test("synchronous root finalizers do not lose notify transitions", async () => {
  const events: string[] = [];
  const consumer = Registry.component({
    inject: { x: X },
    run: () => lifecycle(events, "consumer"),
  });

  await Kyoot.runPromise(
    Kyoot.gen(function* () {
      const registry = yield* Registry.make();
      const handle = yield* registry.use(consumer);
      for (let i = 0; i < 100; i++) {
        yield* Kyoot.gen(function* () {
          yield* registry.set(X, { name: `${i}` });
        }).pipe(Resource.run);
      }
      yield* registry.settled();
      assert.equal(handle.active, false);
    }).pipe(Resource.run),
  );

  const up = events.filter((event) => event === "consumer up").length;
  const down = events.filter((event) => event === "consumer down").length;
  assert.ok(up > 0);
  assert.equal(up, down);
});
