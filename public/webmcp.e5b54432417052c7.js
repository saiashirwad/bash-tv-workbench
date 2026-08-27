// frontend/operation-catalog.ts
import {
  PLATFORM_OPERATION_CATALOG,
  assertPlatformInput
} from "../workbench-operation-catalog.mjs";

// frontend/webmcp.ts
var objectSchema = (properties, required = []) => ({
  type: "object",
  properties,
  ...required.length ? { required } : {},
  additionalProperties: false
});
var text = (description) => ({ type: "string", description });
var boolean = (description) => ({ type: "boolean", description });
var integer = (description, minimum = 1, maximum = 500) => ({
  type: "integer",
  description,
  minimum,
  maximum
});
var enumString = (description, values) => ({
  type: "string",
  description,
  enum: values
});
var limit = (value, fallback, maximum) => Math.max(1, Math.min(maximum, Number(value) || fallback));
var errorText = (error) => error instanceof Error ? error.message : String(error);
var abortable = async (signal, work) => {
  if (signal?.aborted)
    throw signal.reason ?? new DOMException("Aborted", "AbortError");
  if (!signal) return work();
  return Promise.race([
    work(),
    new Promise(
      (_, reject) => signal.addEventListener(
        "abort",
        () => reject(signal.reason ?? new DOMException("Aborted", "AbortError")),
        { once: true }
      )
    )
  ]);
};
var webMcpCreator = Object.freeze({
  id: "webmcp",
  username: "WebMCP",
  pfp: null
});
var webMcpAttribution = { creator: webMcpCreator };
var runSummary = (run) => ({
  id: run.id,
  project: run.project,
  title: run.title,
  status: run.status,
  createdAt: run.createdAt,
  updatedAt: run.updatedAt,
  startedAt: run.startedAt,
  endedAt: run.endedAt,
  turnCount: run.turnCount ?? 1,
  toolCount: run.toolCount ?? 0,
  tokens: run.usage?.totalTokens,
  changedFiles: (run.changes ?? []).length,
  error: run.error ?? null
});
var workflowSummary = (workflow) => ({
  id: workflow.id,
  title: workflow.title,
  status: workflow.status,
  revision: workflow.revision,
  createdAt: workflow.createdAt,
  startedAt: workflow.startedAt,
  endedAt: workflow.endedAt,
  counts: workflow.counts,
  error: workflow.error ?? null
});
var requireProject = (store, project) => {
  const found = store.projects.get(project);
  if (!found) throw new Error(`Unknown project: ${project}`);
  return found;
};
var requireRun = (store, id) => {
  const found = store.runs.get(id);
  if (!found) throw new Error(`Unknown run: ${id}`);
  return found;
};
async function registerWorkbenchWebMcp(store, actions) {
  const context = document.modelContext;
  if (!context?.registerTool)
    return { supported: false, registered: 0, names: [] };
  const registration = new AbortController();
  addEventListener("pagehide", () => registration.abort(), { once: true });
  const readOnly = {
    readOnlyHint: true,
    openWorldHint: false
  };
  const mutation = {
    readOnlyHint: false,
    openWorldHint: false
  };
  const tools = [
    {
      name: "workbench_list_projects",
      title: "List Workbench projects",
      description: "List project IDs accepted by other Bash Workbench tools.",
      inputSchema: objectSchema({}),
      annotations: readOnly,
      execute: () => store.projects.all()
    },
    {
      name: "workbench_list_runs",
      title: "List agent runs",
      description: "List concise coding-agent run summaries. Use workbench_get_run for transcript details.",
      inputSchema: objectSchema({
        project: text("Optional project ID filter"),
        status: enumString("Optional run status filter", [
          "queued",
          "starting",
          "running",
          "compacting",
          "stopping",
          "completed",
          "failed",
          "stopped",
          "cancelled",
          "interrupted"
        ]),
        limit: integer("Maximum number of newest runs", 1, 100)
      }),
      annotations: readOnly,
      execute: ({ project, status, limit: requested }) => store.runs.all().filter(
        (run) => (!project || run.project === project) && (!status || run.status === status)
      ).sort(
        (a, b) => String(b.createdAt).localeCompare(String(a.createdAt))
      ).slice(0, limit(requested, 25, 100)).map(runSummary)
    },
    {
      name: "workbench_get_run",
      title: "Get an agent run",
      description: "Get one coding-agent run. Set includeEvents false for a compact record.",
      inputSchema: objectSchema(
        {
          id: text("Run ID"),
          includeEvents: boolean(
            "Include the bounded transcript event history"
          )
        },
        ["id"]
      ),
      annotations: readOnly,
      execute: ({ id, includeEvents = true }) => {
        const run = requireRun(store, id);
        return includeEvents ? run : { ...run, events: void 0 };
      }
    },
    {
      name: "workbench_create_run",
      title: "Create an agent run",
      description: "Start a coding-agent run and return its authoritative/optimistic Workbench record.",
      inputSchema: objectSchema(
        {
          project: text("Project ID; defaults to the active project"),
          prompt: text("Task for the coding agent"),
          title: text("Optional short title")
        },
        ["prompt"]
      ),
      annotations: mutation,
      execute: ({ project, prompt, title }) => {
        const target = project || actions.currentProject();
        requireProject(store, target);
        return store.createRun({
          project: target,
          prompt,
          title,
          ...webMcpAttribution
        });
      }
    },
    {
      name: "workbench_message_run",
      title: "Message an agent run",
      description: "Send a follow-up instruction to an existing coding-agent run.",
      inputSchema: objectSchema(
        { id: text("Run ID"), message: text("Follow-up instruction") },
        ["id", "message"]
      ),
      annotations: mutation,
      execute: ({ id, message }) => {
        requireRun(store, id);
        return store.messageRun(id, message);
      }
    },
    {
      name: "workbench_stop_run",
      title: "Stop an agent run",
      description: "Cancel or stop a queued or active coding-agent run.",
      inputSchema: objectSchema({ id: text("Run ID") }, ["id"]),
      annotations: { ...mutation, destructiveHint: true },
      execute: ({ id }) => {
        requireRun(store, id);
        return store.stopRun(id);
      }
    },
    {
      name: "workbench_compact_run",
      title: "Compact an agent run",
      description: "Compact an agent run's context so it can continue with a smaller context window.",
      inputSchema: objectSchema({ id: text("Run ID") }, ["id"]),
      annotations: mutation,
      execute: ({ id }) => {
        requireRun(store, id);
        return store.compactRun(id);
      }
    },
    {
      name: "workbench_list_files",
      title: "List project files",
      description: "List a bounded section of the project file tree. Use prefix to scope large repositories.",
      inputSchema: objectSchema(
        {
          project: text("Project ID"),
          prefix: text("Optional project-relative path prefix"),
          limit: integer("Maximum entries", 1, 500)
        },
        ["project"]
      ),
      annotations: readOnly,
      execute: async ({ project, prefix = "", limit: requested }, { signal } = {}) => {
        requireProject(store, project);
        const files = await abortable(
          signal,
          () => store.fileTree(project).load()
        );
        const matching = prefix ? files.filter((file) => file.path.startsWith(prefix)) : files;
        return {
          entries: matching.slice(0, limit(requested, 200, 500)),
          total: matching.length,
          truncated: matching.length > limit(requested, 200, 500)
        };
      }
    },
    {
      name: "workbench_search_files",
      title: "Search project filenames",
      description: "Fuzzy-search project filenames for quick-open. This does not search file contents.",
      inputSchema: objectSchema(
        {
          project: text("Project ID"),
          query: text("Search query"),
          limit: integer("Maximum result count", 1, 100)
        },
        ["project", "query"]
      ),
      annotations: readOnly,
      execute: ({ project, query, limit: requested }, { signal } = {}) => {
        requireProject(store, project);
        return abortable(
          signal,
          () => store.searchFiles(project, query, limit(requested, 30, 100)).load()
        );
      }
    },
    {
      name: "workbench_read_file",
      title: "Read a project file",
      description: "Read a text file with its revision and metadata. Binary files return metadata without inline bytes.",
      inputSchema: objectSchema(
        {
          project: text("Project ID"),
          path: text("Project-relative file path")
        },
        ["project", "path"]
      ),
      annotations: readOnly,
      execute: ({ project, path }, { signal } = {}) => {
        requireProject(store, project);
        return abortable(signal, () => store.readFile(project, path).load());
      }
    },
    {
      name: "workbench_write_file",
      title: "Write a project file",
      description: "Write complete text content using revision-safe optimistic Workbench mutation handling.",
      inputSchema: objectSchema(
        {
          project: text("Project ID"),
          path: text("Project-relative file path"),
          content: text("Complete new text content"),
          expectedRevision: text(
            "Optional expected revision for conflict detection"
          )
        },
        ["project", "path", "content"]
      ),
      annotations: { ...mutation, destructiveHint: true },
      execute: async (input) => {
        requireProject(store, input.project);
        await store.writeFile(input);
        return { ok: true, project: input.project, path: input.path };
      }
    },
    {
      name: "workbench_git_info",
      title: "Inspect project Git state",
      description: "Get branch, working-tree status, recent commits, and optional commit detail.",
      inputSchema: objectSchema(
        { project: text("Project ID"), commit: text("Optional commit hash") },
        ["project"]
      ),
      annotations: readOnly,
      execute: ({ project, commit }, { signal } = {}) => {
        requireProject(store, project);
        return abortable(signal, () => store.gitInfo(project, commit).load());
      }
    },
    {
      name: "workbench_spawn_agent",
      title: "Spawn coding agent",
      description: "Spawn a durable coding agent in a registered project. Alias of workbench_create_run with explicit agent terminology.",
      inputSchema: objectSchema(
        {
          project: text("Project ID; defaults to active project"),
          prompt: text("Coding task"),
          title: text("Optional agent title")
        },
        ["prompt"]
      ),
      annotations: mutation,
      execute: ({ project, prompt, title }) => {
        const target = project || actions.currentProject();
        requireProject(store, target);
        return store.createRun({
          project: target,
          prompt,
          title,
          ...webMcpAttribution
        });
      }
    },
    {
      name: "workbench_list_workflows",
      title: "List workflows",
      description: "List concise durable multi-agent workflow summaries.",
      inputSchema: objectSchema({
        limit: integer("Maximum number of newest workflows", 1, 100)
      }),
      annotations: readOnly,
      execute: ({ limit: requested }) => store.workflows.all().sort(
        (a, b) => String(b.createdAt).localeCompare(String(a.createdAt))
      ).slice(0, limit(requested, 25, 100)).map(workflowSummary)
    },
    ...workflowTools(store, readOnly, mutation),
    ...platformTools(store, readOnly, mutation),
    {
      name: "workbench_navigate",
      title: "Navigate Workbench",
      description: "Navigate the visible UI to a Workbench route beginning with /.",
      inputSchema: objectSchema(
        { path: text("Workbench route beginning with /") },
        ["path"]
      ),
      annotations: { ...mutation, idempotentHint: true },
      execute: ({ path }) => {
        if (typeof path !== "string" || !path.startsWith("/"))
          throw new Error("path must begin with /");
        actions.navigate(path);
        return { ok: true, path };
      }
    }
  ];
  try {
    for (const tool of tools)
      await context.registerTool(tool, { signal: registration.signal });
    return {
      supported: true,
      registered: tools.length,
      names: tools.map((tool) => tool.name)
    };
  } catch (error) {
    registration.abort();
    return {
      supported: true,
      registered: 0,
      names: [],
      error: errorText(error)
    };
  }
}
function workflowTools(store, readOnly, mutation) {
  const task = {
    type: "object",
    properties: {
      id: text("Unique task ID within the workflow"),
      title: text("Optional task title"),
      prompt: text("Task for the coding agent"),
      project: text("Registered project ID"),
      dependsOn: {
        type: "array",
        items: { type: "string" },
        description: "Task IDs that must finish first"
      },
      retries: { type: "integer", minimum: 0, maximum: 10 },
      timeoutMs: { type: "integer", minimum: 1e3, maximum: 36e5 },
      continueOnError: boolean("Allow dependents after failure")
    },
    required: ["id", "prompt", "project"],
    additionalProperties: false
  };
  return [
    {
      name: "workbench_get_workflow",
      title: "Get workflow",
      description: "Get a durable workflow including every task and current status.",
      inputSchema: objectSchema({ id: text("Workflow ID") }, ["id"]),
      annotations: readOnly,
      execute: ({ id }) => {
        const workflow = store.workflows.get(id);
        if (!workflow) throw new Error(`Unknown workflow: ${id}`);
        return workflow;
      }
    },
    {
      name: "workbench_spawn_workflow",
      title: "Spawn agent workflow",
      description: "Spawn a durable multi-agent DAG. Independent tasks fan out; dependsOn edges create joins.",
      inputSchema: objectSchema(
        {
          title: text("Workflow title"),
          tasks: { type: "array", minItems: 1, items: task },
          maxConcurrency: integer("Maximum active workflow agents", 1, 10),
          failurePolicy: enumString("Failure policy", [
            "fail-fast",
            "continue"
          ])
        },
        ["title", "tasks"]
      ),
      annotations: mutation,
      execute: (input) => {
        for (const item of input.tasks) requireProject(store, item.project);
        return store.createWorkflow(input);
      }
    },
    {
      name: "workbench_add_workflow_tasks",
      title: "Add workflow tasks",
      description: "Dynamically append tasks to a running workflow.",
      inputSchema: objectSchema(
        {
          workflowId: text("Workflow ID"),
          tasks: { type: "array", minItems: 1, items: task }
        },
        ["workflowId", "tasks"]
      ),
      annotations: mutation,
      execute: ({ workflowId, tasks }) => {
        if (!store.workflows.get(workflowId))
          throw new Error(`Unknown workflow: ${workflowId}`);
        for (const item of tasks) requireProject(store, item.project);
        return store.addWorkflowTasks(workflowId, tasks);
      }
    },
    {
      name: "workbench_cancel_workflow",
      title: "Cancel workflow",
      description: "Cancel a durable workflow and its active/queued tasks.",
      inputSchema: objectSchema({ id: text("Workflow ID") }, ["id"]),
      annotations: { ...mutation, destructiveHint: true },
      execute: ({ id }) => {
        if (!store.workflows.get(id))
          throw new Error(`Unknown workflow: ${id}`);
        return store.cancelWorkflow(id);
      }
    },
    {
      name: "workbench_cancel_workflow_task",
      title: "Cancel workflow task",
      description: "Cancel one task in a workflow.",
      inputSchema: objectSchema(
        { workflowId: text("Workflow ID"), taskId: text("Task ID") },
        ["workflowId", "taskId"]
      ),
      annotations: { ...mutation, destructiveHint: true },
      execute: ({ workflowId, taskId }) => store.cancelWorkflowTask(workflowId, taskId)
    },
    {
      name: "workbench_retry_workflow_task",
      title: "Retry workflow task",
      description: "Retry a failed, cancelled, or interrupted workflow task.",
      inputSchema: objectSchema(
        { workflowId: text("Workflow ID"), taskId: text("Task ID") },
        ["workflowId", "taskId"]
      ),
      annotations: mutation,
      execute: ({ workflowId, taskId }) => store.retryWorkflowTask(workflowId, taskId)
    },
    {
      name: "workbench_workflow_events",
      title: "Read workflow events",
      description: "Read cursor-based collective or per-task workflow progress events.",
      inputSchema: objectSchema({
        after: { type: "integer", minimum: 0 },
        workflowId: text("Optional workflow ID"),
        taskId: text("Optional task ID"),
        limit: integer("Maximum events", 1, 5e3)
      }),
      annotations: readOnly,
      execute: (input) => store.workflowEvents(input)
    }
  ];
}
function platformTools(store, _readOnly, _mutation) {
  return PLATFORM_OPERATION_CATALOG.map((definition) => ({
    name: definition.name,
    title: definition.title,
    description: definition.description,
    inputSchema: definition.inputSchema,
    annotations: {
      readOnlyHint: definition.annotations.readOnly,
      openWorldHint: false,
      ...definition.annotations.confirmation ? { destructiveHint: true } : {}
    },
    execute: async (input) => {
      assertPlatformInput(definition.name, input);
      if (input.project) requireProject(store, input.project);
      return store.invokePlatform(definition.name, input);
    }
  }));
}
export {
  registerWorkbenchWebMcp
};
