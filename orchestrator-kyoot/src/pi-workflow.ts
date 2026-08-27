import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { Async, Emit, Fail, Kyoot, runFiber } from "kyoot";
import { Pi } from "@kyoot/pi";
import { service, type NodeOptions } from "@kyoot/pi/node";
import type { WorkflowEngine } from "./workflow-engine.ts";
import { makeEngine, type TaskContext, type TaskExecutor } from "./workflow-engine.ts";
import type { WorkflowStore } from "./workflow-store.ts";
import type { TaskRecord } from "./workflow.ts";

const allowedEnvironment = [
  "HOME", "PATH", "LANG", "TERM", "TMPDIR", "API_REFRESH_TOKEN",
  "BASHTV_FREE_LLM_URL", "BASHTV_FREE_MODEL_INFO", "BASHTV_TUNNEL_AUTH_TOKEN",
  "VERCEL_AUTOMATION_BYPASS_SECRET",
];
const parseEnvironment = (raw: string) => Object.fromEntries(
  raw.split("\0").filter(Boolean).map((entry) => {
    const at = entry.indexOf("=");
    return [entry.slice(0, at), entry.slice(at + 1)];
  }),
);
export const entitledEnvironment = (platformPid?: number): Record<string, string> => {
  let source: Record<string, string | undefined> = { ...process.env };
  const configured = platformPid ?? Number(process.env.BASH_WORKBENCH_PLATFORM_PID);
  const candidates = [configured];
  if (!source.BASHTV_FREE_LLM_URL) {
    try {
      for (const entry of fs.readdirSync("/proc")) {
        const pid = Number(entry);
        if (!Number.isInteger(pid) || candidates.includes(pid)) continue;
        try {
          if (fs.statSync(`/proc/${pid}`).uid !== process.getuid?.()) continue;
          if (fs.readFileSync(`/proc/${pid}/comm`, "utf8").trim() === "pi") candidates.push(pid);
        } catch {}
      }
    } catch {}
  }
  for (const pid of candidates) {
    if (!Number.isInteger(pid) || pid < 1) continue;
    try {
      const candidate = parseEnvironment(fs.readFileSync(`/proc/${pid}/environ`, "utf8"));
      if (!candidate.BASHTV_FREE_LLM_URL) continue;
      source = { ...source, ...candidate };
      break;
    } catch {}
  }
  return Object.fromEntries(allowedEnvironment.flatMap((key) =>
    source[key] === undefined ? [] : [[key, source[key] as string]],
  ));
};

export interface PiWorkflowOptions {
  readonly stateRoot: string;
  readonly projectRoot: (project: string) => string;
  readonly pi?: Partial<NodeOptions>;
  readonly providerExtension?: string;
  readonly maxConcurrency?: number;
  readonly coldStartSpacingMs?: number;
}
const finalText = (event: any) => {
  const message = event?.type === "message_end" ? event.message : undefined;
  if (message?.role !== "assistant") return "";
  return (message.content ?? []).flatMap((part: any) =>
    part?.type === "text" && part.text ? [part.text] : [],
  ).join("\n");
};

const plannedTasks = (text: string) => {
  const blocks = [...text.matchAll(/```workflow_tasks\s*\n([\s\S]*?)```/gi)];
  return blocks.flatMap((match) => {
    try {
      const parsed = JSON.parse(match[1]!) as unknown;
      return Array.isArray(parsed) ? parsed : [];
    } catch {
      return [];
    }
  });
};

export const piExecutor = (options: PiWorkflowOptions): TaskExecutor => {
  const pi = service({
    cliPath: "/opt/pi-mono/packages/coding-agent/dist/cli.js",
    providerExtension:
      options.providerExtension ??
      fileURLToPath(new URL("../../child-provider.mjs", import.meta.url)),
    environment: entitledEnvironment,
    terminateGraceMs: 2_000,
    ...options.pi,
  });
  return {
    async execute(task: TaskRecord, context: TaskContext) {
      const sessionDir = path.join(
        options.stateRoot,
        "sessions",
        task.workflowId,
        task.id,
        `attempt-${task.attempt}`,
      );
      fs.mkdirSync(sessionDir, { recursive: true, mode: 0o700 });
      let text = "";
      const program = Pi.scoped(
        {
          cwd: options.projectRoot(task.project),
          sessionDir,
          provider: "bashtv",
          model: "free",
          thinking: "low",
        },
        (session) => Pi.runTurn(session, task.prompt).pipe(
          Emit.forEach((event: any) => {
            const next = finalText(event);
            if (next) text = next;
            return Async.fromPromise(() => context.emit(`pi.${event.type}`, event));
          }),
        ),
      ).pipe(Pi.Service.provide(pi), Fail.orThrow);
      const fiber = runFiber(program as never);
      const abort = () => fiber.interrupt();
      context.signal.addEventListener("abort", abort, { once: true });
      try {
        await fiber.promise;
        if (!text.trim() && task.metadata?.allowEmptyOutput !== true)
          throw new Error("Pi completed without a final assistant response");
        const dynamic = plannedTasks(text);
        const added = dynamic.length ? await context.addTasks(dynamic as never) : [];
        if (added.length)
          await context.emit("planner.tasks-added", { taskIds: added.map((task) => task.id) });
        return { text, sessionDir, addedTaskIds: added.map((task) => task.id) };
      } finally {
        context.signal.removeEventListener("abort", abort);
      }
    },
  };
};

export const makePiWorkflowEngine = (
  store: WorkflowStore,
  options: PiWorkflowOptions,
): Promise<WorkflowEngine> =>
  makeEngine(store, piExecutor(options), {
    maxConcurrency: options.maxConcurrency ?? 2,
    coldStartSpacingMs: options.coldStartSpacingMs ?? 4_000,
  });
