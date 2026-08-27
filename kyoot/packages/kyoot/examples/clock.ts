import { Clock, Kyoot } from "../src/index.ts";

const boilEgg = (minute: number) =>
  Kyoot.gen(function* () {
    yield* Clock.sleep(1 * minute);
    yield* Clock.sleep(6 * minute);
    return "egg ready";
  });

console.log(Kyoot.runSync(boilEgg(60_000).pipe(Clock.virtual)));
console.log(await Kyoot.runPromise(boilEgg(20)));
