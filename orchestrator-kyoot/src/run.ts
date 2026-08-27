export type RunStatus =
  | "queued"
  | "starting"
  | "running"
  | "compacting"
  | "stopping"
  | "completed"
  | "failed"
  | "stopped"
  | "interrupted";

export interface RunArtifactReference {
  readonly id: string;
  readonly contentType: string;
  readonly size: number;
  readonly originalSize?: number;
  readonly sha256: string;
  readonly truncated?: boolean;
}

export interface RunEvent {
  readonly id: string;
  readonly sequence?: number;
  readonly at: string;
  readonly type: string;
  readonly [key: string]: unknown;
}

export interface Run {
  readonly version: 1 | 2 | 3;
  readonly id: string;
  readonly title: string;
  readonly prompt: string;
  readonly cwd: string;
  readonly sessionDir: string;
  readonly createdAt: string;
  readonly updatedAt?: string;
  readonly startedAt: string | null;
  readonly endedAt: string | null;
  readonly status: RunStatus;
  readonly pid: number | null;
  readonly exitCode: number | null;
  readonly error: string | null;
  readonly events: readonly RunEvent[];
  readonly output: string;
  readonly outputArtifact?: RunArtifactReference;
  readonly artifactReferences?: readonly RunArtifactReference[];
  readonly turnCount: number;
  readonly creator: unknown;
  readonly originChat: unknown;
  readonly usage?: unknown;
  readonly changes?: readonly unknown[];
  readonly toolCount?: number;
  readonly operation?: "turn" | "compact";
  readonly pendingPrompt?: string | null;
}

const transitions: Readonly<Record<RunStatus, ReadonlySet<RunStatus>>> = {
  queued: new Set(["starting", "stopped"]),
  starting: new Set(["running", "failed", "stopping", "interrupted"]),
  running: new Set(["completed", "failed", "stopping", "interrupted"]),
  compacting: new Set(["completed", "failed", "stopping", "interrupted"]),
  stopping: new Set(["stopped", "failed", "interrupted"]),
  completed: new Set(["queued", "compacting"]),
  failed: new Set(["queued"]),
  stopped: new Set(["queued"]),
  interrupted: new Set(["queued"]),
};

export class InvalidTransition extends Error {
  readonly _tag = "InvalidTransition";
  readonly from: RunStatus;
  readonly to: RunStatus;
  constructor(from: RunStatus, to: RunStatus) {
    super(`Invalid run transition: ${from} → ${to}`);
    this.from = from;
    this.to = to;
  }
}

export const transition = (run: Run, status: RunStatus, patch: Partial<Run> = {}): Run => {
  if (run.status !== status && !transitions[run.status].has(status))
    throw new InvalidTransition(run.status, status);
  return { ...run, ...patch, status };
};

export const recover = (run: Run): Run =>
  ["starting", "running", "compacting", "stopping"].includes(run.status)
    ? { ...run, status: "interrupted", pid: null, endedAt: new Date().toISOString() }
    : run;
