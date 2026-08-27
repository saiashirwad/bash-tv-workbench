import assert from "node:assert/strict";
import { test } from "node:test";
import {
  checkout,
  Inventory,
  OutOfStock,
  PaymentDeclined,
  Payments,
} from "../examples/checkout.ts";
import type { Order, OrderEvent } from "../examples/checkout.ts";
import { Emit, Fail, Kyoot } from "../src/index.ts";

const order: Order = {
  id: "o-1",
  items: [
    { sku: "book", qty: 1, priceCents: 1200 },
    { sku: "pen", qty: 3, priceCents: 150 },
  ],
};
const card = "4242";
const stocked = { book: 5, pen: 5 };

const inMemoryInventory = (stock: Record<string, number>) =>
  Inventory.handle({
    initial: new Map(Object.entries(stock)),
    onOp: ({ sku, qty }, resume, stock) => {
      const have = stock.get(sku) ?? 0;
      return have >= qty ? resume(true, new Map(stock).set(sku, have - qty)) : resume(false);
    },
  });

const approveAll = Payments.handle({
  onOp: ({ totalCents }, resume) => resume(`ch_${totalCents}`),
});

const declineAll = (reason: string) =>
  Payments.handle({ onOp: () => Fail.fail(new PaymentDeclined(reason)) });

test("pure handlers run the whole checkout under runSync", () => {
  const [receipt, total] = checkout(order, card).pipe(
    inMemoryInventory(stocked),
    approveAll,
    Emit.discard,
    Fail.orThrow,
    Kyoot.runSync,
  );
  assert.equal(total, 1650);
  assert.deepEqual(receipt, { orderId: "o-1", chargeId: "ch_1650", totalCents: 1650 });
});

test("events stream out in order; success is Result.ok", async () => {
  const events: OrderEvent[] = [];
  const r = await checkout(order, card).pipe(
    inMemoryInventory(stocked),
    approveAll,
    Emit.forEach((e: OrderEvent) => events.push(e)),
    Fail.run,
    Kyoot.runPromise,
  );
  assert.deepEqual(events, [
    { type: "reserved", sku: "book" },
    { type: "reserved", sku: "pen" },
  ]);
  assert.ok(r.ok);
  assert.deepEqual(r.ok && r.value, [
    { orderId: "o-1", chargeId: "ch_1650", totalCents: 1650 },
    1650,
  ]);
});

test("out of stock is a typed failure from checkout itself", () => {
  const r = checkout(order, card).pipe(
    inMemoryInventory({ book: 5, pen: 2 }),
    approveAll,
    Emit.discard,
    Fail.run,
    Kyoot.runSync,
  );
  assert.ok(!r.ok);
  const cause = !r.ok && r.cause;
  assert.ok(cause && cause._tag === "Fail" && cause.error instanceof OutOfStock);
  assert.equal(cause && cause._tag === "Fail" && cause.error.sku, "pen");
});

test("a declined card is a typed failure introduced by the payments handler", () => {
  const r = checkout(order, card).pipe(
    inMemoryInventory(stocked),
    declineAll("insufficient funds"),
    Emit.discard,
    Fail.run,
    Kyoot.runSync,
  );
  assert.ok(!r.ok);
  const cause = !r.ok && r.cause;
  assert.ok(cause && cause._tag === "Fail" && cause.error instanceof PaymentDeclined);
  assert.equal(cause && cause._tag === "Fail" && cause.error.reason, "insufficient funds");
});

test("orThrow surfaces a typed failure as a throw", () => {
  assert.throws(
    () =>
      checkout(order, card).pipe(
        inMemoryInventory({ book: 0 }),
        approveAll,
        Emit.discard,
        Fail.orThrow,
        Kyoot.runSync,
      ),
    (e) => e instanceof OutOfStock,
  );
});
