import { effect, Fail, Kyoot, Sync } from "../src/index.ts";

class NotFound {
  readonly _tag = "NotFound";
  readonly id: string;
  constructor(id: string) {
    this.id = id;
  }
}

const Fatal = effect<{ reason: string }, never>()("fatal");

const users = new Map([["1", "ada"]]);

const lookup = (id: string) =>
  Kyoot.gen(function* () {
    if (id === "0") yield* Fatal({ reason: "db down" });
    const name = users.get(id);
    if (name === undefined) yield* Fail.fail(new NotFound(id));
    return name;
  });

const run = (id: string) =>
  lookup(id).pipe(
    Fail.catchAll((e: NotFound) => Kyoot.succeed(`no user ${e.id}`)),
    Fatal.handle({
      onOp: (e) =>
        Sync.defer(() => {
          console.error(`fatal: ${e.reason}`);
          process.exit(1);
        }),
    }),
    Sync.run,
    Kyoot.runSync,
  );

console.log(run("1"));
console.log(run("2"));
console.log(run("0"));
