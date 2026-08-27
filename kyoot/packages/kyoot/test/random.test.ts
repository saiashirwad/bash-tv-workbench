import assert from "node:assert/strict";
import { test } from "node:test";
import { Kyoot, Random } from "../src/index.ts";

const three = Kyoot.gen(function* () {
  return [yield* Random.next(), yield* Random.next(), yield* Random.int(10)];
});

test("Random.seeded is deterministic and in range", () => {
  const a = Kyoot.runSync(three.pipe(Random.seeded(42)));
  const b = Kyoot.runSync(three.pipe(Random.seeded(42)));
  const c = Kyoot.runSync(three.pipe(Random.seeded(43)));
  assert.deepEqual(a, b);
  assert.notDeepEqual(a, c);
  assert.ok(a.every((x) => x >= 0 && x < 10));
  assert.ok(a[0]! < 1 && a[1]! < 1 && Number.isInteger(a[2]));
});

test("Random.live draws from Math.random", () => {
  const random = Math.random;
  let calls = 0;
  Math.random = () => {
    calls++;
    return 0.25;
  };
  try {
    assert.deepEqual(Kyoot.runSync(three.pipe(Random.live)), [0.25, 0.25, 2]);
    assert.equal(calls, 3);
  } finally {
    Math.random = random;
  }
});
