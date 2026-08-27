import { Async, Clock, effect, Emit, Fail, Kyoot, Log, Retry } from "../src/index.ts";

interface Prompt {
  readonly messages: readonly string[];
}

const Model = effect<Prompt, string>()("model");
const Search = effect<{ query: string }, string[]>()("search");

class RateLimited {
  readonly _tag = "RateLimited";
}

const agent = (question: string) =>
  Kyoot.gen(function* () {
    yield* Log.info(`question: ${question}`);
    const query = yield* Model({ messages: [`search query for: ${question}`] });
    const results = yield* Search({ query });
    yield* Log.info(`found ${results.length} results`);
    return yield* Model({ messages: [question, ...results] });
  });

const flakyModel = (failures: number) => {
  let calls = 0;
  const complete = ({ messages }: Prompt) =>
    Kyoot.gen(function* () {
      if (calls++ < failures) {
        yield* Log.warn("rate limited");
        return yield* Fail.fail(new RateLimited());
      }
      const reply = `reply to "${messages.at(-1)}"`;
      for (const token of reply.split(" ")) {
        yield* Clock.sleep(20);
        yield* Emit.value(token);
      }
      return reply;
    });

  return Model.handle({
    onOp: (prompt, resume) =>
      complete(prompt)
        .pipe(Retry.run({ times: 3, delay: (n) => 50 * 2 ** n }))
        .map(resume),
  });
};

const localSearch = Search.handle({
  onOp: ({ query }, resume) => resume([`${query} → doc 1`, `${query} → doc 2`]),
});

const program = agent("why is the sky blue?").pipe(
  flakyModel(1),
  localSearch,
  Emit.forEach((token: string) => process.stdout.write(`${token} `)),
  Log.print,
  Fail.run,
);

const answer = await Async.timeout(5_000, program).pipe(Fail.orThrow, Kyoot.runPromise);
console.log("\n", answer);
