import { Model } from "@kyoot/ai";
import { Kyoot } from "kyoot";
import type { Kyoot as K, RowsOf } from "kyoot";
import { BashTv } from "../src/node.ts";

type Expect<T extends true> = T;
type Equal<A, B> = [A] extends [B] ? ([B] extends [A] ? true : false) : false;
type ValueOf<T> = T extends K<infer A, any> ? A : never;

const request = Model({ messages: [{ role: "user", content: "hello" }] });
const provided = request.pipe(BashTv.model("free", { thinking: "low" }));
type _providedKeys = Expect<Equal<keyof RowsOf<typeof provided>, "async" | "emit" | "fail">>;
type _providedValue = Expect<Equal<ValueOf<typeof provided>, ValueOf<typeof request>>>;
const runnable = provided.pipe(
  // Discharge only the rows relevant to this type assertion elsewhere in normal code.
  (program) => program,
);
void runnable;

// @ts-expect-error Bash.tv currently exposes only its server-selected `free` alias.
BashTv.model("arbitrary-upstream-model");
// @ts-expect-error Bash.tv free mode has only off/low thinking.
BashTv.model("free", { thinking: "high" });

// The provider is asynchronous and therefore cannot run synchronously.
// @ts-expect-error runSync requires all rows to be handled.
Kyoot.runSync(provided);
