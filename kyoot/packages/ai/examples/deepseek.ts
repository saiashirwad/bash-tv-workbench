import { Async, Emit, Fail, Kyoot, Log, Random, Var } from "kyoot";
import { AI, Deepseek, Events, Mode } from "@kyoot/ai";
import { z } from "zod";

const motions = [
  "Tabs are better than spaces",
  "Pineapple belongs on pizza",
  "Cats make better pets than dogs",
  "Remote work beats the office",
];

const debater = (name: string, stance: string) =>
  AI.make({
    prompt: `You are ${name}, debating ${stance} the motion. Two punchy sentences per turn. Rebut your opponent and never concede.`,
  });

const Verdict = z.object({
  winner: z.enum(["Ada", "Linus"]),
  reason: z.string().describe("one sentence"),
});

const judge = (transcript: string) =>
  AI.gen(Verdict, `Who won this exchange?\n\n${transcript}`, {
    prompt: "You are a strict debate judge.",
  }).pipe(Mode.config({ temperature: 1.3 }), Deepseek(), Emit.discard, Fail.orThrow);

const Score = Var.tag<Record<"Ada" | "Linus", number>>()("score");

const speakers = [
  ["Ada", debater("Ada", "for"), "deepseek-chat"],
  ["Linus", debater("Linus", "against"), "deepseek-chat"],
] as const;

const debate = Kyoot.gen(function* () {
  const motion = motions[yield* Random.int(motions.length)]!;
  yield* Log.info(`Motion: ${motion}`);
  let transcript = "";
  let cue = `The motion: "${motion}". Make your opening statement.`;
  for (let round = 1; round <= 2; round++) {
    for (const [name, speaker, model] of speakers) {
      yield* Log.info(`\n${name}:`);
      const speech = yield* speaker.ask(cue).pipe(Deepseek({ model }));
      transcript += `${name}: ${speech}\n`;
      cue = `Your opponent said: "${speech}". Respond.`;
    }
    const verdicts = yield* Async.all([judge(transcript), judge(transcript), judge(transcript)]);
    yield* Score.update((s) =>
      verdicts.reduce((s, { winner }) => ({ ...s, [winner]: s[winner] + 1 }), s),
    );
    yield* Log.info(`\n\nRound ${round} judges:`);
    for (const { winner, reason } of verdicts) yield* Log.info(`  ${winner} — ${reason}`);
  }
});

const [, score] = await debate.pipe(
  Score.run({ Ada: 0, Linus: 0 }),
  Events.print,
  Log.print,
  Random.live,
  Fail.orThrow,
  Kyoot.runPromise,
);

console.log("\nFinal score:", score);
