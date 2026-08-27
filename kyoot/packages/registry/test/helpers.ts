import { Env, Kyoot, Resource } from "kyoot";
import * as Registry from "@kyoot/registry";

export const Db = Env.tag<{ name: string }>()("db");
export const Cache = Env.tag<{ size: number }>()("cache");
export const X = Env.tag<{ name: string }>()("x");
export const Y = Env.tag<{ name: string }>()("y");
export const Trigger = Env.tag<{ name: string }>()("trigger");

export const lifecycle = (events: string[], name: string) =>
  Resource.acquire(
    () => events.push(`${name} up`),
    () => events.push(`${name} down`),
  );

export const provider = <E>(events: string[], name: string, tag: Env.Tag<string, E>, impl: E) =>
  Registry.component({
    inject: {},
    run: (_, ctx) =>
      Kyoot.gen(function* () {
        yield* lifecycle(events, name);
        yield* ctx.set(tag, impl);
      }),
  });

export const deferred = () => {
  let resolve!: () => void;
  const promise = new Promise<void>((done) => (resolve = done));
  return { promise, resolve };
};

export const log = () => {
  const events: string[] = [];
  const database = (name: string) =>
    Registry.component({
      inject: {},
      run: (_, ctx) =>
        Kyoot.gen(function* () {
          yield* Resource.acquire(
            () => events.push(`open ${name}`),
            () => events.push(`close ${name}`),
          );
          yield* ctx.set(Db, { name });
        }),
    });
  const server = Registry.component({
    inject: { db: Db },
    run: ({ db }) =>
      Resource.acquire(
        () => events.push(`up on ${db.name}`),
        () => events.push("down"),
      ),
  });
  return { events, database, server };
};
