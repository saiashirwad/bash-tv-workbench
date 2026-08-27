import { gen } from "../gen.ts";
import type { Kyoot } from "../model.ts";
import type { Row } from "../types.ts";
import * as Clock from "./clock.ts";
import * as Fail from "./fail.ts";

export interface Policy {
  readonly times: number;
  readonly delay?: number | ((attempt: number) => number);
  readonly while?: (error: unknown) => boolean;
}

const delayOf = ({ delay = 0 }: Policy, attempt: number) =>
  typeof delay === "function" ? delay(attempt) : delay;

// Re-run `k` on a typed failure, up to `times` more attempts, sleeping between them.
// Defects are not retried. The last failure stays in the row.
export const run =
  (policy: Policy) =>
  <A, S extends Row & { fail?: unknown }>(k: Kyoot<A, S>) =>
    gen(function* () {
      for (let attempt = 0; ; attempt++) {
        const r = yield* k.pipe(Fail.run);
        if (r.ok) return r.value;
        const stop = r.cause._tag !== "Fail" || policy.while?.(r.cause.error) === false;
        if (stop || attempt >= policy.times) return yield* Fail.fromResult(r);
        yield* Clock.sleep(delayOf(policy, attempt));
      }
    });
