import { Async, Emit, Fail, Kyoot, Result } from "kyoot";
import { router } from "@kyoot/rpc";
import { httpApp } from "@kyoot/rpc/http";
import { authority, type Change, type Mutation } from "@kyoot/sync";
import { handlers as syncHandlers, SyncRpc } from "@kyoot/sync/rpc";
import {
  WorkbenchRpc,
  type FileEntry,
  type GitCommit,
  type Project,
  type Run,
  type Workflow,
  type WorkflowEvent,
  type WorkflowTask,
} from "@kyoot/workbench-protocol";

export interface WorkflowBackend {
  list(): Promise<readonly Workflow[]>;
  get(id: string): Promise<Workflow>;
  create(input: any): Promise<Workflow>;
  addTasks(
    workflowId: string,
    tasks: readonly any[],
  ): Promise<readonly WorkflowTask[]>;
  cancel(id: string): Promise<Workflow>;
  cancelTask(workflowId: string, taskId: string): Promise<WorkflowTask>;
  retryTask(workflowId: string, taskId: string): Promise<WorkflowTask>;
  events(query?: {
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
  subscribe(listener: (event: WorkflowEvent) => void): () => void;
}

export interface WorkbenchBackend {
  listRuns(): Promise<readonly Run[]>;
  listProjects(): Promise<readonly Project[]>;
  liveSession(input: {
    readonly messages?: boolean;
    readonly trajectory?: boolean;
  }): Promise<unknown>;
  liveSessionPage?(input: {
    readonly cursor?: string | null;
    readonly limit?: number;
  }): Promise<{
    readonly messages: readonly unknown[];
    readonly nextCursor: string | null;
    readonly reset: boolean;
    readonly more: boolean;
    readonly completed: boolean;
  }>;
  getRun(id: string): Promise<Run>;
  createRun(input: {
    readonly id?: string;
    readonly project: string;
    readonly prompt: string;
    readonly title?: string;
    readonly creator?: unknown;
    readonly originChat?: unknown;
  }): Promise<Run>;
  messageRun(input: {
    readonly id: string;
    readonly message: string;
    readonly creator?: unknown;
    readonly originChat?: unknown;
  }): Promise<Run>;
  compactRun(id: string): Promise<Run>;
  stopRun(id: string): Promise<Run>;
  runEvents?(
    id: string,
    after?: number,
    limit?: number,
  ): Promise<{
    readonly events: readonly unknown[];
    readonly nextCursor: number;
    readonly more: boolean;
    readonly reset: boolean;
    readonly completed: boolean;
  }>;
  fileTree(project: string, path: string): Promise<readonly FileEntry[]>;
  readFile(
    project: string,
    path: string,
  ): Promise<{
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
  writeFile(input: {
    readonly project: string;
    readonly path: string;
    readonly content: string;
    readonly expectedRevision?: string;
  }): Promise<{ readonly path: string; readonly revision: string }>;
  searchFiles(input: {
    readonly project: string;
    readonly query: string;
    readonly limit: number;
  }): Promise<readonly { readonly path: string; readonly name: string }[]>;
  contentSearch?(input: {
    readonly project: string;
    readonly query: string;
    readonly regex?: boolean;
    readonly include?: readonly string[];
    readonly exclude?: readonly string[];
    readonly limit?: number;
    readonly maxFileSize?: number;
    readonly contextLines?: number;
    readonly timeoutMs?: number;
  }, options?: { readonly signal?: AbortSignal }): Promise<{
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
  ): Promise<{
    readonly branch: string;
    readonly upstream: string;
    readonly ahead: number;
    readonly behind: number;
    readonly status: string;
    readonly commits: readonly unknown[];
    readonly latest: unknown;
    readonly detail: unknown;
  }>;
  gitCommits(project: string, limit: number): Promise<readonly GitCommit[]>;
  gitDiff(
    project: string,
    commit: string,
  ): Promise<{ readonly commit: string; readonly diff: string }>;
  invokePlatform?(
    operation: string,
    input: Record<string, unknown>,
    options?: { readonly signal?: AbortSignal },
  ): Promise<unknown> | unknown;
}

const putRun = (run: Run): Change => ({
  collection: "runs",
  operation: "put",
  key: run.id,
  value: run,
});
const putWorkflow = (workflow: Workflow): Change => ({
  collection: "workflows",
  operation: "put",
  key: workflow.id,
  value: workflow,
});
const putProject = (project: Project): Change => ({
  collection: "projects",
  operation: "put",
  key: project.id,
  value: project,
});
const domainError = (error: unknown) =>
  error && typeof error === "object" && "_tag" in error
    ? error
    : {
        _tag: "WorkbenchError",
        message: error instanceof Error ? error.message : String(error),
      };
const promise = <A>(work: (signal: AbortSignal) => Promise<A>) =>
  Async.fromPromise(async (signal) => {
    try {
      return Result.ok(await work(signal));
    } catch (error) {
      return Result.fail(domainError(error));
    }
  }).map(Fail.fromResult) as never;

export const makeTypedApi = async (
  backend: WorkbenchBackend,
  workflowBackend?: WorkflowBackend,
) => {
  const [runs, projects, workflows] = await Promise.all([
    backend.listRuns(),
    backend.listProjects(),
    workflowBackend?.list() ?? [],
  ]);
  let runState = new Map(runs.map((run) => [run.id, JSON.stringify(run)]));
  const mutationResult = (run: Run) => {
    runState.set(run.id, JSON.stringify(run));
    return { changes: [putRun(run)], result: run };
  };
  const sync = authority({
    initial: { runs, projects, workflows },
    async apply(mutation: Mutation) {
      switch (mutation.type) {
        case "runs/create":
          return mutationResult(
            await backend.createRun(mutation.input as never),
          );
        case "runs/message":
          return mutationResult(
            await backend.messageRun(mutation.input as never),
          );
        case "runs/compact":
          return mutationResult(
            await backend.compactRun((mutation.input as { id: string }).id),
          );
        case "runs/stop":
          return mutationResult(
            await backend.stopRun((mutation.input as { id: string }).id),
          );
        case "files/write": {
          const input = mutation.input as {
            project: string;
            path: string;
            content: string;
            expectedRevision?: string;
          };
          const result = await backend.writeFile(input);
          invalidate([
            ["file", input.project, input.path],
            ["tree", input.project],
            ["git", "status", input.project],
          ]);
          return { changes: [], result };
        }
        case "workflows/create": {
          if (!workflowBackend)
            throw new Error("Workflow orchestration is unavailable");
          const workflow = await workflowBackend.create(
            mutation.input as never,
          );
          return { changes: [putWorkflow(workflow)], result: workflow };
        }
        case "workflows/add-tasks": {
          if (!workflowBackend)
            throw new Error("Workflow orchestration is unavailable");
          const input = mutation.input as {
            workflowId: string;
            tasks: readonly any[];
          };
          const tasks = await workflowBackend.addTasks(
            input.workflowId,
            input.tasks,
          );
          return {
            changes: [putWorkflow(await workflowBackend.get(input.workflowId))],
            result: tasks,
          };
        }
        case "workflows/cancel": {
          if (!workflowBackend)
            throw new Error("Workflow orchestration is unavailable");
          const workflow = await workflowBackend.cancel(
            (mutation.input as { id: string }).id,
          );
          return { changes: [putWorkflow(workflow)], result: workflow };
        }
        case "workflows/cancel-task": {
          if (!workflowBackend)
            throw new Error("Workflow orchestration is unavailable");
          const input = mutation.input as {
            workflowId: string;
            taskId: string;
          };
          const task = await workflowBackend.cancelTask(
            input.workflowId,
            input.taskId,
          );
          return {
            changes: [putWorkflow(await workflowBackend.get(input.workflowId))],
            result: task,
          };
        }
        case "workflows/retry-task": {
          if (!workflowBackend)
            throw new Error("Workflow orchestration is unavailable");
          const input = mutation.input as {
            workflowId: string;
            taskId: string;
          };
          const task = await workflowBackend.retryTask(
            input.workflowId,
            input.taskId,
          );
          return {
            changes: [putWorkflow(await workflowBackend.get(input.workflowId))],
            result: task,
          };
        }
        default:
          throw new Error(`Unknown sync mutation ${mutation.type}`);
      }
    },
  });
  const refreshRuns = async () => {
    const next = await backend.listRuns();
    const changes: Change[] = [];
    const present = new Set<string>();
    for (const run of next) {
      present.add(run.id);
      const serialized = JSON.stringify(run);
      if (runState.get(run.id) !== serialized) changes.push(putRun(run));
      runState.set(run.id, serialized);
    }
    for (const id of runState.keys())
      if (!present.has(id)) {
        changes.push({ collection: "runs", operation: "delete", key: id });
        runState.delete(id);
      }
    if (changes.length) sync.commit(changes);
    return changes.length;
  };
  if (workflowBackend)
    workflowBackend.subscribe((event) => {
      if (
        !event.type.startsWith("workflow.") &&
        !event.type.startsWith("task.")
      )
        return;
      void workflowBackend
        .get(event.workflowId)
        .then((workflow) => {
          sync.commit([putWorkflow(workflow)]);
        })
        .catch(() => {});
    });
  const invalidations: Array<{ id: string; keys: string[][] }> = [];
  let invalidationRevision = 0;
  const invalidate = (keys: string[][]) => {
    invalidationRevision++;
    invalidations.push({ id: String(invalidationRevision), keys });
    if (invalidations.length > 1_000) invalidations.shift();
  };

  const workbench = router(WorkbenchRpc, {
    runs: {
      get: ({ id }) => promise(() => backend.getRun(id)),
      create: (input) =>
        promise(async () => {
          const run = await backend.createRun(input);
          runState.set(run.id, JSON.stringify(run));
          sync.commit([putRun(run)]);
          return run;
        }),
      message: (input) =>
        promise(async () => {
          const run = await backend.messageRun(input);
          runState.set(run.id, JSON.stringify(run));
          sync.commit([putRun(run)]);
          return run;
        }),
      compact: ({ id }) =>
        promise(async () => {
          const run = await backend.compactRun(id);
          runState.set(run.id, JSON.stringify(run));
          sync.commit([putRun(run)]);
          return run;
        }),
      stop: ({ id }) =>
        promise(async () => {
          const run = await backend.stopRun(id);
          runState.set(run.id, JSON.stringify(run));
          sync.commit([putRun(run)]);
          return run;
        }),
      events: ({ id, after, limit }) =>
        promise(async () =>
          backend.runEvents
            ? backend.runEvents(id, after, limit)
            : {
                events: (await backend.getRun(id)).events ?? [],
                nextCursor: 0,
                more: false,
                reset: false,
                completed: true,
              },
        ),
    },
    projects: {
      list: () => promise(async () => [...(await backend.listProjects())]),
    },
    live: {
      session: (input) => promise(() => backend.liveSession(input)),
      page: (input) =>
        promise(() => {
          if (!backend.liveSessionPage)
            throw new Error("Live session paging is unavailable");
          return backend.liveSessionPage(input);
        }),
    },
    files: {
      tree: ({ project, path }) =>
        promise(async () => [...(await backend.fileTree(project, path))]),
      read: ({ project, path }) =>
        promise(() => backend.readFile(project, path)),
      write: (input) =>
        promise(async () => {
          const result = await backend.writeFile(input);
          invalidate([
            ["file", input.project, input.path],
            ["tree", input.project],
            ["git", "status", input.project],
          ]);
          return result;
        }),
      search: (input) =>
        promise(async () => [
          ...(await backend.searchFiles({
            ...input,
            limit: input.limit ?? 100,
          })),
        ]),
      contentSearch: (input) =>
        promise((signal) => {
          if (!backend.contentSearch)
            throw new Error("Project content search is unavailable");
          return backend.contentSearch(input, { signal });
        }),
    },
    git: {
      info: ({ project, commit }) =>
        promise(async () => {
          const info = await backend.gitInfo(project, commit);
          return { ...info, commits: [...info.commits] };
        }),
      commits: ({ project, limit }) =>
        promise(async () => [
          ...(await backend.gitCommits(project, limit ?? 50)),
        ]),
      diff: ({ project, commit }) =>
        promise(() => backend.gitDiff(project, commit)),
    },
    workflows: {
      list: () =>
        promise(async () => [...((await workflowBackend?.list()) ?? [])]),
      get: ({ id }) =>
        promise(async () => {
          if (!workflowBackend)
            throw new Error("Workflow orchestration is unavailable");
          return workflowBackend.get(id);
        }),
      create: (input) =>
        promise(async () => {
          if (!workflowBackend)
            throw new Error("Workflow orchestration is unavailable");
          return workflowBackend.create(input);
        }),
      addTasks: ({ workflowId, tasks }) =>
        promise(async () => {
          if (!workflowBackend)
            throw new Error("Workflow orchestration is unavailable");
          return [...(await workflowBackend.addTasks(workflowId, tasks))];
        }),
      cancel: ({ id }) =>
        promise(async () => {
          if (!workflowBackend)
            throw new Error("Workflow orchestration is unavailable");
          return workflowBackend.cancel(id);
        }),
      cancelTask: ({ workflowId, taskId }) =>
        promise(async () => {
          if (!workflowBackend)
            throw new Error("Workflow orchestration is unavailable");
          return workflowBackend.cancelTask(workflowId, taskId);
        }),
      retryTask: ({ workflowId, taskId }) =>
        promise(async () => {
          if (!workflowBackend)
            throw new Error("Workflow orchestration is unavailable");
          return workflowBackend.retryTask(workflowId, taskId);
        }),
      events: (input) =>
        promise(async () => {
          if (!workflowBackend)
            throw new Error("Workflow orchestration is unavailable");
          const page = await workflowBackend.events(input);
          return { ...page, events: [...page.events] };
        }),
      watch: (input) => {
        if (!workflowBackend)
          return Fail.fail(
            domainError(new Error("Workflow orchestration is unavailable")),
          ) as never;
        const stream = {
          [Symbol.asyncIterator]() {
            const queued: WorkflowEvent[] = [];
            let wake = () => {};
            let closed = false;
            const matches = (event: WorkflowEvent) =>
              event.cursor > (input.after ?? 0) &&
              (!input.workflowId || event.workflowId === input.workflowId) &&
              (!input.taskId || event.taskId === input.taskId);
            const unsubscribe = workflowBackend.subscribe((event) => {
              if (!matches(event)) return;
              queued.push(event);
              wake();
            });
            void workflowBackend
              .events({ ...input, limit: 5000 })
              .then((page) => {
                const existing = new Set(queued.map((event) => event.cursor));
                queued.unshift(
                  ...page.events.filter(
                    (event) => matches(event) && !existing.has(event.cursor),
                  ),
                );
                queued.sort((a, b) => a.cursor - b.cursor);
                wake();
              });
            return {
              async next() {
                while (!queued.length && !closed)
                  await new Promise<void>((resolve) => {
                    wake = resolve;
                  });
                return queued.length
                  ? { value: queued.shift()!, done: false as const }
                  : { value: undefined, done: true as const };
              },
              async return() {
                closed = true;
                unsubscribe();
                wake();
                return { value: undefined, done: true as const };
              },
            };
          },
        };
        return Emit.fromAsyncIterable(stream) as never;
      },
    },
    platform: {
      call: ({ operation, input }) =>
        promise(async (signal) => {
          if (!backend.invokePlatform)
            throw new Error("Platform operations are unavailable");
          return backend.invokePlatform(operation, input ?? {}, { signal });
        }),
    },
    invalidations: {
      since: ({ after }) =>
        Kyoot.succeed({
          revision: invalidationRevision,
          items: invalidations.filter((item) => Number(item.id) > after),
        }),
    },
  });

  return {
    sync,
    refreshRuns,
    workbench,
    syncApp: httpApp(router(SyncRpc, syncHandlers(sync))),
    workbenchApp: httpApp(workbench),
  };
};
