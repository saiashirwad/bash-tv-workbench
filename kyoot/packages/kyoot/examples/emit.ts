import { Emit, Kyoot } from "../src/index.ts";

const program = Kyoot.gen(function* () {
  yield* Emit.value("started");
  yield* Emit.value("finished");
  return "done";
});

const [result, events] = Kyoot.runSync(program.pipe(Emit.collect));

console.log(result);
console.log(events);
