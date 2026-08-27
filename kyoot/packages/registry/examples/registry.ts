import { Env, Kyoot, Resource } from "kyoot";
import * as Registry from "@kyoot/registry";

const Db = Env.tag<{ query: (sql: string) => string }>()("db");

const database = (name: string) =>
  Registry.component({
    inject: {},
    run: (_, ctx) =>
      Kyoot.gen(function* () {
        const conn = yield* Resource.acquire(
          () => (console.log(`open ${name}`), name),
          () => console.log(`close ${name}`),
        );
        yield* ctx.set(Db, { query: (sql) => `${conn}: ${sql}` });
      }),
  });

const server = Registry.component({
  inject: { db: Db },
  run: ({ db }) =>
    Resource.acquire(
      () => console.log(`server up, ${db.query("select 1")}`),
      () => console.log("server down"),
    ),
});

await Kyoot.runPromise(
  Kyoot.gen(function* () {
    const registry = yield* Registry.make();
    const srv = yield* registry.use(server);
    console.log("server active:", srv.active);
    const db = yield* registry.use(database("pg-1"));
    yield* registry.settled();
    console.log("server active:", srv.active);
    yield* db.remove();
    yield* registry.use(database("pg-2"));
    yield* registry.settled();
  }).pipe(Resource.run),
);
