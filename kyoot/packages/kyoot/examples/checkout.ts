import { effect, Emit, Fail, Kyoot, Var } from "../src/index.ts";

export class OutOfStock {
  readonly _tag = "OutOfStock";
  readonly sku: string;
  constructor(sku: string) {
    this.sku = sku;
  }
}

export class PaymentDeclined {
  readonly _tag = "PaymentDeclined";
  readonly reason: string;
  constructor(reason: string) {
    this.reason = reason;
  }
}

export interface Order {
  readonly id: string;
  readonly items: ReadonlyArray<{ sku: string; qty: number; priceCents: number }>;
}

export type OrderEvent = { type: "reserved"; sku: string };

export interface Reserve {
  readonly sku: string;
  readonly qty: number;
}

export interface Charge {
  readonly totalCents: number;
  readonly card: string;
}

export const Inventory = effect<Reserve, boolean>()("inventory");
export const Payments = effect<Charge, string>()("payments");

const Total = Var.tag<number>()("Total");

export const checkout = (order: Order, card: string) =>
  Kyoot.gen(function* () {
    for (const item of order.items) {
      const ok = yield* Inventory({ sku: item.sku, qty: item.qty });
      if (!ok) yield* Fail.fail(new OutOfStock(item.sku));
      yield* Emit.value<OrderEvent>({ type: "reserved", sku: item.sku });
      yield* Total.update((t) => t + item.priceCents * item.qty);
    }
    const totalCents = yield* Total.get();
    const chargeId = yield* Payments({ totalCents, card });
    return { orderId: order.id, chargeId, totalCents };
  }).pipe(Total.run(0));

const result = checkout(
  { id: "o-1", items: [{ sku: "book", qty: 2, priceCents: 1200 }] },
  "4242",
).pipe(
  Inventory.handle({
    initial: new Map([["book", 3]]),
    onOp: ({ sku, qty }, resume, stock) => {
      const have = stock.get(sku) ?? 0;
      return have >= qty ? resume(true, new Map(stock).set(sku, have - qty)) : resume(false);
    },
  }),
  Payments.handle({
    onOp: ({ totalCents }, resume) => resume(`ch_${totalCents}`),
  }),
  Emit.forEach(console.log),
  Fail.run,
  Kyoot.runSync,
);
console.log(result);
