import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { Async, Clock, Emit, Fail, Kyoot, Sync } from "kyoot";
import { Pi } from "@kyoot/pi";
import { service } from "@kyoot/pi/node";
import { awaitWorkers, make, type Job, type WorkerEvent } from "@kyoot/pi/scheduler";

const workbenchRoot = fileURLToPath(new URL("../..", import.meta.url));
const kyootRoot = path.join(workbenchRoot, "kyoot");

interface ReviewTask {
  readonly title: string;
  readonly target: string;
  readonly startupDelay: number;
}
interface ObservedEvent {
  readonly agent: string;
  readonly event: { readonly type: string; readonly [key: string]: unknown };
}

const root = "/tmp/kyoot-ten-reviews";
fs.rmSync(root, { recursive: true, force: true });
fs.mkdirSync(root, { recursive: true });

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
const parseEnvironment = (raw: string) =>
  Object.fromEntries(
    raw
      .split("\0")
      .filter(Boolean)
      .map((entry) => {
        const at = entry.indexOf("=");
        return [entry.slice(0, at), entry.slice(at + 1)];
      }),
  );
const inheritedEnvironment = () => {
  let source: Record<string, string | undefined> = { ...process.env };
  const candidates = [Number(process.env.BASH_WORKBENCH_PLATFORM_PID)];
  if (!source.BASHTV_FREE_LLM_URL) {
    for (const entry of fs.readdirSync("/proc")) {
      const pid = Number(entry);
      if (!Number.isInteger(pid) || candidates.includes(pid)) continue;
      try {
        if (fs.statSync(`/proc/${pid}`).uid !== process.getuid?.()) continue;
        if (fs.readFileSync(`/proc/${pid}/comm`, "utf8").trim() === "pi") candidates.push(pid);
      } catch {}
    }
  }
  for (const pid of candidates) {
    if (!Number.isInteger(pid) || pid < 1) continue;
    try {
      const candidate = parseEnvironment(fs.readFileSync(`/proc/${pid}/environ`, "utf8"));
      if (candidate.BASHTV_FREE_LLM_URL) {
        source = { ...source, ...candidate };
        break;
      }
    } catch {}
  }
  return Object.fromEntries(
    allowedEnvironment.flatMap((key) =>
      source[key] === undefined ? [] : [[key, source[key] as string]],
    ),
  );
};

const pi = service({
  cliPath: "/opt/pi-mono/packages/coding-agent/dist/cli.js",
  providerExtension: path.join(workbenchRoot, "child-provider.mjs"),
  environment: inheritedEnvironment,
  terminateGraceMs: 2_000,
});

const reviews = [
  ["schema", "Review packages/schema for Standard Schema correctness, type soundness, and edge cases."],
  ["rpc-core", "Review packages/rpc/src/index.ts for protocol correctness, typed errors, cancellation, and fiber lifecycle."],
  ["rpc-http", "Review packages/rpc/src/http.ts for Web transport correctness, streaming, limits, security boundaries, and cleanup."],
  ["sync-authority", "Review packages/sync/src/index.ts server authority, revision replay, idempotency, and concurrency races."],
  ["sync-client", "Review packages/sync/src/index.ts client engine, reconnection, optimistic overlays, duplicate/gap handling, and subscriptions."],
  ["query-cache", "Review packages/sync/src/query.ts for cache races, cancellation, invalidation, and stale-state behavior."],
  ["workbench-browser", "Review packages/workbench-protocol/src/browser.ts and src/index.ts for frontend ergonomics, typing, and lifecycle issues."],
  ["ai-pi", "Review packages/ai-pi for process cleanup, secret isolation, streaming, translation correctness, and portability."],
  ["pi-scheduler", "Review packages/pi/src/scheduler.ts and Node transport for structured concurrency, cancellation, queue behavior, and process cleanup."],
  ["architecture", "Review the repository-wide schema/RPC/sync/workbench design for layering, maintainability, missing tests, and integration risks."],
] as const;

const tasks: Array<Job<ReviewTask>> = reviews.map(([id, target], index) => ({
  id: `review-${id}`,
  value: { title: id, target, startupDelay: index * 4_000 },
}));
const schedulerEvents: Array<WorkerEvent<ReviewTask>> = [];
const eventCounts = new Map<string, number>();
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
const log = (value: unknown) => console.log(JSON.stringify(value));

const execute = (job: Job<ReviewTask>) =>
  Clock.sleep(job.value.startupDelay).map(() =>
    Async.timeout(
      180_000,
      Pi.scoped(
        {
          cwd: kyootRoot,
          sessionDir: path.join(root, job.id, "session"),
          provider: "bashtv",
          model: "free",
          thinking: "low",
        },
        (session) =>
          Pi.runTurn(
            session,
            [
              "You are one of ten parallel read-only code reviewers.",
              "Do not edit, create, delete, or format any file. Do not run commands that mutate repository or process state.",
              "You may use read-only inspection tools. Focus only on the assigned review.",
              job.value.target,
              "Return a concise Markdown report with prioritized findings, exact file/line references where possible, and practical fixes. If no issue is found, say so and list residual risks.",
            ].join("\n"),
          ).pipe(Emit.map((event) => ({ agent: job.id, event }) satisfies ObservedEvent)),
      ),
    ).map(() => undefined),
  );

const program = Kyoot.gen(function* () {
  const { scheduler, workers } = yield* make({
    concurrency: 2,
    queueCapacity: 20,
    execute,
    onEvent: (event: WorkerEvent<ReviewTask>) => {
      schedulerEvents.push(event);
      if (event.type === "completed" || event.type === "failed") terminal.add(event.job.id);
      log({
        source: "scheduler",
        type: event.type,
        worker: event.worker,
        agent: event.job.id,
        ...(event.error ? { error: String(event.error) } : {}),
      });
    },
  });
  for (const task of tasks) yield* scheduler.submit(task);
  while (terminal.size < tasks.length) yield* Clock.sleep(100);
  yield* scheduler.shutdown;
  yield* awaitWorkers(workers);
}).pipe(
  Sync.run,
  Pi.Service.provide(pi),
  Emit.forEach((observed: ObservedEvent) => {
    eventCounts.set(observed.agent, (eventCounts.get(observed.agent) ?? 0) + 1);
    const text = textFromMessage(observed.event);
    if (text) finalTexts.set(observed.agent, text);
    log({
      source: "emit",
      agent: observed.agent,
      type: observed.event.type,
      ...(text ? { finalChars: text.length } : {}),
    });
  }),
  Fail.orThrow,
);

const startedAt = Date.now();
await Kyoot.runPromise(program);
const summary = {
  elapsedMs: Date.now() - startedAt,
  submitted: tasks.length,
  maxConcurrency: 2,
  started: schedulerEvents.filter((event) => event.type === "started").map((event) => event.job.id),
  completed: schedulerEvents.filter((event) => event.type === "completed").map((event) => event.job.id),
  failed: schedulerEvents.filter((event) => event.type === "failed").map((event) => event.job.id),
  eventCounts: Object.fromEntries(eventCounts),
  reportCharacters: Object.fromEntries([...finalTexts].map(([id, text]) => [id, text.length])),
};
fs.writeFileSync(path.join(root, "reports.json"), JSON.stringify(Object.fromEntries(finalTexts), null, 2));
fs.writeFileSync(path.join(root, "summary.json"), JSON.stringify(summary, null, 2));
console.log(`SUMMARY ${JSON.stringify(summary)}`);
if (summary.completed.length !== tasks.length || summary.failed.length !== 0)
  throw new Error("Not every review agent completed");
for (const task of tasks)
  if (!finalTexts.get(task.id)?.trim()) throw new Error(`Missing review report from ${task.id}`);
