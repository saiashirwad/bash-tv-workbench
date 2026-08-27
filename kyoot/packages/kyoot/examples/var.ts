import { Kyoot, Var } from "../src/index.ts";

const Count = Var.tag<number>()("Count");
const Name = Var.tag<string>()("Name");

const program = Kyoot.gen(function* () {
  const before = yield* Count.get();
  const name = yield* Name.get();
  yield* Count.update((count) => count + 1);
  const after = yield* Count.get();
  return { before, name, after };
});

const result = Kyoot.runSync(program.pipe(Count.run(10), Name.run("kyoot")));

console.log(JSON.stringify(result, null, 2));
