import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { Async, Clock, Emit, Fail, Kyoot, Sync } from "kyoot";
import { Pi } from "@kyoot/pi";
import { service } from "@kyoot/pi/node";
import { awaitWorkers, make, type Job, type WorkerEvent } from "@kyoot/pi/scheduler";

const workbenchRoot = fileURLToPath(new URL("../..", import.meta.url));
const kyootRoot = path.join(workbenchRoot, "kyoot");

interface Task {
  readonly expected: string;
  readonly startupDelay: number;
}

interface ObservedEvent {
  readonly agent: string;
  readonly event: { readonly type: string; readonly [key: string]: unknown };
}

const allowedEnvironment = [
  "HOME",
  "PATH",
  "LANG",
  "TERM",
  "TMPDIR",
  "API_REFRESH_TOKEN",
  "BASHTV_FREE_LLM_URL",
  "BASHTV_FREE_MODEL_INFO",
  "BASHTV_TUNNEL_AUTH_TOKEN",
  "VERCEL_AUTOMATION_BYPASS_SECRET",
];

const inheritedEnvironment = () => {
  let source = { ...process.env };
  try {
    const raw = fs.readFileSync(
      `/proc/${process.env.BASH_WORKBENCH_PLATFORM_PID}/environ`,
      "utf8",
    );
    source = {
      ...source,
      ...Object.fromEntries(
        raw
          .split("\0")
          .filter(Boolean)
          .map((entry) => {
            const at = entry.indexOf("=");
            return [entry.slice(0, at), entry.slice(at + 1)];
          }),
      ),
    };
  } catch {}
  return Object.fromEntries(
    allowedEnvironment.flatMap((key) =>
      source[key] === undefined ? [] : [[key, source[key]]],
    ),
  );
};

const pi = service({
  cliPath: "/opt/pi-mono/packages/coding-agent/dist/cli.js",
  providerExtension: path.join(workbenchRoot, "child-provider.mjs"),
  environment: inheritedEnvironment,
  terminateGraceMs: 2_000,
});

const tasks: Array<Job<Task>> = Array.from({ length: 5 }, (_, index) => ({
  id: `agent-${index + 1}`,
  value: {
    expected: `KYOOT_FIVE_${index + 1}`,
    startupDelay: index * 1_500,
  },
}));
const schedulerEvents: Array<WorkerEvent<Task>> = [];
const observedCounts = new Map<string, number>();
const finalTexts = new Map<string, string>();
const terminal = new Set<string>();

const textFromMessage = (event: ObservedEvent["event"]) => {
  if (event.type !== "message_end") return "";
  const message = event.message as
    | { readonly role?: string; readonly content?: readonly unknown[] }
    | undefined;
  if (message?.role !== "assistant") return "";
  return (message.content ?? [])
    .flatMap((part) => {
      const value = part as { readonly type?: string; readonly text?: string };
      return value.type === "text" && value.text ? [value.text] : [];
    })
    .join("\n");
};

const execute = (job: Job<Task>) =>
  Clock.sleep(job.value.startupDelay).map(() =>
    Async.timeout(
      90_000,
      Pi.scoped(
        {
          cwd: kyootRoot,
          sessionDir: `/tmp/kyoot-five-agents/${job.id}`,
          provider: "bashtv",
          model: "free",
          thinking: "low",
        },
        (session) =>
          Pi.runTurn(
            session,
            `Read-only concurrency check. Do not edit files or run tools. Reply with exactly ${job.value.expected}.`,
          ).pipe(
            Emit.map((event) => ({ agent: job.id, event }) satisfies ObservedEvent),
          ),
      ),
    ).map(() => undefined),
  );

const program = Kyoot.gen(function* () {
  const { scheduler, workers } = yield* make({
    concurrency: 5,
    queueCapacity: 10,
    execute,
    onEvent: (event: WorkerEvent<Task>) => {
      schedulerEvents.push(event);
      if (event.type === "completed" || event.type === "failed")
        terminal.add(event.job.id);
      console.log(
        JSON.stringify({
          source: "scheduler",
          type: event.type,
          worker: event.worker,
          agent: event.job.id,
        }),
      );
    },
  });

  for (const task of tasks) yield* scheduler.submit(task);
  while (terminal.size < tasks.length) yield* Clock.sleep(50);
  yield* scheduler.shutdown;
  yield* awaitWorkers(workers);
}).pipe(
  Sync.run,
  Pi.Service.provide(pi),
  Emit.forEach((observed: ObservedEvent) => {
    observedCounts.set(
      observed.agent,
      (observedCounts.get(observed.agent) ?? 0) + 1,
    );
    const text = textFromMessage(observed.event);
    if (text) finalTexts.set(observed.agent, text);
    console.log(
      JSON.stringify({
        source: "emit",
        agent: observed.agent,
        type: observed.event.type,
        ...(text ? { text } : {}),
      }),
    );
  }),
  Fail.orThrow,
);

const startedAt = Date.now();
await Kyoot.runPromise(program);
const summary = {
  elapsedMs: Date.now() - startedAt,
  started: schedulerEvents
    .filter((event) => event.type === "started")
    .map((event) => event.job.id),
  completed: schedulerEvents
    .filter((event) => event.type === "completed")
    .map((event) => event.job.id),
  failed: schedulerEvents
    .filter((event) => event.type === "failed")
    .map((event) => event.job.id),
  observedCounts: Object.fromEntries(observedCounts),
  finalTexts: Object.fromEntries(finalTexts),
};
console.log(`SUMMARY ${JSON.stringify(summary)}`);

if (summary.completed.length !== 5 || summary.failed.length !== 0)
  throw new Error("Not every agent completed");
for (const task of tasks)
  if (finalTexts.get(task.id)?.trim() !== task.value.expected)
    throw new Error(`Unexpected final text for ${task.id}`);
