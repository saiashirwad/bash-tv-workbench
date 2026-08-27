import { Async, Fail, Kyoot } from "../src/index.ts";

class NotFound {
  readonly _tag = "NotFound";
  readonly name: string;
  constructor(name: string) {
    this.name = name;
  }
}

type Pokemon = { name: string; types: { type: { name: string } }[] };

const pokemon = (name: string) =>
  Kyoot.gen(function* () {
    const url = `https://pokeapi.co/api/v2/pokemon/${name}`;
    const res = yield* Async.fromPromise((signal) => fetch(url, { signal }));
    if (!res.ok) yield* Fail.fail(new NotFound(name));
    const data = yield* Async.fromPromise<Pokemon>(() => res.json());
    return `${data.name}: ${data.types.map((t) => t.type.name).join("/")}`;
  });

// A branch's typed failure crosses join, race, all, and timeout; one Fail.run
// outside catches them all.
const main = Kyoot.gen(function* () {
  const winner = yield* Async.race(pokemon("pikachu"), pokemon("slowpoke"));
  const starters = yield* Async.all(["bulbasaur", "charmander", "squirtle"].map(pokemon));
  const ditto = yield* Async.timeout(5000, pokemon("ditto")).pipe(Fail.run);
  return { winner, starters, ditto };
}).pipe(Fail.run);

console.log(await Kyoot.runPromise(main));
