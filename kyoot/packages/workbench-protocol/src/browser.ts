import { Emit, Fail, Kyoot } from "kyoot";
import { client, provide, type Transport } from "@kyoot/rpc";
import { fetchTransport } from "@kyoot/rpc/http";
import { make, type Collection, type Engine } from "@kyoot/sync";
import { queryCache, type Query, type QueryCache } from "@kyoot/sync/query";
import { fromRpc, SyncRpc } from "@kyoot/sync/rpc";
import { assertPlatformInput } from "../../../../workbench-operation-catalog.mjs";
import {
  SyncMutations,
  WorkbenchClient,
  type FileEntry,
  type FileRevision,
  type GitCommit,
  type LiveMessagePage,
  type Project,
  type Run,
  type RunSummary,
  type TrajectoryEventSummary,
  type Workflow,
  type WorkflowEvent,
  type WorkflowTask,
} from "./index.ts";

export interface BrowserOptions {
  readonly rpcUrl?: string;
  readonly syncUrl?: string;
  readonly headers?: Readonly<Record<string, string>>;
  readonly fetch?: typeof globalThis.fetch;
  readonly rpcTransport?: Transport;
  readonly syncTransport?: Transport;
}
export type PlatformOperationName =
  | "workbench_exec"
  | "workbench_read_exec_output"
  | "workbench_start_process"
  | "workbench_read_process"
  | "workbench_write_process"
  | "workbench_stop_process"
  | "workbench_list_processes"
  | "workbench_search_project_content"
  | "workbench_apply_patch"
  | "workbench_fs_mutate"
  | "workbench_export_project"
  | "workbench_list_artifacts"
  | "workbench_download_artifact"
  | "workbench_delete_artifact"
  | "workbench_import_archive"
  | "workbench_create_snapshot"
  | "workbench_list_snapshots"
  | "workbench_restore_snapshot"
  | "workbench_git_diff"
  | "workbench_git_stage"
  | "workbench_git_commit"
  | "workbench_git_branch"
  | "workbench_git_sync"
  | "workbench_list_ports"
  | "workbench_vm_info"
  | "workbench_list_system_processes";
export type PlatformInput = Readonly<
  Record<string, string | number | boolean | readonly string[] | undefined>
>;

export interface WorkbenchStore {
  readonly runs: Collection<RunSummary>;
  readonly projects: Collection<Project>;
  readonly workflows: Collection<Workflow>;
  readonly engine: Engine;
  readonly queries: QueryCache;
  start(): Promise<void>;
  stop(): void;
  liveSession(input?: { readonly messages?: boolean; readonly trajectory?: boolean }): Query<any>;
  liveSessionPage(cursor?: string | null, limit?: number): Promise<LiveMessagePage>;
  liveTrajectory(input?: {
    readonly before?: number | null;
    readonly limit?: number;
    readonly query?: string;
  }): Query<{
    readonly events: readonly TrajectoryEventSummary[];
    readonly previousCursor: number | null;
    readonly moreBefore: boolean;
    readonly total: number;
    readonly overview: {
      readonly turns: number;
      readonly tools: number;
      readonly users: number;
      readonly start: string | null;
      readonly end: string | null;
      readonly durationMs: number;
    };
  }>;
  liveTrajectoryEvent(id: string): Query<any>;
  getRun(id: string): Query<Run>;
  createRun(input: {
    readonly id?: string;
    readonly project: string;
    readonly prompt: string;
    readonly title?: string;
    readonly creator?: unknown;
    readonly originChat?: unknown;
  }): Promise<Run>;
  messageRun(
    id: string,
    message: string,
    attribution?: { readonly creator?: unknown; readonly originChat?: unknown },
  ): Promise<Run>;
  compactRun(id: string): Promise<Run>;
  stopRun(id: string): Promise<Run>;
  runEvents(
    id: string,
    after?: number,
    limit?: number,
  ): Promise<{
    readonly events: readonly unknown[];
    readonly nextCursor: number;
    readonly previousCursor: number | null;
    readonly more: boolean;
    readonly moreBefore: boolean;
    readonly reset: boolean;
    readonly completed: boolean;
  }>;
  runEventPage(
    id: string,
    input?: {
      readonly after?: number;
      readonly before?: number | null;
      readonly limit?: number;
    },
  ): Promise<{
    readonly events: readonly unknown[];
    readonly nextCursor: number;
    readonly previousCursor: number | null;
    readonly more: boolean;
    readonly moreBefore: boolean;
    readonly reset: boolean;
    readonly completed: boolean;
  }>;
  fileTree(project: string, path?: string): Query<readonly FileEntry[]>;
  readFile(
    project: string,
    path: string,
  ): Query<{
    readonly path: string;
    readonly content?: string;
    readonly revision?: string;
    readonly version?: string;
    readonly size?: number;
    readonly binary: boolean;
    readonly mime: string;
    readonly editable?: boolean;
    readonly mtime?: string;
  }>;
  fileRevision(project: string, path: string): Promise<FileRevision>;
  writeFile(input: {
    readonly project: string;
    readonly path: string;
    readonly content: string;
    readonly expectedRevision?: string;
  }): Promise<void>;
  searchFiles(
    project: string,
    query: string,
    limit?: number,
  ): Query<readonly { readonly path: string; readonly name: string }[]>;
  searchProjectContent(input: {
    readonly project: string;
    readonly query: string;
    readonly regex?: boolean;
    readonly include?: readonly string[];
    readonly exclude?: readonly string[];
    readonly limit?: number;
    readonly maxFileSize?: number;
    readonly contextLines?: number;
    readonly timeoutMs?: number;
  }): Query<{
    readonly matches: readonly {
      readonly path: string;
      readonly line: number;
      readonly text: string;
      readonly contextBefore: readonly {
        readonly line: number;
        readonly text: string;
      }[];
      readonly contextAfter: readonly {
        readonly line: number;
        readonly text: string;
      }[];
    }[];
    readonly truncated: boolean;
  }>;
  gitInfo(
    project: string,
    commit?: string,
  ): Query<{
    readonly branch: string;
    readonly upstream: string;
    readonly ahead: number;
    readonly behind: number;
    readonly status: string;
    readonly commits: readonly unknown[];
    readonly latest: unknown;
    readonly detail: unknown;
  }>;
  gitCommits(project: string, limit?: number): Query<readonly GitCommit[]>;
  gitDiff(
    project: string,
    commit: string,
  ): Query<{ readonly commit: string; readonly diff: string }>;
  invokePlatform(operation: PlatformOperationName, input?: PlatformInput): Promise<unknown>;
  createWorkflow(input: {
    readonly id?: string;
    readonly title: string;
    readonly tasks: readonly {
      readonly id: string;
      readonly title?: string;
      readonly prompt: string;
      readonly project: string;
      readonly dependsOn?: readonly string[];
      readonly retries?: number;
      readonly timeoutMs?: number;
      readonly continueOnError?: boolean;
      readonly metadata?: Readonly<Record<string, unknown>>;
    }[];
    readonly maxConcurrency?: number;
    readonly failurePolicy?: "fail-fast" | "continue";
    readonly metadata?: Readonly<Record<string, unknown>>;
  }): Promise<Workflow>;
  addWorkflowTasks(workflowId: string, tasks: readonly any[]): Promise<readonly WorkflowTask[]>;
  cancelWorkflow(id: string): Promise<Workflow>;
  cancelWorkflowTask(workflowId: string, taskId: string): Promise<WorkflowTask>;
  retryWorkflowTask(workflowId: string, taskId: string): Promise<WorkflowTask>;
  workflowEvents(input?: {
    readonly after?: number;
    readonly workflowId?: string;
    readonly taskId?: string;
    readonly limit?: number;
  }): Promise<{
    readonly cursor: number;
    readonly earliestCursor: number;
    readonly reset: boolean;
    readonly events: readonly WorkflowEvent[];
  }>;
  watchWorkflowEvents(input?: {
    readonly after?: number;
    readonly workflowId?: string;
    readonly taskId?: string;
  }): AsyncIterable<WorkflowEvent>;
  refreshInvalidations(): Promise<void>;
}

export const browserStore = (options: BrowserOptions = {}): WorkbenchStore => {
  const rpcTransport =
    options.rpcTransport ??
    fetchTransport({
      url: options.rpcUrl ?? "/api/rpc",
      fetch: options.fetch,
      headers: options.headers,
    });
  const syncTransport =
    options.syncTransport ??
    fetchTransport({
      url: options.syncUrl ?? "/api/sync",
      fetch: options.fetch,
      headers: options.headers,
    });
  const engine = make(fromRpc(client(SyncRpc), syncTransport));
  const queries = queryCache();
  let invalidationRevision = 0;
  const run = <A>(program: import("kyoot").Kyoot<A, any>) =>
    Kyoot.runPromise(program.pipe(provide(rpcTransport), Fail.orThrow) as never) as Promise<A>;
  const query = <A>(key: readonly string[], load: () => Promise<A>) =>
    queries.query(key, () => load());
  const mutate = async <A>(
    mutation: { readonly type: string; readonly input: unknown },
    optimistic: import("@kyoot/sync").Optimistic = [],
  ): Promise<A> => {
    const ack = await engine.mutate(mutation.type, mutation.input, optimistic);
    return ack.result as A;
  };
  const id = () => globalThis.crypto?.randomUUID?.() ?? `${Date.now()}-${Math.random()}`;
  const now = () => new Date().toISOString();
  const put = (collection: string, value: { readonly id: string }) => ({
    collection,
    operation: "put" as const,
    key: value.id,
    value,
  });
  const workflowCounts = (tasks: Workflow["tasks"]) => {
    const counts: Record<string, number> = {};
    for (const task of Object.values(tasks)) counts[task.status] = (counts[task.status] ?? 0) + 1;
    return counts;
  };
  const update =
    <A extends { readonly id: string }>(
      collection: string,
      entityId: string,
      patch: (current: A) => A,
    ): import("@kyoot/sync").Optimistic =>
    (read) => {
      const current = read<A>(collection, entityId);
      return current ? [put(collection, patch(current))] : [];
    };
  return {
    runs: engine.collection<RunSummary>("runs"),
    projects: engine.collection<Project>("projects"),
    workflows: engine.collection<Workflow>("workflows"),
    engine,
    queries,
    start: () => engine.start(),
    stop() {
      queries.clear();
      engine.stop();
    },
    liveSession(input = {}) {
      const messages = input.messages ?? false;
      const trajectory = input.trajectory ?? false;
      return query(["live", messages ? "messages" : "", trajectory ? "trajectory" : ""], () =>
        run(WorkbenchClient.live.session({ messages, trajectory })),
      );
    },
    liveSessionPage: (cursor = null, limit = 100) =>
      run(WorkbenchClient.live.page({ cursor, limit })),
    liveTrajectory(input = {}) {
      const request = {
        before: input.before ?? null,
        limit: input.limit ?? 100,
        query: input.query ?? "",
      };
      return query(["live", "trajectory-page", JSON.stringify(request)], () =>
        run(WorkbenchClient.live.trajectory(request)),
      );
    },
    liveTrajectoryEvent: (id) =>
      query(["live", "trajectory-event", id], () =>
        run(WorkbenchClient.live.trajectoryEvent({ id })),
      ),
    getRun: (id) => query(["run", id], () => run(WorkbenchClient.runs.get({ id }))),
    async createRun(input) {
      const runId = input.id ?? id();
      const createdAt = now();
      const optimistic: RunSummary = {
        id: runId,
        project: input.project,
        title: input.title || input.prompt.split("\n")[0] || "Agent",
        promptPreview: input.prompt.replace(/\s+/g, " ").slice(0, 240),
        status: "queued",
        createdAt,
        updatedAt: createdAt,
        startedAt: null,
        endedAt: null,
        toolCount: 0,
        turnCount: 1,
        eventCursor: 0,
        creator: input.creator ?? null,
        originChat: input.originChat ?? null,
      };
      return mutate<Run>(SyncMutations.createRun({ ...input, id: runId }), [
        put("runs", optimistic),
      ]);
    },
    messageRun: (runId, message, attribution = {}) =>
      mutate<Run>(
        SyncMutations.messageRun({ id: runId, message, ...attribution }),
        update<RunSummary>("runs", runId, (run) => ({
          ...run,
          status: "queued",
          updatedAt: now(),
          endedAt: null,
          turnCount: (run.turnCount ?? 1) + 1,
        })),
      ),
    compactRun: (runId) =>
      mutate<Run>(
        SyncMutations.compactRun(runId),
        update<RunSummary>("runs", runId, (run) => ({
          ...run,
          status: "compacting",
          updatedAt: now(),
          endedAt: null,
          error: null,
        })),
      ),
    runEvents: (id, after = 0, limit = 100) =>
      run(WorkbenchClient.runs.events({ id, after, before: null, limit })),
    runEventPage: (id, input = {}) =>
      run(
        WorkbenchClient.runs.events({
          id,
          after: input.after ?? 0,
          before: input.before ?? null,
          limit: input.limit ?? 100,
        }),
      ),
    stopRun: (runId) =>
      mutate<Run>(
        SyncMutations.stopRun(runId),
        update<RunSummary>("runs", runId, (run) => ({
          ...run,
          status: run.status === "queued" ? "stopped" : "stopping",
          updatedAt: now(),
          ...(run.status === "queued" ? { endedAt: now() } : {}),
        })),
      ),
    fileTree: (project, path = "") =>
      query(["tree", project, path], () => run(WorkbenchClient.files.tree({ project, path }))),
    readFile: (project, path) =>
      query(["file", project, path], () => run(WorkbenchClient.files.read({ project, path }))),
    fileRevision: (project, path) => run(WorkbenchClient.files.revision({ project, path })),
    async writeFile(input) {
      const cached = query(["file", input.project, input.path], () =>
        run(
          WorkbenchClient.files.read({
            project: input.project,
            path: input.path,
          }),
        ),
      );
      const previous = cached.get();
      if (previous.value)
        cached.set({ ...previous.value, content: input.content, binary: false }, { stale: true });
      queries.invalidate(["tree", input.project]);
      queries.invalidate(["git", "status", input.project]);
      try {
        const result = await mutate<{ path: string; revision: string }>(
          SyncMutations.writeFile(input),
        );
        const current = cached.get().value;
        if (current)
          cached.set({
            ...current,
            content: input.content,
            revision: result.revision,
            version: result.revision,
          });
      } catch (error) {
        cached.restore(previous);
        throw error;
      }
    },
    searchFiles: (project, search, limit = 100) =>
      query(["search", project, search, String(limit)], () =>
        run(WorkbenchClient.files.search({ project, query: search, limit })),
      ),
    searchProjectContent: (input) =>
      query(["content-search", JSON.stringify(input)], () =>
        run(
          WorkbenchClient.files.contentSearch({
            ...input,
            include: input.include ? [...input.include] : undefined,
            exclude: input.exclude ? [...input.exclude] : undefined,
          }),
        ),
      ),
    gitInfo: (project, commit) =>
      query(["git", "info", project, commit ?? ""], () =>
        run(WorkbenchClient.git.info({ project, commit })),
      ),
    gitCommits: (project, limit = 50) =>
      query(["git", "commits", project, String(limit)], () =>
        run(WorkbenchClient.git.commits({ project, limit })),
      ),
    gitDiff: (project, commit) =>
      query(["git", "diff", project, commit], () =>
        run(WorkbenchClient.git.diff({ project, commit })),
      ),
    invokePlatform: (operation, input = {}) => {
      assertPlatformInput(operation, input);
      return run(
        WorkbenchClient.platform.call({
          operation,
          input: input as Record<string, unknown>,
        }),
      );
    },
    createWorkflow: (input) => {
      const workflowId = input.id ?? id();
      const createdAt = now();
      const tasks: Record<string, WorkflowTask> = Object.fromEntries(
        input.tasks.map((task) => [
          task.id,
          {
            ...task,
            dependsOn: task.dependsOn ? [...task.dependsOn] : undefined,
            workflowId,
            status: task.dependsOn?.length ? ("blocked" as const) : ("queued" as const),
            attempt: 0,
            createdAt,
            startedAt: null,
            endedAt: null,
            progress: null,
            progressLabel: null,
            output: null,
            error: null,
          },
        ]),
      );
      const optimistic: Workflow = {
        version: 1,
        id: workflowId,
        title: input.title,
        status: "queued",
        revision: 0,
        createdAt,
        startedAt: null,
        endedAt: null,
        maxConcurrency: input.maxConcurrency ?? 1,
        failurePolicy: input.failurePolicy ?? "fail-fast",
        metadata: input.metadata ?? {},
        tasks,
        counts: workflowCounts(tasks),
        error: null,
      };
      return mutate<Workflow>(SyncMutations.createWorkflow({ ...input, id: workflowId } as never), [
        put("workflows", optimistic),
      ]);
    },
    addWorkflowTasks: (workflowId, tasks) =>
      mutate<readonly WorkflowTask[]>(
        SyncMutations.addWorkflowTasks(workflowId, tasks as never),
        update<Workflow>("workflows", workflowId, (workflow) => {
          const createdAt = now();
          const added: Record<string, WorkflowTask> = Object.fromEntries(
            tasks.map((task: any) => [
              task.id,
              {
                ...task,
                workflowId,
                status: task.dependsOn?.length ? "blocked" : "queued",
                attempt: 0,
                createdAt,
                startedAt: null,
                endedAt: null,
                progress: null,
                progressLabel: null,
                output: null,
                error: null,
              },
            ]),
          );
          const nextTasks = { ...workflow.tasks, ...added };
          return {
            ...workflow,
            revision: workflow.revision + 1,
            tasks: nextTasks,
            counts: workflowCounts(nextTasks),
          };
        }),
      ),
    cancelWorkflow: (workflowId) =>
      mutate<Workflow>(
        SyncMutations.cancelWorkflow(workflowId),
        update<Workflow>("workflows", workflowId, (workflow) => ({
          ...workflow,
          status: "cancelling",
          revision: workflow.revision + 1,
        })),
      ),
    cancelWorkflowTask: (workflowId, taskId) =>
      mutate<WorkflowTask>(
        SyncMutations.cancelWorkflowTask(workflowId, taskId),
        update<Workflow>("workflows", workflowId, (workflow) => {
          const tasks = {
            ...workflow.tasks,
            [taskId]: {
              ...workflow.tasks[taskId]!,
              status: "cancelled" as const,
              endedAt: now(),
            },
          };
          return {
            ...workflow,
            revision: workflow.revision + 1,
            tasks,
            counts: workflowCounts(tasks),
          };
        }),
      ),
    retryWorkflowTask: (workflowId, taskId) =>
      mutate<WorkflowTask>(
        SyncMutations.retryWorkflowTask(workflowId, taskId),
        update<Workflow>("workflows", workflowId, (workflow) => {
          const tasks = {
            ...workflow.tasks,
            [taskId]: {
              ...workflow.tasks[taskId]!,
              status: "queued" as const,
              endedAt: null,
              error: null,
              progress: null,
              progressLabel: null,
            },
          };
          return {
            ...workflow,
            status: "running" as const,
            revision: workflow.revision + 1,
            endedAt: null,
            error: null,
            tasks,
            counts: workflowCounts(tasks),
          };
        }),
      ),
    workflowEvents: (input = {}) =>
      run(
        WorkbenchClient.workflows.events({
          after: input.after ?? 0,
          workflowId: input.workflowId,
          taskId: input.taskId,
          limit: input.limit ?? 1000,
        }),
      ),
    watchWorkflowEvents(input = {}) {
      let cursor = input.after ?? 0;
      let stopped = false;
      return {
        async *[Symbol.asyncIterator]() {
          while (!stopped) {
            const replay = await run(
              WorkbenchClient.workflows.events({
                after: cursor,
                workflowId: input.workflowId,
                taskId: input.taskId,
                limit: 5000,
              }),
            );
            if (replay.reset) await engine.refresh();
            for (const event of replay.events) {
              cursor = Math.max(cursor, event.cursor);
              yield event;
            }
            const iterable = Emit.toAsyncIterable(
              WorkbenchClient.workflows
                .watch({
                  after: cursor,
                  workflowId: input.workflowId,
                  taskId: input.taskId,
                })
                .pipe(provide(rpcTransport)) as never,
            ) as AsyncIterable<WorkflowEvent>;
            try {
              for await (const event of iterable) {
                if (event.cursor <= cursor) continue;
                cursor = event.cursor;
                yield event;
              }
            } catch {
              if (!stopped) await new Promise((resolve) => setTimeout(resolve, 250));
            }
          }
        },
        stop() {
          stopped = true;
        },
      } as AsyncIterable<WorkflowEvent> & { stop(): void };
    },
    async refreshInvalidations() {
      const next = await run(WorkbenchClient.invalidations.since({ after: invalidationRevision }));
      for (const item of next.items) for (const key of item.keys) queries.invalidate(key);
      invalidationRevision = next.revision;
    },
  };
};
