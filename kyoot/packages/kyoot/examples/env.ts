import { Env, Kyoot } from "../src/index.ts";

const Config = Env.tag<{ id: string; name: string }>()("Config");
const Greeting = Env.tag<string>()("greeting");

const program = Kyoot.gen(function* () {
  const config = yield* Config;
  const greeting = yield* Greeting.get();

  return { config, greeting };
});

const result = Kyoot.runSync(
  program.pipe(Config.provide({ id: "hi", name: "what" }), Greeting.provide("hi")),
);

console.log(result);
