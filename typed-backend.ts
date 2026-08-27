import type {
  FileEntry,
  GitCommit,
  Project,
  Run,
} from "@kyoot/workbench-protocol";
import type { WorkbenchBackend } from "./orchestrator-kyoot/src/typed-api.ts";
export { makeTypedApi } from "./orchestrator-kyoot/src/typed-api.ts";
export { directory as workflowDirectory } from "./orchestrator-kyoot/src/workflow-store.ts";
export { makePiWorkflowEngine } from "./orchestrator-kyoot/src/pi-workflow.ts";
export { makeRunEngine } from "./orchestrator-kyoot/src/run-engine.ts";
export { piRunExecutor } from "./orchestrator-kyoot/src/pi-runs.ts";
export { directory as runDirectory } from "./orchestrator-kyoot/src/store.ts";
export const workflowBackend = (
  engine: any,
  validProject: (id: string) => boolean = () => true,
) => {
  const validate = (tasks: readonly any[]) => {
    for (const task of tasks)
      if (!validProject(String(task?.project || "")))
        throw new Error(`Unknown project ${task?.project || ""}`);
    return tasks;
  };
  return {
    list: () => engine.list(),
    get: (id: string) => engine.get(id),
    create: (input: any) =>
      engine.submit({ ...input, tasks: validate(input.tasks ?? []) }),
    addTasks: (workflowId: string, tasks: readonly unknown[]) =>
      engine.addTasks(workflowId, validate(tasks as readonly any[])),
    cancel: (id: string) => engine.cancel(id),
    cancelTask: (workflowId: string, taskId: string) =>
      engine.cancelTask(workflowId, taskId),
    retryTask: (workflowId: string, taskId: string) =>
      engine.retryTask(workflowId, taskId),
    events: (query?: unknown) => engine.events(query),
    subscribe: (listener: (event: unknown) => void) =>
      engine.subscribe(listener),
  };
};

export interface WorkbenchProject {
  readonly id: string;
  readonly name: string;
  readonly root: string;
}
export interface WorkbenchServices {
  readonly projects: ReadonlyMap<string, WorkbenchProject>;
  liveSession(input: {
    readonly messages: boolean;
    readonly trajectory: boolean;
  }): Promise<unknown>;
  liveSessionPage(input: {
    readonly cursor?: string | null;
    readonly limit?: number;
  }): Promise<any>;
  tree(
    root: string,
    relative?: string,
  ): Promise<{ readonly entries: readonly FileEntry[] }>;
  searchFiles(
    root: string,
    query: string,
  ): Promise<readonly { readonly path: string; readonly name: string }[]>;
  contentSearch?(
    input: Record<string, unknown>,
    options?: { readonly signal?: AbortSignal },
  ): Promise<any>;
  gitInfo(root: string, commit?: string): Promise<any>;
  readFile(project: WorkbenchProject, relative: string): Promise<any>;
  writeFile(
    project: WorkbenchProject,
    relative: string,
    body: unknown,
  ): Promise<any>;
}

const publicRun = (
  raw: any,
  projects: ReadonlyMap<string, WorkbenchProject>,
): Run => {
  const project = [...projects.values()].find(
    (candidate) => candidate.root === raw.cwd,
  );
  return {
    ...raw,
    project: project?.id ?? "",
    title: raw.title || raw.prompt?.split("\n")[0] || "Agent",
    createdAt: raw.createdAt || new Date().toISOString(),
    updatedAt:
      raw.endedAt || raw.startedAt || raw.createdAt || new Date().toISOString(),
  } as Run;
};
const requireProject = (
  projects: ReadonlyMap<string, WorkbenchProject>,
  id: string,
) => {
  const project = projects.get(id);
  if (!project)
    throw Object.assign(new Error("Unknown project"), { status: 404 });
  return project;
};

export const kyootBackend = (
  services: WorkbenchServices,
  runs: {
    list(): Promise<readonly any[]>;
    get(id: string): Promise<any>;
    create(input: any): Promise<any>;
    message(id: string, prompt: string, attribution?: any): Promise<any>;
    compact(id: string): Promise<any>;
    stop(id: string): Promise<any>;
  },
  invokePlatform?: (
    operation: string,
    input: Record<string, unknown>,
    options?: { readonly signal?: AbortSignal },
  ) => Promise<unknown> | unknown,
): WorkbenchBackend => ({
  listRuns: async () =>
    (await runs.list()).map((run) => publicRun(run, services.projects)),
  listProjects: async () =>
    [...services.projects.values()].map(({ id, name, root }): Project => ({
      id,
      name,
      root,
      writable: true,
    })),
  liveSession: (input) => services.liveSession(input),
  liveSessionPage: (input) => services.liveSessionPage(input),
  async getRun(id) {
    return publicRun(await runs.get(id), services.projects);
  },
  async createRun(input) {
    const project = requireProject(services.projects, input.project);
    return publicRun(
      await runs.create({ ...input, cwd: project.root }),
      services.projects,
    );
  },
  async messageRun(input) {
    return publicRun(
      await runs.message(input.id, input.message, {
        creator: input.creator ?? null,
        originChat: input.originChat ?? null,
      }),
      services.projects,
    );
  },
  async compactRun(id) {
    return publicRun(await runs.compact(id), services.projects);
  },
  async stopRun(id) {
    return publicRun(await runs.stop(id), services.projects);
  },
  async runEvents(id, after, limit) {
    return runs.events(id, after, limit);
  },
  async fileTree(project, path) {
    return (
      await services.tree(requireProject(services.projects, project).root, path)
    ).entries;
  },
  readFile: (project, path) =>
    services.readFile(requireProject(services.projects, project), path),
  async writeFile(input) {
    const result = await services.writeFile(
      requireProject(services.projects, input.project),
      input.path,
      {
        content: input.content,
        version: input.expectedRevision,
      },
    );
    return { path: result.path, revision: result.version };
  },
  searchFiles: (input) =>
    services
      .searchFiles(
        requireProject(services.projects, input.project).root,
        input.query,
      )
      .then((items) => items.slice(0, input.limit)),
  contentSearch: (input, options) => {
    requireProject(services.projects, input.project);
    if (!services.contentSearch)
      throw new Error("Project content search is unavailable");
    return services.contentSearch(input, options);
  },
  gitInfo: (project, commit) =>
    services.gitInfo(requireProject(services.projects, project).root, commit),
  async gitCommits(project, limit) {
    const info = await services.gitInfo(
      requireProject(services.projects, project).root,
    );
    return info.commits.slice(0, limit).map((commit: any): GitCommit => ({
      hash: commit.hash,
      shortHash: commit.hash,
      subject: commit.message,
      author: commit.author,
      authoredAt: commit.date,
    }));
  },
  async gitDiff(project, commit) {
    const info = await services.gitInfo(
      requireProject(services.projects, project).root,
      commit,
    );
    return { commit, diff: JSON.stringify(info.detail ?? {}, null, 2) };
  },
  invokePlatform,
});
