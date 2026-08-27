import { z } from "zod";
import { api, client, mutation, query, stream } from "@kyoot/rpc";
export { SyncRpc, fromRpc as syncFromRpc, handlers as syncHandlers } from "@kyoot/sync/rpc";

export const RunStatus = z.enum([
  "queued",
  "starting",
  "running",
  "compacting",
  "stopping",
  "completed",
  "failed",
  "stopped",
  "cancelled",
  "interrupted",
]);
export const Run = z
  .object({
    id: z.string(),
    project: z.string(),
    title: z.string().optional(),
    prompt: z.string(),
    status: RunStatus,
    createdAt: z.string(),
    updatedAt: z.string(),
    startedAt: z.string().nullable().optional(),
    endedAt: z.string().nullable().optional(),
    cwd: z.string().optional(),
    exitCode: z.number().nullable().optional(),
    pid: z.number().nullable().optional(),
    output: z.string().optional(),
    finalText: z.string().optional(),
    error: z.string().nullable().optional(),
    events: z.array(z.unknown()).optional(),
    usage: z.unknown().nullable().optional(),
    changes: z.array(z.unknown()).optional(),
    toolCount: z.number().int().nonnegative().optional(),
    turnCount: z.number().int().positive().optional(),
    creator: z.unknown().nullable().optional(),
    originChat: z.unknown().nullable().optional(),
  })
  .catchall(z.unknown());
export type Run = z.output<typeof Run>;
export const RunSummary = z.object({
  id: z.string(),
  project: z.string(),
  title: z.string(),
  promptPreview: z.string(),
  status: RunStatus,
  createdAt: z.string(),
  updatedAt: z.string(),
  startedAt: z.string().nullable().optional(),
  endedAt: z.string().nullable().optional(),
  toolCount: z.number().int().nonnegative(),
  turnCount: z.number().int().positive(),
  eventCursor: z.number().int().nonnegative(),
  creator: z.unknown().nullable().optional(),
  originChat: z.unknown().nullable().optional(),
});
export type RunSummary = z.output<typeof RunSummary>;
export const TrajectoryEventSummary = z.object({
  id: z.string(),
  sequence: z.number().int().positive(),
  type: z.string(),
  turn: z.number().int().nonnegative(),
  at: z.string().nullable(),
  label: z.string(),
  summary: z.string(),
  toolName: z.string().optional(),
  durationMs: z.number().nonnegative().nullable().optional(),
  isError: z.boolean().optional(),
});
export type TrajectoryEventSummary = z.output<typeof TrajectoryEventSummary>;
export const Project = z.object({
  id: z.string(),
  name: z.string(),
  root: z.string().optional(),
  writable: z.boolean(),
});
export type Project = z.output<typeof Project>;
export const RegisterProjectInput = z.object({
  root: z.string().min(1),
  id: z
    .string()
    .regex(/^[a-z0-9][a-z0-9._-]{0,63}$/)
    .optional(),
  name: z.string().min(1).max(100).optional(),
});
export type RegisterProjectInput = z.output<typeof RegisterProjectInput>;
export const FileEntry = z.object({
  name: z.string(),
  path: z.string(),
  type: z.enum(["file", "dir", "link", "directory"]),
  size: z.number().int().nonnegative().optional(),
  mtime: z.string().optional(),
});
export type FileEntry = z.output<typeof FileEntry>;
export const GitCommit = z.object({
  hash: z.string(),
  shortHash: z.string(),
  subject: z.string(),
  author: z.string(),
  authoredAt: z.string(),
});
export type GitCommit = z.output<typeof GitCommit>;
export const Invalidation = z.object({
  id: z.string(),
  keys: z.array(z.array(z.string())),
});
export type Invalidation = z.output<typeof Invalidation>;
export const LiveMessage = z.object({
  sequence: z.number().int().positive(),
  id: z.string(),
  role: z.enum(["user", "assistant"]),
  text: z.string(),
  images: z.array(z.string()),
  timestamp: z.string().optional(),
  author: z
    .object({
      id: z.string().nullable(),
      username: z.string().nullable(),
      pfp: z.string().nullable(),
    })
    .nullable(),
});
export type LiveMessage = z.output<typeof LiveMessage>;
export const LiveMessagePage = z.object({
  messages: z.array(LiveMessage),
  nextCursor: z.string().nullable(),
  reset: z.boolean(),
  more: z.boolean(),
  completed: z.boolean(),
});
export type LiveMessagePage = z.output<typeof LiveMessagePage>;
export const WorkflowTaskStatus = z.enum([
  "blocked",
  "queued",
  "running",
  "retrying",
  "completed",
  "failed",
  "cancelled",
  "skipped",
  "interrupted",
]);
export const WorkflowStatus = z.enum([
  "queued",
  "running",
  "completed",
  "failed",
  "cancelling",
  "cancelled",
  "interrupted",
]);
export const WorkflowTaskSpec = z.object({
  id: z.string().min(1),
  title: z.string().optional(),
  prompt: z.string().min(1),
  project: z.string().min(1),
  dependsOn: z.array(z.string()).optional(),
  retries: z.number().int().nonnegative().optional(),
  timeoutMs: z.number().int().positive().optional(),
  continueOnError: z.boolean().optional(),
  metadata: z.record(z.string(), z.unknown()).optional(),
});
export const WorkflowTask = WorkflowTaskSpec.extend({
  workflowId: z.string(),
  status: WorkflowTaskStatus,
  attempt: z.number().int().nonnegative(),
  createdAt: z.string(),
  startedAt: z.string().nullable(),
  endedAt: z.string().nullable(),
  progress: z.number().nullable(),
  progressLabel: z.string().nullable(),
  output: z.unknown(),
  error: z.string().nullable(),
});
export type WorkflowTask = z.output<typeof WorkflowTask>;
export const Workflow = z.object({
  version: z.literal(1),
  id: z.string(),
  title: z.string(),
  status: WorkflowStatus,
  revision: z.number().int().nonnegative(),
  createdAt: z.string(),
  startedAt: z.string().nullable(),
  endedAt: z.string().nullable(),
  maxConcurrency: z.number().int().positive(),
  failurePolicy: z.enum(["fail-fast", "continue"]),
  metadata: z.record(z.string(), z.unknown()),
  tasks: z.record(z.string(), WorkflowTask),
  counts: z.record(z.string(), z.number().int().nonnegative()),
  error: z.string().nullable(),
});
export type Workflow = z.output<typeof Workflow>;
export const WorkflowEvent = z.object({
  cursor: z.number().int().positive(),
  workflowId: z.string(),
  workflowRevision: z.number().int().nonnegative(),
  taskId: z.string().optional(),
  at: z.string(),
  type: z.string(),
  data: z.unknown().optional(),
});
export type WorkflowEvent = z.output<typeof WorkflowEvent>;

const Empty = z.object({});
const RunId = z.object({ id: z.string() });
const ProjectPath = z.object({ project: z.string(), path: z.string() });
const DomainError = z.object({
  _tag: z.string(),
  message: z.string(),
  operation: z.string().optional(),
  issues: z.array(z.object({ path: z.string(), code: z.string(), message: z.string() })).optional(),
});

/** On-demand operations. Replicated runs/projects use SyncRpc. */
export const WorkbenchRpc = api("workbench", {
  runs: {
    list: query({
      input: Empty,
      output: z.array(RunSummary),
      error: DomainError,
    }),
    get: query({ input: RunId, output: Run, error: DomainError }),
    create: mutation({
      input: z.object({
        id: z.string().optional(),
        project: z.string(),
        prompt: z.string().min(1),
        title: z.string().optional(),
        creator: z.unknown().optional(),
        originChat: z.unknown().optional(),
      }),
      output: Run,
      error: DomainError,
    }),
    message: mutation({
      input: z.object({
        id: z.string(),
        message: z.string().min(1),
        creator: z.unknown().optional(),
        originChat: z.unknown().optional(),
      }),
      output: Run,
      error: DomainError,
    }),
    compact: mutation({ input: RunId, output: Run, error: DomainError }),
    stop: mutation({ input: RunId, output: Run, error: DomainError }),
    events: query({
      input: z.object({
        id: z.string(),
        after: z.number().int().nonnegative().default(0),
        before: z.number().int().positive().nullable().default(null),
        limit: z.number().int().positive().max(1000).default(100),
      }),
      output: z.object({
        events: z.array(z.unknown()),
        nextCursor: z.number().int().nonnegative(),
        previousCursor: z.number().int().positive().nullable(),
        more: z.boolean(),
        moreBefore: z.boolean(),
        reset: z.boolean(),
        completed: z.boolean(),
      }),
      error: DomainError,
    }),
  },
  projects: {
    list: query({ input: Empty, output: z.array(Project) }),
    register: mutation({
      input: RegisterProjectInput,
      output: Project,
      error: DomainError,
    }),
  },
  live: {
    session: query({
      input: z.object({
        messages: z.boolean().default(false),
        trajectory: z.boolean().default(false),
      }),
      output: z.unknown(),
      error: DomainError,
    }),
    page: query({
      input: z.object({
        cursor: z.string().nullable().default(null),
        limit: z.number().int().positive().max(250).default(100),
      }),
      output: LiveMessagePage,
      error: DomainError,
    }),
    trajectory: query({
      input: z.object({
        before: z.number().int().positive().nullable().default(null),
        limit: z.number().int().positive().max(250).default(100),
        query: z.string().max(500).default(""),
      }),
      output: z.object({
        events: z.array(TrajectoryEventSummary),
        previousCursor: z.number().int().positive().nullable(),
        moreBefore: z.boolean(),
        total: z.number().int().nonnegative(),
        overview: z.object({
          turns: z.number().int().nonnegative(),
          tools: z.number().int().nonnegative(),
          users: z.number().int().nonnegative(),
          start: z.string().nullable(),
          end: z.string().nullable(),
          durationMs: z.number().nonnegative(),
        }),
      }),
      error: DomainError,
    }),
    trajectoryEvent: query({
      input: z.object({ id: z.string() }),
      output: z.unknown(),
      error: DomainError,
    }),
  },
  files: {
    tree: query({
      input: ProjectPath,
      output: z.array(FileEntry),
      error: DomainError,
    }),
    read: query({
      input: ProjectPath,
      output: z.object({
        path: z.string(),
        content: z.string().optional(),
        revision: z.string().optional(),
        version: z.string().optional(),
        size: z.number().int().nonnegative().optional(),
        binary: z.boolean(),
        mime: z.string(),
        editable: z.boolean().optional(),
        mtime: z.string().optional(),
      }),
      error: DomainError,
    }),
    write: mutation({
      input: ProjectPath.extend({
        content: z.string(),
        expectedRevision: z.string().optional(),
      }),
      output: z.object({ path: z.string(), revision: z.string() }),
      error: DomainError,
    }),
    search: query({
      input: z.object({
        project: z.string(),
        query: z.string(),
        limit: z.number().int().positive().max(500).default(100),
      }),
      output: z.array(z.object({ path: z.string(), name: z.string() })),
      error: DomainError,
    }),
    contentSearch: query({
      input: z.object({
        project: z.string(),
        query: z.string().min(1),
        regex: z.boolean().default(false),
        include: z.array(z.string()).max(100).default([]),
        exclude: z.array(z.string()).max(100).default([]),
        limit: z.number().int().positive().max(500).default(100),
        maxFileSize: z.number().int().positive().max(67108864).default(2097152),
        contextLines: z.number().int().nonnegative().max(10).default(0),
        timeoutMs: z.number().int().positive().max(300000).default(30000),
      }),
      output: z.object({
        matches: z.array(
          z.object({
            path: z.string(),
            line: z.number().int().positive(),
            text: z.string(),
            contextBefore: z.array(
              z.object({ line: z.number().int().positive(), text: z.string() }),
            ),
            contextAfter: z.array(
              z.object({ line: z.number().int().positive(), text: z.string() }),
            ),
          }),
        ),
        truncated: z.boolean(),
      }),
      error: DomainError,
    }),
  },
  git: {
    info: query({
      input: z.object({ project: z.string(), commit: z.string().optional() }),
      output: z.object({
        branch: z.string(),
        upstream: z.string(),
        ahead: z.number(),
        behind: z.number(),
        status: z.string(),
        commits: z.array(z.unknown()),
        latest: z.unknown().nullable(),
        detail: z.unknown().nullable(),
      }),
      error: DomainError,
    }),
    commits: query({
      input: z.object({
        project: z.string(),
        limit: z.number().int().positive().max(200).default(50),
      }),
      output: z.array(GitCommit),
      error: DomainError,
    }),
    diff: query({
      input: z.object({ project: z.string(), commit: z.string() }),
      output: z.object({ commit: z.string(), diff: z.string() }),
      error: DomainError,
    }),
  },
  workflows: {
    list: query({
      input: Empty,
      output: z.array(Workflow),
      error: DomainError,
    }),
    get: query({
      input: z.object({ id: z.string() }),
      output: Workflow,
      error: DomainError,
    }),
    create: mutation({
      input: z.object({
        id: z.string().optional(),
        title: z.string().min(1),
        tasks: z.array(WorkflowTaskSpec).min(1),
        maxConcurrency: z.number().int().positive().optional(),
        failurePolicy: z.enum(["fail-fast", "continue"]).optional(),
        metadata: z.record(z.string(), z.unknown()).optional(),
      }),
      output: Workflow,
      error: DomainError,
    }),
    addTasks: mutation({
      input: z.object({
        workflowId: z.string(),
        tasks: z.array(WorkflowTaskSpec).min(1),
      }),
      output: z.array(WorkflowTask),
      error: DomainError,
    }),
    cancel: mutation({
      input: z.object({ id: z.string() }),
      output: Workflow,
      error: DomainError,
    }),
    cancelTask: mutation({
      input: z.object({ workflowId: z.string(), taskId: z.string() }),
      output: WorkflowTask,
      error: DomainError,
    }),
    retryTask: mutation({
      input: z.object({ workflowId: z.string(), taskId: z.string() }),
      output: WorkflowTask,
      error: DomainError,
    }),
    events: query({
      input: z.object({
        after: z.number().int().nonnegative().default(0),
        workflowId: z.string().optional(),
        taskId: z.string().optional(),
        limit: z.number().int().positive().max(5000).default(1000),
      }),
      output: z.object({
        cursor: z.number().int().nonnegative(),
        earliestCursor: z.number().int().positive(),
        reset: z.boolean(),
        events: z.array(WorkflowEvent),
      }),
      error: DomainError,
    }),
    watch: stream({
      input: z.object({
        after: z.number().int().nonnegative().default(0),
        workflowId: z.string().optional(),
        taskId: z.string().optional(),
      }),
      output: WorkflowEvent,
      error: DomainError,
    }),
  },
  platform: {
    call: mutation({
      input: z.object({
        operation: z.string().min(1),
        input: z.record(z.string(), z.unknown()).default({}),
      }),
      output: z.unknown(),
      error: DomainError,
    }),
  },
  invalidations: {
    since: query({
      input: z.object({ after: z.number().int().nonnegative() }),
      output: z.object({
        revision: z.number().int().nonnegative(),
        items: z.array(Invalidation),
      }),
    }),
  },
});

export const WorkbenchClient = client(WorkbenchRpc);

export const SyncMutations = {
  createRun: (input: {
    readonly id?: string;
    readonly project: string;
    readonly prompt: string;
    readonly title?: string;
    readonly creator?: unknown;
    readonly originChat?: unknown;
  }) => ({
    type: "runs/create",
    input,
  }),
  messageRun: (input: {
    readonly id: string;
    readonly message: string;
    readonly creator?: unknown;
    readonly originChat?: unknown;
  }) => ({
    type: "runs/message",
    input,
  }),
  compactRun: (id: string) => ({ type: "runs/compact", input: { id } }),
  stopRun: (id: string) => ({ type: "runs/stop", input: { id } }),
  writeFile: (input: {
    readonly project: string;
    readonly path: string;
    readonly content: string;
    readonly expectedRevision?: string;
  }) => ({ type: "files/write", input }),
  createWorkflow: (input: z.input<typeof WorkbenchRpc.shape.workflows.create.input>) => ({
    type: "workflows/create",
    input,
  }),
  addWorkflowTasks: (workflowId: string, tasks: z.input<typeof WorkflowTaskSpec>[]) => ({
    type: "workflows/add-tasks",
    input: { workflowId, tasks },
  }),
  cancelWorkflow: (id: string) => ({ type: "workflows/cancel", input: { id } }),
  cancelWorkflowTask: (workflowId: string, taskId: string) => ({
    type: "workflows/cancel-task",
    input: { workflowId, taskId },
  }),
  retryWorkflowTask: (workflowId: string, taskId: string) => ({
    type: "workflows/retry-task",
    input: { workflowId, taskId },
  }),
} as const;
