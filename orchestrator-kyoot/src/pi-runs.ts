import crypto from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { spawnSync } from "node:child_process";
import { Async, Emit, Fail, runFiber } from "kyoot";
import { Pi } from "@kyoot/pi";
import { service } from "@kyoot/pi/node";
import { entitledEnvironment } from "./pi-workflow.ts";
import type { Run } from "./run.ts";
import type { RunContext, RunExecution, RunExecutor } from "./run-engine.ts";

const textParts = (content: unknown, type: "text" | "thinking") =>
  (Array.isArray(content) ? content : []).flatMap((part: any) =>
    part?.type === type && part[type] ? [String(part[type])] : [],
  ).join("\n");
const snapshot = (cwd: string) => {
  const result = spawnSync("git", ["-C", cwd, "status", "--porcelain=v1", "-z"], { encoding: "utf8", maxBuffer: 4 * 1024 * 1024 });
  const files = new Map<string, { status: string; fingerprint: string }>();
  if (result.status !== 0) return files;
  for (const entry of result.stdout.split("\0").filter(Boolean)) {
    const status = entry.slice(0, 2), file = entry.slice(3), absolute = path.join(cwd, file);
    let fingerprint = status;
    try {
      const stat = fs.statSync(absolute);
      fingerprint += stat.isFile() ? `:${crypto.createHash("sha256").update(fs.readFileSync(absolute)).digest("hex")}` : ":nonfile";
    } catch { fingerprint += ":missing"; }
    files.set(file, { status, fingerprint });
  }
  return files;
};
const changes = (before: ReturnType<typeof snapshot>, cwd: string) => {
  const after = snapshot(cwd), result: Array<{ status: string; path: string }> = [];
  for (const [file, value] of after)
    if (before.get(file)?.fingerprint !== value.fingerprint) result.push({ status: value.status, path: file });
  for (const file of before.keys()) if (!after.has(file)) result.push({ status: "  ", path: file });
  return result.slice(0, 500);
};
const artifact = (run: Run, name: string, args: any) => {
  const raw = args?.path || args?.file || args?.filePath;
  if (typeof raw !== "string") return null;
  const absolute = path.resolve(run.cwd, raw);
  if (absolute !== run.cwd && !absolute.startsWith(`${run.cwd}${path.sep}`)) return null;
  const display = path.relative(run.cwd, absolute) || path.basename(absolute);
  if (name !== "read") return { path: display, kind: name };
  try {
    const lines = fs.readFileSync(absolute, "utf8").split("\n");
    const offset = Math.max(1, Number(args.offset) || 1);
    const end = args.limit ? Math.min(lines.length, offset + Number(args.limit) - 1) : lines.length;
    return { path: display, kind: "read", range: `lines ${offset}–${end}`, content: lines.slice(offset - 1, end).map((line, index) => `${String(offset + index).padStart(5)}  ${line}`).join("\n") };
  } catch { return { path: display, kind: "read" }; }
};
const runtime = (run: Run, providerExtension: string) => service({
  cliPath: "/opt/pi-mono/packages/coding-agent/dist/cli.js",
  providerExtension,
  environment: () => {
    const home = path.join(path.dirname(run.sessionDir), "home");
    fs.mkdirSync(home, { recursive: true, mode: 0o700 });
    return { ...entitledEnvironment(), HOME: home };
  },
  terminateGraceMs: 2_000,
});

export const piRunExecutor = (
  providerExtension = fileURLToPath(new URL("../../child-provider.mjs", import.meta.url)),
): RunExecutor => ({
  async turn(run: Run, prompt: string, continuing: boolean, context: RunContext): Promise<RunExecution> {
    fs.mkdirSync(run.sessionDir, { recursive: true, mode: 0o700 });
    const before = snapshot(run.cwd);
    let output = run.output || "", usage = run.usage, toolCount = run.toolCount ?? 0;
    let modelError: string | null = null;
    const pi = runtime(run, providerExtension);
    const program = Pi.scoped({
      cwd: run.cwd, sessionDir: run.sessionDir, provider: "bashtv", model: "free", thinking: "low", continue: continuing,
    }, (session) => {
      void context.started(session.pid);
      return Pi.runTurn(session, prompt).pipe(Emit.forEach((event: any) => {
        const work: Promise<void>[] = [];
        if (event.type === "message_end" && event.message?.role === "assistant") {
          const text = textParts(event.message.content, "text");
          const thinking = textParts(event.message.content, "thinking");
          if (thinking) work.push(context.emit({ type: "reasoning", text: thinking }));
          if (text) { output = `${output}${text}\n`.slice(-100_000); work.push(context.emit({ type: "message", text })); }
          if (event.message.usage) usage = event.message.usage;
          if (event.message.stopReason === "error") {
            modelError = event.message.errorMessage || "Model request failed";
            work.push(context.emit({ type: "error", text: modelError }));
          }
        } else if (event.type === "tool_execution_start") {
          toolCount++;
          const name = event.toolName || "tool", args = event.args || event.arguments || null;
          work.push(context.emit({ type: "tool", name, args, artifact: artifact(run, name, args), callId: event.toolCallId || null }));
        } else if (event.type === "tool_execution_end" && event.isError)
          work.push(context.emit({ type: "error", text: `${event.toolName || "Tool"} failed`, callId: event.toolCallId || null }));
        return Async.fromPromise(() => Promise.all(work).then(() => undefined));
      }));
    }).pipe(Pi.Service.provide(pi), Fail.orThrow);
    const fiber = runFiber(program as never);
    const abort = () => fiber.interrupt();
    context.signal.addEventListener("abort", abort, { once: true });
    try { await fiber.promise; }
    finally { context.signal.removeEventListener("abort", abort); }
    if (modelError) throw new Error(modelError);
    return { output, usage, toolCount, changes: changes(before, run.cwd) };
  },
  async compact(run: Run, context: RunContext): Promise<RunExecution> {
    const pi = runtime(run, providerExtension);
    let result: any;
    const program = Pi.scoped({
      cwd: run.cwd, sessionDir: run.sessionDir, provider: "bashtv", model: "free", thinking: "low", continue: true,
    }, (session) => {
      void context.started(session.pid);
      return Pi.compact(session).map((value) => { result = value; });
    }).pipe(Pi.Service.provide(pi), Fail.orThrow);
    const fiber = runFiber(program as never);
    const abort = () => fiber.interrupt();
    context.signal.addEventListener("abort", abort, { once: true });
    let timeout: ReturnType<typeof setTimeout> | undefined;
    try {
      await Promise.race([
        fiber.promise,
        new Promise<never>((_resolve, reject) => {
          timeout = setTimeout(() => {
            fiber.interrupt();
            reject(new Error("Pi compaction timed out after 30 seconds"));
          }, 30_000);
        }),
      ]);
    } finally {
      if (timeout) clearTimeout(timeout);
      context.signal.removeEventListener("abort", abort);
    }
    await context.emit({ type: "compaction", text: `Compacted context from ${result?.tokensBefore || "current"} tokens`, result });
    return { output: run.output, usage: result?.tokensBefore ? { ...(run.usage as object || {}), totalTokens: result.estimatedTokensAfter || result.tokensBefore } : run.usage, toolCount: run.toolCount, changes: run.changes, compaction: result };
  },
});
