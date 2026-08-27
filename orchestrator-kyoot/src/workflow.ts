export type WorkflowStatus =
  | "queued"
  | "running"
  | "completed"
  | "failed"
  | "cancelling"
  | "cancelled"
  | "interrupted";
export type TaskStatus =
  | "blocked"
  | "queued"
  | "running"
  | "retrying"
  | "completed"
  | "failed"
  | "cancelled"
  | "skipped"
  | "interrupted";

export interface TaskSpec {
  readonly id: string;
  readonly title?: string;
  readonly prompt: string;
  readonly project: string;
  readonly dependsOn?: readonly string[];
  readonly retries?: number;
  readonly timeoutMs?: number;
  readonly continueOnError?: boolean;
  readonly metadata?: Readonly<Record<string, unknown>>;
}
export interface WorkflowDefinition {
  readonly id?: string;
  readonly title: string;
  readonly tasks: readonly TaskSpec[];
  readonly maxConcurrency?: number;
  readonly failurePolicy?: "fail-fast" | "continue";
  readonly metadata?: Readonly<Record<string, unknown>>;
}
export interface TaskRecord extends TaskSpec {
  readonly workflowId: string;
  readonly status: TaskStatus;
  readonly attempt: number;
  readonly createdAt: string;
  readonly startedAt: string | null;
  readonly endedAt: string | null;
  readonly progress: number | null;
  readonly progressLabel: string | null;
  readonly output: unknown;
  readonly error: string | null;
}
export interface WorkflowRecord {
  readonly version: 1;
  readonly id: string;
  readonly title: string;
  readonly status: WorkflowStatus;
  readonly revision: number;
  readonly createdAt: string;
  readonly startedAt: string | null;
  readonly endedAt: string | null;
  readonly maxConcurrency: number;
  readonly failurePolicy: "fail-fast" | "continue";
  readonly metadata: Readonly<Record<string, unknown>>;
  readonly tasks: Readonly<Record<string, TaskRecord>>;
  readonly counts: Readonly<Record<TaskStatus, number>>;
  readonly error: string | null;
}
export interface WorkflowEvent {
  readonly cursor: number;
  readonly workflowId: string;
  readonly workflowRevision: number;
  readonly taskId?: string;
  readonly at: string;
  readonly type: string;
  readonly data?: unknown;
}

export class InvalidWorkflow extends Error {
  readonly _tag = "InvalidWorkflow";
  constructor(message: string) {
    super(message);
  }
}
export class WorkflowNotFound extends Error {
  readonly _tag = "WorkflowNotFound";
  readonly id: string;
  constructor(id: string) {
    super(`Unknown workflow ${id}`);
    this.id = id;
  }
}
export class TaskNotFound extends Error {
  readonly _tag = "TaskNotFound";
  readonly workflowId: string;
  readonly taskId: string;
  constructor(workflowId: string, taskId: string) {
    super(`Unknown task ${workflowId}/${taskId}`);
    this.workflowId = workflowId;
    this.taskId = taskId;
  }
}

const statuses: readonly TaskStatus[] = [
  "blocked", "queued", "running", "retrying", "completed", "failed",
  "cancelled", "skipped", "interrupted",
];
export const counts = (tasks: Readonly<Record<string, TaskRecord>>) =>
  Object.fromEntries(statuses.map((status) => [status, Object.values(tasks).filter((task) => task.status === status).length])) as Record<TaskStatus, number>;

export const validateDefinition = (definition: WorkflowDefinition) => {
  if (!definition.title.trim()) throw new InvalidWorkflow("Workflow title is required");
  if (!definition.tasks.length) throw new InvalidWorkflow("Workflow must contain at least one task");
  if (definition.maxConcurrency !== undefined && (!Number.isInteger(definition.maxConcurrency) || definition.maxConcurrency < 1))
    throw new InvalidWorkflow("maxConcurrency must be a positive integer");
  const ids = new Set<string>();
  for (const task of definition.tasks) {
    if (!task.id || ids.has(task.id)) throw new InvalidWorkflow(`Duplicate or empty task id ${task.id}`);
    if (!task.prompt.trim()) throw new InvalidWorkflow(`Task ${task.id} has no prompt`);
    if (!task.project) throw new InvalidWorkflow(`Task ${task.id} has no project`);
    ids.add(task.id);
  }
  for (const task of definition.tasks)
    for (const dependency of task.dependsOn ?? [])
      if (!ids.has(dependency)) throw new InvalidWorkflow(`Task ${task.id} depends on unknown task ${dependency}`);
  const visiting = new Set<string>();
  const visited = new Set<string>();
  const byId = new Map(definition.tasks.map((task) => [task.id, task]));
  const visit = (id: string) => {
    if (visiting.has(id)) throw new InvalidWorkflow(`Dependency cycle includes ${id}`);
    if (visited.has(id)) return;
    visiting.add(id);
    for (const dependency of byId.get(id)?.dependsOn ?? []) visit(dependency);
    visiting.delete(id);
    visited.add(id);
  };
  for (const id of ids) visit(id);
  return definition;
};

export const createWorkflow = (definition: WorkflowDefinition, now = new Date().toISOString()): WorkflowRecord => {
  validateDefinition(definition);
  const id = definition.id ?? crypto.randomUUID();
  const tasks = Object.fromEntries(definition.tasks.map((spec) => [spec.id, {
    ...spec,
    workflowId: id,
    dependsOn: [...(spec.dependsOn ?? [])],
    retries: spec.retries ?? 0,
    timeoutMs: spec.timeoutMs ?? 180_000,
    continueOnError: spec.continueOnError ?? false,
    metadata: spec.metadata ?? {},
    status: spec.dependsOn?.length ? "blocked" : "queued",
    attempt: 0,
    createdAt: now,
    startedAt: null,
    endedAt: null,
    progress: null,
    progressLabel: null,
    output: null,
    error: null,
  } satisfies TaskRecord]));
  return {
    version: 1,
    id,
    title: definition.title,
    status: "queued",
    revision: 0,
    createdAt: now,
    startedAt: null,
    endedAt: null,
    maxConcurrency: definition.maxConcurrency ?? 2,
    failurePolicy: definition.failurePolicy ?? "fail-fast",
    metadata: definition.metadata ?? {},
    tasks,
    counts: counts(tasks),
    error: null,
  };
};

export const replaceTask = (workflow: WorkflowRecord, task: TaskRecord): WorkflowRecord => {
  const tasks = { ...workflow.tasks, [task.id]: task };
  return { ...workflow, tasks, counts: counts(tasks) };
};
export const addTasks = (workflow: WorkflowRecord, specs: readonly TaskSpec[], now = new Date().toISOString()) => {
  const existing = Object.values(workflow.tasks).map((task): TaskSpec => ({
    id: task.id,
    title: task.title,
    prompt: task.prompt,
    project: task.project,
    dependsOn: task.dependsOn,
    retries: task.retries,
    timeoutMs: task.timeoutMs,
    continueOnError: task.continueOnError,
    metadata: task.metadata,
  }));
  const combined: WorkflowDefinition = {
    id: workflow.id,
    title: workflow.title,
    maxConcurrency: workflow.maxConcurrency,
    failurePolicy: workflow.failurePolicy,
    tasks: [...existing, ...specs],
  };
  validateDefinition(combined);
  let next = workflow;
  for (const spec of specs) {
    if (next.tasks[spec.id]) throw new InvalidWorkflow(`Duplicate task id ${spec.id}`);
    const task = createWorkflow({ title: workflow.title, tasks: [{ ...spec, dependsOn: [] }] }, now).tasks[spec.id]!;
    next = replaceTask(next, {
      ...task,
      workflowId: workflow.id,
      dependsOn: [...(spec.dependsOn ?? [])],
      status: spec.dependsOn?.length ? "blocked" : "queued",
    });
  }
  return next;
};
