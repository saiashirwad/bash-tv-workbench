// Kept behind the first text-file open so the editor bundle is absent from the
// initial Files/application download.
type EditorModule = typeof import("../editor-entry.ts");
let editorModule: EditorModule | null = null;
let editorModulePromise: Promise<EditorModule> | null = null;
const dynamicImport = (url: string): Promise<any> => import(url);
const loadEditorModule = () => {
  editorModulePromise ??= dynamicImport("/editor.js")
    .then((module) => (editorModule = module as EditorModule))
    .catch((error) => {
      editorModulePromise = null;
      throw error;
    });
  return editorModulePromise;
};
export const preloadFilesEditor = async () => {
  try {
    await loadEditorModule();
  } catch {
    // A later file open retries and reports a visible error if it also fails.
  }
};
export const filesEditorText = () => editorModule?.editorText() ?? "";
export async function openFilesEditor(
  element: HTMLElement,
  content: string,
  path: string,
  changed: (text: string) => void,
) {
  const module = await loadEditorModule();
  await module.openEditor(element, content, path, changed);
}

export interface FileProject {
  id: string;
  name: string;
  root?: string;
}

export interface FileNode {
  path: string;
  name: string;
  type: "dir" | "file" | "link";
}

export interface FileRead {
  content: string;
  mime: string;
  binary?: boolean;
  editable?: boolean;
  version?: string;
  revision?: string;
}

export interface FilesAdapter {
  projects(): FileProject[];
  loadTree(project: string, force: boolean): Promise<FileNode[]>;
  readFile(project: string, path: string, force?: boolean): Promise<FileRead>;
  writeFile(input: {
    project: string;
    path: string;
    content: string;
    expectedRevision: string | null;
  }): Promise<unknown>;
  editorText(): string;
  openEditor(
    content: string,
    path: string,
    changed: (text: string) => void,
  ): Promise<void>;
  confirmDiscard(): boolean;
  navigate(url: string, replace?: boolean): void;
  schedule(callback: () => void, delay: number): unknown;
  cancelScheduled(handle: unknown): void;
  errorMessage(error: unknown): string;
}

export interface FilesView {
  renderProjects(projects: FileProject[], current: string): void;
  renderTree(
    nodes: FileNode[],
    expanded: ReadonlySet<string>,
    filter: string,
  ): void;
  renderBreadcrumbs(project: string, path: string | null): void;
  beginOpen(project: string, path: string): void;
  showMedia(project: string, path: string, mime: string): void;
  showEditor(editable: boolean): void;
  showOpenError(message: string): void;
  setSaveState(
    state: "" | "dirty" | "saved" | "error",
    text: string,
    canSave: boolean,
  ): void;
  selectPath(path: string | null): void;
  closeProjectMenu(): void;
}

export const ancestors = (path: string) => {
  const parts = path.split("/");
  return parts
    .slice(0, -1)
    .map((_, index) => parts.slice(0, index + 1).join("/"));
};

export function visibleTree(
  files: FileNode[],
  expanded: ReadonlySet<string>,
  filter: string,
) {
  const query = filter.trim().toLowerCase();
  if (query) {
    const matches = new Set(
      files
        .filter((file) => file.path.toLowerCase().includes(query))
        .flatMap((file) => [file.path, ...ancestors(file.path)]),
    );
    return files.filter((file) => matches.has(file.path));
  }
  return files.filter((file) =>
    ancestors(file.path).every((parent) => expanded.has(parent)),
  );
}

const enc = encodeURIComponent;
export const fileRoute = (project: string, path?: string | null) =>
  path
    ? `/files/${enc(project)}/${path.split("/").map(enc).join("/")}`
    : `/files/${enc(project)}`;

export interface FilesQuickOpenController {
  readonly project: string;
  readonly dirty: boolean;
  open(path: string): Promise<boolean>;
  collapse(): void;
  route(): string;
}

export class FilesController implements FilesQuickOpenController {
  projects: FileProject[] = [];
  project = "";
  files: FileNode[] = [];
  expanded = new Set<string>();
  filter = "";
  openPath: string | null = null;
  openVersion: string | null = null;
  savedText = "";
  dirty = false;
  saving = false;
  private treeRequest = 0;
  private openRequest = 0;
  private prefetchHandle: unknown = null;

  constructor(
    private adapter: FilesAdapter,
    private view: FilesView,
  ) {}

  route() {
    return fileRoute(this.project, this.openPath);
  }

  syncProjects(projects = this.adapter.projects()) {
    this.projects = projects;
    if (!projects.some((entry) => entry.id === this.project))
      this.project = projects[0]?.id || "";
    this.view.renderProjects(projects, this.project);
  }

  async loadProjects() {
    this.syncProjects();
    if (this.project) await this.loadTree();
  }

  async loadTree(force = false) {
    if (!this.project) return null;
    const request = ++this.treeRequest;
    const project = this.project;
    const files = await this.adapter.loadTree(project, force);
    if (request !== this.treeRequest || project !== this.project) return null;
    this.files = files;
    this.renderTree();
    return files;
  }

  renderTree() {
    this.view.renderTree(this.files, this.expanded, this.filter);
  }

  setFilter(filter: string) {
    this.filter = filter;
    this.renderTree();
  }

  toggle(path: string) {
    this.expanded.has(path)
      ? this.expanded.delete(path)
      : this.expanded.add(path);
    this.renderTree();
  }

  collapse() {
    this.expanded.clear();
    this.renderTree();
  }

  expandTo(path: string) {
    ancestors(path).forEach((entry) => this.expanded.add(entry));
    this.renderTree();
  }

  prefetch(path: string) {
    this.cancelPrefetch();
    const project = this.project;
    this.prefetchHandle = this.adapter.schedule(() => {
      void this.adapter.readFile(project, path).catch(() => {});
    }, 80);
  }

  cancelPrefetch() {
    if (this.prefetchHandle != null)
      this.adapter.cancelScheduled(this.prefetchHandle);
    this.prefetchHandle = null;
  }

  private canDiscard() {
    return !this.dirty || this.adapter.confirmDiscard();
  }

  async switchProject(id: string) {
    this.view.closeProjectMenu();
    if (id === this.project) return true;
    if (!this.canDiscard()) return false;
    this.project = id;
    this.openRequest++;
    this.openPath = null;
    this.openVersion = null;
    this.savedText = "";
    this.dirty = false;
    this.expanded.clear();
    this.view.renderProjects(this.projects, this.project);
    this.view.renderBreadcrumbs(this.project, null);
    this.setSaveState("", "");
    await this.loadTree();
    this.adapter.navigate(fileRoute(this.project));
    return true;
  }

  async routeProject(id: string) {
    if (!this.projects.some((project) => project.id === id)) {
      this.adapter.navigate(fileRoute(this.project), true);
      return false;
    }
    if (id !== this.project) {
      this.project = id;
      this.openRequest++;
      this.openPath = null;
      this.openVersion = null;
      this.savedText = "";
      this.dirty = false;
      this.expanded.clear();
      this.view.renderProjects(this.projects, id);
      await this.loadTree();
    }
    return true;
  }

  routeRoot() {
    this.openRequest++;
    this.openPath = null;
    this.openVersion = null;
    this.savedText = "";
    this.dirty = false;
    this.view.selectPath(null);
    this.view.renderBreadcrumbs(this.project, null);
    this.setSaveState("", "");
    this.renderTree();
  }

  discardChanges() {
    this.dirty = false;
    this.setSaveState("", "");
  }

  async routeFile(path: string) {
    this.expandTo(path);
    return this.openFile(path, false, false);
  }

  async open(path: string) {
    this.expandTo(path);
    return this.openFile(path, true, true);
  }

  async openFile(path: string, push = true, askDiscard = true) {
    if (askDiscard && !this.canDiscard()) return false;
    const request = ++this.openRequest;
    const project = this.project;
    this.view.selectPath(path);
    this.view.renderBreadcrumbs(project, path);
    this.view.beginOpen(project, path);
    this.openPath = null;
    this.openVersion = null;
    this.savedText = "";
    this.dirty = false;
    this.setSaveState("", "");
    try {
      const file = await this.adapter.readFile(project, path);
      if (request !== this.openRequest || project !== this.project)
        return false;
      if (file.binary || /^(image|application\/pdf)/.test(file.mime)) {
        this.view.showMedia(project, path, file.mime);
      } else {
        await this.adapter.openEditor(file.content, path, (text) =>
          this.editorChanged(text),
        );
        if (request !== this.openRequest || project !== this.project)
          return false;
        this.openPath = file.editable ? path : null;
        this.openVersion = file.version || file.revision || null;
        this.savedText = file.content;
        this.view.showEditor(Boolean(file.editable));
        this.setSaveState("", file.editable ? "" : "READ ONLY");
      }
      if (push) this.adapter.navigate(fileRoute(project, path));
      return true;
    } catch (error) {
      if (request === this.openRequest && project === this.project)
        this.view.showOpenError(this.adapter.errorMessage(error));
      return false;
    }
  }

  editorChanged(text: string) {
    this.dirty = text !== this.savedText;
    this.setSaveState(this.dirty ? "dirty" : "", this.dirty ? "UNSAVED" : "");
  }

  private setSaveState(state: "" | "dirty" | "saved" | "error", text: string) {
    this.view.setSaveState(state, text, this.dirty && !this.saving);
  }

  async save() {
    if (!this.openPath || !this.dirty || this.saving) return false;
    const project = this.project;
    const path = this.openPath;
    const version = this.openVersion;
    const submitted = this.adapter.editorText();
    this.saving = true;
    this.setSaveState("", "SAVING…");
    let finalState: "" | "dirty" | "saved" | "error" = "";
    let finalText = "";
    try {
      await this.adapter.writeFile({
        project,
        path,
        content: submitted,
        expectedRevision: version,
      });
      const fresh = await this.adapter.readFile(project, path, true);
      if (project !== this.project || path !== this.openPath) return false;
      this.openVersion = fresh.version || fresh.revision || version;
      this.savedText = submitted;
      this.dirty = this.adapter.editorText() !== submitted;
      finalState = this.dirty ? "dirty" : "saved";
      finalText = this.dirty ? "UNSAVED" : "SAVED";
      return true;
    } catch (error) {
      // WorkbenchStore rolls its optimistic cache write back. Keep the editor and
      // expected revision intact so a conflict is visible and retryable.
      if (project === this.project && path === this.openPath) {
        this.dirty = this.adapter.editorText() !== this.savedText;
        finalState = "error";
        finalText = this.adapter.errorMessage(error);
      }
      return false;
    } finally {
      this.saving = false;
      this.setSaveState(finalState, finalText);
    }
  }
}

export function createFilesDomView(options: {
  query(selector: string): any;
  queryAll(selector: string): any[];
  escape(value: any): string;
  rawUrl(project: string, path: string): string;
}): FilesView {
  const $ = options.query;
  const $$ = options.queryAll;
  const esc = options.escape;
  let controller: FilesController;
  let selectedPath: string | null = null;

  const treeIcon = (node: FileNode, expanded: ReadonlySet<string>) => {
    if (node.type === "dir")
      return `<span class="treeicon folder ${expanded.has(node.path) ? "open" : ""}"></span>`;
    const ext = (node.name.split(".").pop() || "").toLowerCase();
    const kind = ["js", "mjs", "ts", "tsx", "jsx"].includes(ext)
      ? "script"
      : ["json", "yaml", "yml", "toml"].includes(ext)
        ? "data"
        : ["md", "txt"].includes(ext)
          ? "doc"
          : ["css", "scss", "html"].includes(ext)
            ? "style"
            : "file";
    const mark =
      kind === "script"
        ? "JS"
        : kind === "data"
          ? "{}"
          : kind === "doc"
            ? "≡"
            : kind === "style"
              ? "#"
              : "·";
    return `<span class="treeicon ${kind}">${mark}</span>`;
  };

  const view: FilesView = {
    renderProjects(projects, current) {
      const project = projects.find((entry) => entry.id === current);
      $("#projectName").textContent = project?.name || current;
      $("#projectToggle").title = project?.root || project?.name || current;
      $("#projectMenu").innerHTML = projects
        .map(
          (entry) =>
            `<button type="button" role="option" aria-selected="${entry.id === current}" data-project="${esc(entry.id)}" tabindex="${entry.id === current ? "0" : "-1"}"><span class="projectcheck ${entry.id === current ? "checked" : ""}" aria-hidden="true"></span><span class="projectcopy"><b>${esc(entry.name)}</b><small>${esc(entry.root || entry.id)}</small></span></button>`,
        )
        .join("");
      $$("#projectMenu button").forEach((button) => {
        button.onclick = () =>
          void controller.switchProject(button.dataset.project);
      });
    },
    renderTree(nodes, expanded, filter) {
      const filtered = visibleTree(nodes, expanded, filter);
      const searching = Boolean(filter.trim());
      $("#tree").innerHTML = filtered
        .map((node) => {
          const open =
            node.type === "dir" && (searching || expanded.has(node.path));
          return `<button class="node ${node.type}" data-path="${esc(node.path)}" title="${esc(node.path)}" aria-expanded="${node.type === "dir" ? open : ""}" style="padding-left:${8 + (node.path.split("/").length - 1) * 14}px"><span class="disclosure">${node.type === "dir" ? (open ? "⌄" : "›") : ""}</span>${treeIcon(node, expanded)}<span class="nodename">${esc(node.name)}</span></button>`;
        })
        .join("");
      $$(".node.dir").forEach((button) => {
        button.onclick = () => controller.toggle(button.dataset.path);
      });
      $$(".node.file,.node.link").forEach((button) => {
        button.onclick = () => void controller.openFile(button.dataset.path);
        button.onpointerenter = () => controller.prefetch(button.dataset.path);
        button.onpointerleave = () => controller.cancelPrefetch();
        button.onfocus = () => controller.prefetch(button.dataset.path);
      });
      if (selectedPath)
        $(`.node[data-path="${CSS.escape(selectedPath)}"]`)?.classList.add(
          "selected",
        );
    },
    renderBreadcrumbs(project, path) {
      if (!path) {
        $("#filepath").innerHTML =
          `<span class="crumb root">${esc(project || "Project")}</span> <span class="crumbsep">›</span> <span class="crumb empty">No file selected</span>`;
        return;
      }
      const parts = path.split("/");
      const crumbs = [
        `<span class="crumb root">${esc(project)}</span>`,
        ...parts.map((part, index) =>
          index === parts.length - 1
            ? `<span class="crumb file"><b>${esc(part)}</b></span>`
            : `<span class="crumb dir">${esc(part)}</span>`,
        ),
      ];
      $("#filepath").innerHTML = crumbs.join(
        ' <span class="crumbsep">›</span> ',
      );
    },
    beginOpen(project, path) {
      const raw = options.rawUrl(project, path);
      $("#raw").href = raw;
      $("#raw").classList.remove("hidden");
    },
    showMedia(project, path, mime) {
      const raw = options.rawUrl(project, path);
      $("#editor").classList.add("hidden");
      $("#media").innerHTML = mime.startsWith("image/")
        ? `<img src="${raw}" alt="${esc(path)}">`
        : `<iframe src="${raw}" style="width:100%;height:78vh"></iframe>`;
    },
    showEditor() {
      $("#media").innerHTML = "";
      $("#editor").classList.remove("hidden");
    },
    showOpenError(message) {
      $("#editor").classList.add("hidden");
      $("#media").innerHTML = `<pre>${esc(message)}</pre>`;
    },
    setSaveState(state, text, canSave) {
      $("#saveStatus").className = state;
      $("#saveStatus").textContent = text;
      $("#saveFile").disabled = !canSave;
      $("#saveFile").classList.toggle("hidden", !controller.openPath);
    },
    selectPath(path) {
      if (selectedPath)
        $(`.node[data-path="${CSS.escape(selectedPath)}"]`)?.classList.remove(
          "selected",
        );
      selectedPath = path;
      if (!path) return;
      const button = $(`.node[data-path="${CSS.escape(path)}"]`);
      button?.classList.add("selected");
      button?.scrollIntoView({ block: "nearest" });
    },
    closeProjectMenu() {
      $("#projectMenu").classList.add("hidden");
      $("#projectToggle").setAttribute("aria-expanded", "false");
    },
  };
  return Object.assign(view, {
    attach(value: FilesController) {
      controller = value;
      return view;
    },
  });
}
