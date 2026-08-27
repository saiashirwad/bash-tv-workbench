export interface GitProject {
  id: string;
  name: string;
  root?: string;
}

export interface GitAdapter {
  query(selector: string): any;
  queryAll(selector: string): any[];
  projects(): GitProject[];
  load(
    project: string,
    commit: string | undefined,
    force: boolean,
  ): Promise<any>;
  setProject(project: string): void;
  navigate(url: string): void;
  escape(value: any): string;
  schedule(callback: () => void): void;
  errorMessage(error: unknown): string;
}

export interface GitView {
  render(data: any, selectedCommit: string | null): void;
  renderProject(project: string): void;
  setProjectMenu(open: boolean): void;
  showError(error: unknown): void;
}

export class GitController {
  project = "";
  selectedCommit: string | null = null;
  private request = 0;

  constructor(
    private adapter: GitAdapter,
    private view: GitView,
  ) {}

  routeFor() {
    const project = encodeURIComponent(this.project);
    return this.selectedCommit
      ? `/git/${project}/${encodeURIComponent(this.selectedCommit)}`
      : `/git/${project}`;
  }

  syncProject(project: string) {
    if (project !== this.project) this.selectedCommit = null;
    this.project = project;
    this.view.renderProject(project);
  }

  async route(project: string, commit: string | null = null) {
    this.syncProject(project);
    this.selectedCommit = commit;
    return this.load(false, commit);
  }

  async load(force = false, commit = this.selectedCommit) {
    if (!this.project) return null;
    const request = ++this.request;
    const project = this.project;
    try {
      const data = await this.adapter.load(project, commit || undefined, force);
      if (request !== this.request || project !== this.project) return null;
      this.view.render(data, this.selectedCommit);
      if (!data.detail && !this.selectedCommit && data.latest) {
        this.selectedCommit = data.latest.hash;
        this.adapter.schedule(() => void this.load(false, this.selectedCommit));
      }
      return data;
    } catch (error) {
      if (request === this.request && project === this.project)
        this.view.showError(error);
      return null;
    }
  }

  selectCommit(hash: string) {
    this.adapter.navigate(
      `/git/${encodeURIComponent(this.project)}/${encodeURIComponent(hash)}`,
    );
  }

  changeProject(project: string) {
    this.syncProject(project);
    this.selectedCommit = null;
    this.adapter.setProject(project);
    this.view.setProjectMenu(false);
    this.adapter.navigate(`/git/${encodeURIComponent(project)}`);
  }

  setProjectMenu(open: boolean) {
    this.view.setProjectMenu(open);
  }
}

export function createGitView(adapter: GitAdapter): GitView {
  const $ = adapter.query;
  const $$ = adapter.queryAll;
  const esc = adapter.escape;
  let controller: GitController;

  const renderProject = (projectId: string) => {
    const project = adapter.projects().find((item) => item.id === projectId);
    $("#gitProjectName").textContent = project?.name || projectId;
  };

  const renderCommitDetail = (commit: any) => {
    if (!commit) {
      $("#commitDetail").innerHTML =
        '<div class="gitempty">Select a commit</div>';
      return;
    }
    $("#commitDetail").innerHTML = `
    <div class="commitdetailhead"><code>${esc(commit.hash.slice(0, 12))}</code><b>${esc(commit.message.split("\n")[0])}</b></div>
    <dl><dt>Author</dt><dd>${esc(commit.author)}</dd><dt>Email</dt><dd>${esc(commit.email)}</dd><dt>Date</dt><dd>${esc(new Date(commit.date).toLocaleString())}</dd></dl>
    <h3>Message</h3><div class="commitmessage">${esc(commit.message)}</div>
    <h3>Files · ${commit.files.length}</h3>
    <div class="commitfiles">${commit.files.map((file: any) => `<div><code>${esc(file.status)}</code><span>${esc(file.path)}</span></div>`).join("") || '<div class="gitempty">No changed files</div>'}</div>
  `;
  };

  const view: GitView = {
    render(data, selectedCommit) {
      renderProject(controller.project);
      $("#branch").textContent = data.branch || "detached";
      $("#gitSync").textContent = data.upstream
        ? `${data.upstream} · ${data.ahead} ahead · ${data.behind} behind`
        : "No upstream";
      $("#status").textContent = data.status || "Clean working tree";
      $("#latestCommit").innerHTML = data.latest
        ? `<span>Latest</span><code>${esc(data.latest.hash)}</code><b>${esc(data.latest.message)}</b><small>${esc(data.latest.author)} · ${esc(new Date(data.latest.date).toLocaleString())}</small>`
        : '<span class="gitempty">No commits</span>';
      $("#commits").innerHTML = data.commits
        .map(
          (commit: any, index: number) => `
        <button class="commit ${selectedCommit === commit.hash ? "selected" : ""}" data-commit="${esc(commit.hash)}">
          <span class="commitgraph"><i></i></span><code>${esc(commit.hash)}</code>
          <span>${esc(new Date(commit.date).toLocaleDateString())}</span>
          <b>${esc(commit.message)}</b><small>${esc(commit.author)}</small>
          ${index === 0 ? "<em>HEAD</em>" : ""}
        </button>`,
        )
        .join("");
      $$(".commit").forEach((button) => {
        button.onclick = () => controller.selectCommit(button.dataset.commit);
      });
      if (data.detail) renderCommitDetail(data.detail);
      else if (!selectedCommit && !data.latest) renderCommitDetail(null);
    },
    renderProject,
    setProjectMenu(open) {
      $("#gitProjectMenu").classList.toggle("hidden", !open);
      if (!open) return;
      $("#gitProjectMenu").innerHTML = adapter
        .projects()
        .map(
          (project) =>
            `<button data-project="${esc(project.id)}" class="${project.id === controller.project ? "selected" : ""}"><b>${esc(project.name)}</b><small>${esc(project.root)}</small></button>`,
        )
        .join("");
      $$("#gitProjectMenu button").forEach((button) => {
        button.onclick = () => controller.changeProject(button.dataset.project);
      });
    },
    showError(error) {
      $("#commits").innerHTML = "";
      $("#latestCommit").innerHTML = '<span class="gitempty">No commits</span>';
      $("#status").textContent = adapter.errorMessage(error);
      renderCommitDetail(null);
    },
  };

  controller = new GitController(adapter, view);
  return Object.assign(view, { controller });
}

export function createGitController(adapter: GitAdapter) {
  const view = createGitView(adapter) as GitView & {
    controller: GitController;
  };
  return view.controller;
}
