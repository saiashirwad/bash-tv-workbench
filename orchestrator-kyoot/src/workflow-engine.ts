import type { EventPage, EventQuery, WorkflowStore } from "./workflow-store.ts";
import {
  TaskNotFound,
  WorkflowNotFound,
  addTasks as appendTasks,
  counts,
  replaceTask,
  type TaskRecord,
  type TaskSpec,
  type WorkflowDefinition,
  type WorkflowEvent,
  type WorkflowRecord,
  createWorkflow,
} from "./workflow.ts";

export interface TaskContext {
  readonly signal: AbortSignal;
  readonly workflowId: string;
  readonly taskId: string;
  readonly attempt: number;
  progress(value: number | null, label?: string): Promise<void>;
  emit(type: string, data?: unknown): Promise<void>;
  addTasks(tasks: readonly TaskSpec[]): Promise<readonly TaskRecord[]>;
}
export interface TaskExecutor {
  execute(task: TaskRecord, context: TaskContext): Promise<unknown>;
}
export interface EngineOptions {
  readonly maxConcurrency?: number;
  readonly coldStartSpacingMs?: number;
  readonly now?: () => Date;
  readonly id?: () => string;
}
export interface WorkflowEngine {
  list(): Promise<readonly WorkflowRecord[]>;
  get(id: string): Promise<WorkflowRecord>;
  submit(definition: WorkflowDefinition): Promise<WorkflowRecord>;
  addTasks(workflowId: string, tasks: readonly TaskSpec[]): Promise<readonly TaskRecord[]>;
  cancel(workflowId: string): Promise<WorkflowRecord>;
  cancelTask(workflowId: string, taskId: string): Promise<TaskRecord>;
  retryTask(workflowId: string, taskId: string): Promise<TaskRecord>;
  events(query?: EventQuery): Promise<EventPage>;
  subscribe(listener: (event: WorkflowEvent) => void): () => void;
  shutdown(): Promise<void>;
}

const terminalTasks = new Set(["completed", "failed", "cancelled", "skipped", "interrupted"]);
const terminalWorkflows = new Set(["completed", "failed", "cancelled", "interrupted"]);
const errorText = (error: unknown) => error instanceof Error ? error.message : String(error);

export const makeEngine = async (
  store: WorkflowStore,
  executor: TaskExecutor,
  options: EngineOptions = {},
): Promise<WorkflowEngine> => {
  const maxConcurrency = options.maxConcurrency ?? 5;
  const spacing = options.coldStartSpacingMs ?? 1_500;
  const now = () => (options.now?.() ?? new Date()).toISOString();
  const controllers = new Map<string, AbortController>();
  const locks = new Map<string, Promise<unknown>>();
  let active = 0;
  let lastStart = 0;
  let stopped = false;
  let wakeTimer: ReturnType<typeof setTimeout> | undefined;

  const locked = <A>(id: string, work: () => Promise<A>): Promise<A> => {
    const previous = locks.get(id) ?? Promise.resolve();
    const next = previous.catch(() => {}).then(work);
    locks.set(id, next);
    const cleanup = () => { if (locks.get(id) === next) locks.delete(id); };
    void next.then(cleanup, cleanup);
    return next;
  };
  const requireWorkflow = async (id: string) => {
    const workflow = await store.get(id);
    if (!workflow) throw new WorkflowNotFound(id);
    return workflow;
  };
  const persist = async (
    workflow: WorkflowRecord,
    type: string,
    taskId?: string,
    data?: unknown,
  ) => {
    const next = { ...workflow, revision: workflow.revision + 1 };
    await store.put(next);
    await store.append({
      workflowId: next.id,
      workflowRevision: next.revision,
      ...(taskId ? { taskId } : {}),
      at: now(),
      type,
      ...(data === undefined ? {} : { data }),
    });
    return next;
  };
  const dependencyState = (workflow: WorkflowRecord, task: TaskRecord) => {
    const dependencies = (task.dependsOn ?? []).map((id) => workflow.tasks[id]!);
    if (dependencies.some((dependency) => !terminalTasks.has(dependency.status))) return "wait";
    if (dependencies.some((dependency) => dependency.status !== "completed")) return "failed";
    return "ready";
  };
  const reconcile = async (workflow: WorkflowRecord) => {
    let next = workflow;
    for (const task of Object.values(next.tasks)) {
      if (task.status !== "blocked") continue;
      const state = dependencyState(next, task);
      if (state === "ready") {
        next = replaceTask(next, { ...task, status: "queued" });
        next = await persist(next, "task.queued", task.id);
      } else if (state === "failed") {
        next = replaceTask(next, {
          ...task,
          status: "skipped",
          endedAt: now(),
          error: "Dependency did not complete successfully",
        });
        next = await persist(next, "task.skipped", task.id, { reason: "dependency" });
      }
    }
    const tasks = Object.values(next.tasks);
    if (!tasks.length || tasks.some((task) => !terminalTasks.has(task.status))) return next;
    const failures = tasks.filter((task) => task.status === "failed" || task.status === "interrupted");
    const cancelled = tasks.every((task) => task.status === "cancelled" || task.status === "skipped");
    const status = next.status === "cancelling"
      ? "cancelled"
      : cancelled ? "cancelled" : failures.length ? "failed" : "completed";
    if (next.status !== status)
      next = await persist({
        ...next,
        status,
        endedAt: now(),
        error: failures[0]?.error ?? null,
        counts: counts(next.tasks),
      }, `workflow.${status}`, undefined, { counts: counts(next.tasks) });
    return next;
  };

  const schedule = () => {
    if (stopped || wakeTimer) return;
    wakeTimer = setTimeout(() => {
      wakeTimer = undefined;
      void pump();
    }, 0);
  };
  const runTask = async (workflowId: string, taskId: string) => {
    const key = `${workflowId}/${taskId}`;
    const controller = new AbortController();
    controllers.set(key, controller);
    active++;
    try {
      let task!: TaskRecord;
      await locked(workflowId, async () => {
        let workflow = await requireWorkflow(workflowId);
        const current = workflow.tasks[taskId];
        if (!current || current.status !== "queued") return;
        task = {
          ...current,
          status: "running",
          attempt: current.attempt + 1,
          startedAt: current.startedAt ?? now(),
          endedAt: null,
          error: null,
        };
        workflow = replaceTask(workflow, task);
        workflow = await persist({
          ...workflow,
          status: "running",
          startedAt: workflow.startedAt ?? now(),
        }, "task.started", task.id, { attempt: task.attempt });
      });
      if (!task) return;
      const context: TaskContext = {
        signal: controller.signal,
        workflowId,
        taskId,
        attempt: task.attempt,
        progress: async (value, label) => {
          await locked(workflowId, async () => {
            let workflow = await requireWorkflow(workflowId);
            const current = workflow.tasks[taskId];
            if (!current || current.status !== "running") return;
            const progress = value === null ? null : Math.max(0, Math.min(1, value));
            workflow = replaceTask(workflow, {
              ...current,
              progress,
              progressLabel: label ?? null,
            });
            await persist(workflow, "task.progress", taskId, { progress, label: label ?? null });
          });
        },
        emit: async (type, data) => {
          const workflow = await requireWorkflow(workflowId);
          await store.append({ workflowId, workflowRevision: workflow.revision, taskId, at: now(), type, data });
        },
        addTasks: (tasks) => engine.addTasks(workflowId, tasks),
      };
      let output: unknown;
      let failure: unknown;
      let timedOut = false;
      let timer: ReturnType<typeof setTimeout> | undefined;
      const timeout = new Promise<never>((_resolve, reject) => {
        timer = setTimeout(() => {
          timedOut = true;
          const error = new Error(`Task timed out after ${task.timeoutMs}ms`);
          controller.abort(error);
          reject(error);
        }, task.timeoutMs);
      });
      try {
        output = await Promise.race([executor.execute(task, context), timeout]);
      } catch (error) {
        failure = error;
      } finally {
        if (timer) clearTimeout(timer);
      }
      await locked(workflowId, async () => {
        let workflow = await requireWorkflow(workflowId);
        const current = workflow.tasks[taskId];
        if (!current || current.status !== "running") return;
        if (failure !== undefined && !controller.signal.aborted && current.attempt <= (current.retries ?? 0)) {
          workflow = replaceTask(workflow, {
            ...current,
            status: "retrying",
            error: errorText(failure),
            progress: null,
            progressLabel: null,
          });
          workflow = await persist(workflow, "task.retrying", taskId, {
            attempt: current.attempt,
            error: errorText(failure),
          });
          workflow = replaceTask(workflow, { ...workflow.tasks[taskId]!, status: "queued" });
          await persist(workflow, "task.queued", taskId, { retry: true });
          return;
        }
        const cancelled = controller.signal.aborted && !timedOut;
        const status = failure === undefined && !controller.signal.aborted
          ? "completed"
          : cancelled ? "cancelled" : "failed";
        const finished = {
          ...current,
          status,
          endedAt: now(),
          progress: status === "completed" ? 1 : current.progress,
          output: status === "completed" ? output : current.output,
          error: status === "completed" ? null : timedOut
            ? `Task timed out after ${task.timeoutMs}ms`
            : cancelled ? "Cancelled" : errorText(failure),
        } satisfies TaskRecord;
        workflow = replaceTask(workflow, finished);
        workflow = await persist(workflow, `task.${status}`, taskId, {
          attempt: finished.attempt,
          error: finished.error,
        });
        if (status === "failed" && workflow.failurePolicy === "fail-fast" && !finished.continueOnError) {
          for (const sibling of Object.values(workflow.tasks)) {
            if (sibling.id === taskId || terminalTasks.has(sibling.status)) continue;
            controllers.get(`${workflowId}/${sibling.id}`)?.abort();
            const dependsOnFailure = (sibling.dependsOn ?? []).includes(taskId);
            workflow = replaceTask(workflow, {
              ...sibling,
              status: sibling.status === "running"
                ? sibling.status
                : dependsOnFailure ? "skipped" : "cancelled",
              endedAt: sibling.status === "running" ? sibling.endedAt : now(),
              error: sibling.status === "running"
                ? sibling.error
                : dependsOnFailure
                  ? "Dependency did not complete successfully"
                  : "Cancelled after task failure",
            });
          }
        }
        await reconcile(workflow);
      });
    } finally {
      controllers.delete(key);
      active--;
      schedule();
    }
  };

  const pump = async () => {
    if (stopped) return;
    const workflows = await store.list();
    for (const workflow of workflows) {
      if (active >= maxConcurrency) break;
      if (terminalWorkflows.has(workflow.status) || workflow.status === "cancelling") continue;
      const running = Object.values(workflow.tasks).filter((task) => task.status === "running").length;
      let available = Math.min(workflow.maxConcurrency - running, maxConcurrency - active);
      if (available <= 0) continue;
      for (const task of Object.values(workflow.tasks)) {
        if (available <= 0 || active >= maxConcurrency) break;
        if (task.status !== "queued") continue;
        const wait = Math.max(0, lastStart + spacing - Date.now());
        if (wait > 0) {
          if (!wakeTimer) wakeTimer = setTimeout(() => { wakeTimer = undefined; void pump(); }, wait);
          return;
        }
        lastStart = Date.now();
        available--;
        void runTask(workflow.id, task.id);
      }
    }
  };

  const engine: WorkflowEngine = {
    list: () => store.list(),
    get: async (id) => requireWorkflow(id),
    async submit(definition) {
      const workflow = createWorkflow({ ...definition, id: definition.id ?? options.id?.() });
      await store.put(workflow);
      const created = await persist(workflow, "workflow.created", undefined, {
        taskCount: Object.keys(workflow.tasks).length,
      });
      schedule();
      return created;
    },
    async addTasks(workflowId, tasks) {
      return locked(workflowId, async () => {
        let workflow = await requireWorkflow(workflowId);
        if (terminalWorkflows.has(workflow.status))
          throw new Error(`Cannot add tasks to ${workflow.status} workflow`);
        workflow = appendTasks(workflow, tasks, now());
        workflow = await persist(workflow, "workflow.tasks-added", undefined, {
          taskIds: tasks.map((task) => task.id),
        });
        schedule();
        return tasks.map((task) => workflow.tasks[task.id]!);
      });
    },
    async cancel(workflowId) {
      return locked(workflowId, async () => {
        let workflow = await requireWorkflow(workflowId);
        if (terminalWorkflows.has(workflow.status)) return workflow;
        workflow = await persist({ ...workflow, status: "cancelling" }, "workflow.cancelling");
        for (const task of Object.values(workflow.tasks)) {
          controllers.get(`${workflowId}/${task.id}`)?.abort();
          if (task.status === "blocked" || task.status === "queued" || task.status === "retrying")
            workflow = replaceTask(workflow, { ...task, status: "cancelled", endedAt: now(), error: "Cancelled" });
        }
        if (!Object.values(workflow.tasks).some((task) => task.status === "running"))
          workflow = await persist({ ...workflow, status: "cancelled", endedAt: now() }, "workflow.cancelled");
        else await store.put(workflow);
        return workflow;
      });
    },
    async cancelTask(workflowId, taskId) {
      return locked(workflowId, async () => {
        let workflow = await requireWorkflow(workflowId);
        const task = workflow.tasks[taskId];
        if (!task) throw new TaskNotFound(workflowId, taskId);
        controllers.get(`${workflowId}/${taskId}`)?.abort();
        if (task.status !== "running" && !terminalTasks.has(task.status)) {
          const cancelled = { ...task, status: "cancelled" as const, endedAt: now(), error: "Cancelled" };
          workflow = replaceTask(workflow, cancelled);
          workflow = await persist(workflow, "task.cancelled", taskId);
          await reconcile(workflow);
          return cancelled;
        }
        return task;
      });
    },
    async retryTask(workflowId, taskId) {
      return locked(workflowId, async () => {
        let workflow = await requireWorkflow(workflowId);
        const task = workflow.tasks[taskId];
        if (!task) throw new TaskNotFound(workflowId, taskId);
        if (!terminalTasks.has(task.status)) throw new Error(`Task ${taskId} is not terminal`);
        const retry = { ...task, status: "queued" as const, endedAt: null, error: null, progress: null, progressLabel: null };
        workflow = replaceTask(workflow, retry);
        workflow = await persist({ ...workflow, status: "running", endedAt: null, error: null }, "task.queued", taskId, { manualRetry: true });
        schedule();
        return workflow.tasks[taskId]!;
      });
    },
    events: (query) => store.events(query),
    subscribe: (listener) => store.subscribe(listener),
    async shutdown() {
      stopped = true;
      if (wakeTimer) clearTimeout(wakeTimer);
      for (const controller of controllers.values()) controller.abort();
      while (active > 0) await new Promise((resolve) => setTimeout(resolve, 5));
      await store.flush();
    },
  };
  schedule();
  return engine;
};
