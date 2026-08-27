// frontend/files.ts
var editorModule = null;
var dynamicImport = (url) => import(url);
var filesEditorText = () => editorModule?.editorText() ?? "";
async function openFilesEditor(element, content, path, changed) {
  editorModule ??= await dynamicImport("/editor.js");
  await editorModule.openEditor(element, content, path, changed);
}
var ancestors = (path) => {
  const parts = path.split("/");
  return parts.slice(0, -1).map((_, index) => parts.slice(0, index + 1).join("/"));
};
function visibleTree(files, expanded, filter) {
  const query = filter.trim().toLowerCase();
  if (query) {
    const matches = new Set(
      files.filter((file) => file.path.toLowerCase().includes(query)).flatMap((file) => [file.path, ...ancestors(file.path)])
    );
    return files.filter((file) => matches.has(file.path));
  }
  return files.filter(
    (file) => ancestors(file.path).every((parent) => expanded.has(parent))
  );
}
var enc = encodeURIComponent;
var fileRoute = (project, path) => path ? `/files/${enc(project)}/${path.split("/").map(enc).join("/")}` : `/files/${enc(project)}`;
var FilesController = class {
  constructor(adapter, view) {
    this.adapter = adapter;
    this.view = view;
  }
  adapter;
  view;
  projects = [];
  project = "";
  files = [];
  expanded = /* @__PURE__ */ new Set();
  filter = "";
  openPath = null;
  openVersion = null;
  savedText = "";
  dirty = false;
  saving = false;
  treeRequest = 0;
  openRequest = 0;
  prefetchHandle = null;
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
  setFilter(filter) {
    this.filter = filter;
    this.renderTree();
  }
  toggle(path) {
    this.expanded.has(path) ? this.expanded.delete(path) : this.expanded.add(path);
    this.renderTree();
  }
  collapse() {
    this.expanded.clear();
    this.renderTree();
  }
  expandTo(path) {
    ancestors(path).forEach((entry) => this.expanded.add(entry));
    this.renderTree();
  }
  prefetch(path) {
    this.cancelPrefetch();
    const project = this.project;
    this.prefetchHandle = this.adapter.schedule(() => {
      void this.adapter.readFile(project, path).catch(() => {
      });
    }, 80);
  }
  cancelPrefetch() {
    if (this.prefetchHandle != null)
      this.adapter.cancelScheduled(this.prefetchHandle);
    this.prefetchHandle = null;
  }
  canDiscard() {
    return !this.dirty || this.adapter.confirmDiscard();
  }
  async switchProject(id) {
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
  async routeProject(id) {
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
    this.view.renderBreadcrumbs(this.project, null);
    this.setSaveState("", "");
    this.renderTree();
  }
  discardChanges() {
    this.dirty = false;
    this.setSaveState("", "");
  }
  async routeFile(path) {
    this.expandTo(path);
    return this.openFile(path, false, false);
  }
  async open(path) {
    this.expandTo(path);
    return this.openFile(path, true, true);
  }
  async openFile(path, push = true, askDiscard = true) {
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
        await this.adapter.openEditor(
          file.content,
          path,
          (text) => this.editorChanged(text)
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
  editorChanged(text) {
    this.dirty = text !== this.savedText;
    this.setSaveState(this.dirty ? "dirty" : "", this.dirty ? "UNSAVED" : "");
  }
  setSaveState(state, text) {
    this.view.setSaveState(state, text, this.dirty && !this.saving);
  }
  async save() {
    if (!this.openPath || !this.dirty || this.saving) return false;
    const project = this.project;
    const path = this.openPath;
    const version = this.openVersion;
    const submitted = this.adapter.editorText();
    this.saving = true;
    this.setSaveState("", "SAVING\u2026");
    let finalState = "";
    let finalText = "";
    try {
      await this.adapter.writeFile({
        project,
        path,
        content: submitted,
        expectedRevision: version
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
};
function createFilesDomView(options) {
  const $ = options.query;
  const $$ = options.queryAll;
  const esc = options.escape;
  let controller;
  const treeIcon = (node, expanded) => {
    if (node.type === "dir")
      return `<span class="treeicon folder ${expanded.has(node.path) ? "open" : ""}"></span>`;
    const ext = (node.name.split(".").pop() || "").toLowerCase();
    const kind = ["js", "mjs", "ts", "tsx", "jsx"].includes(ext) ? "script" : ["json", "yaml", "yml", "toml"].includes(ext) ? "data" : ["md", "txt"].includes(ext) ? "doc" : ["css", "scss", "html"].includes(ext) ? "style" : "file";
    const mark = kind === "script" ? "JS" : kind === "data" ? "{}" : kind === "doc" ? "\u2261" : kind === "style" ? "#" : "\xB7";
    return `<span class="treeicon ${kind}">${mark}</span>`;
  };
  const view = {
    renderProjects(projects, current) {
      const project = projects.find((entry) => entry.id === current);
      $("#projectName").textContent = project?.name || current;
      $("#projectToggle").title = project?.root || project?.name || current;
      $("#projectMenu").innerHTML = projects.map(
        (entry) => `<button type="button" role="option" aria-selected="${entry.id === current}" data-project="${esc(entry.id)}" tabindex="${entry.id === current ? "0" : "-1"}"><span class="projectcheck ${entry.id === current ? "checked" : ""}" aria-hidden="true"></span><span class="projectcopy"><b>${esc(entry.name)}</b><small>${esc(entry.root || entry.id)}</small></span></button>`
      ).join("");
      $$("#projectMenu button").forEach((button) => {
        button.onclick = () => void controller.switchProject(button.dataset.project);
      });
    },
    renderTree(nodes, expanded, filter) {
      const filtered = visibleTree(nodes, expanded, filter);
      const searching = Boolean(filter.trim());
      $("#tree").innerHTML = filtered.map((node) => {
        const open = node.type === "dir" && (searching || expanded.has(node.path));
        return `<button class="node ${node.type}" data-path="${esc(node.path)}" title="${esc(node.path)}" aria-expanded="${node.type === "dir" ? open : ""}" style="padding-left:${8 + (node.path.split("/").length - 1) * 14}px"><span class="disclosure">${node.type === "dir" ? open ? "\u2304" : "\u203A" : ""}</span>${treeIcon(node, expanded)}<span class="nodename">${esc(node.name)}</span></button>`;
      }).join("");
      $$(".node.dir").forEach((button) => {
        button.onclick = () => controller.toggle(button.dataset.path);
      });
      $$(".node.file,.node.link").forEach((button) => {
        button.onclick = () => void controller.openFile(button.dataset.path);
        button.onpointerenter = () => controller.prefetch(button.dataset.path);
        button.onpointerleave = () => controller.cancelPrefetch();
        button.onfocus = () => controller.prefetch(button.dataset.path);
      });
    },
    renderBreadcrumbs(project, path) {
      if (!path) {
        $("#filepath").innerHTML = `<span class="crumb root">${esc(project || "Project")}</span> <span class="crumbsep">\u203A</span> <span class="crumb empty">No file selected</span>`;
        return;
      }
      const parts = path.split("/");
      const crumbs = [
        `<span class="crumb root">${esc(project)}</span>`,
        ...parts.map(
          (part, index) => index === parts.length - 1 ? `<span class="crumb file"><b>${esc(part)}</b></span>` : `<span class="crumb dir">${esc(part)}</span>`
        )
      ];
      $("#filepath").innerHTML = crumbs.join(
        ' <span class="crumbsep">\u203A</span> '
      );
    },
    beginOpen(project, path) {
      const raw = options.rawUrl(project, path);
      $("#raw").href = raw;
      $("#raw").classList.remove("hidden");
      $("#media").innerHTML = "";
      $("#editor").classList.add("hidden");
    },
    showMedia(project, path, mime) {
      const raw = options.rawUrl(project, path);
      $("#media").innerHTML = mime.startsWith("image/") ? `<img src="${raw}" alt="${esc(path)}">` : `<iframe src="${raw}" style="width:100%;height:78vh"></iframe>`;
    },
    showEditor() {
      $("#editor").classList.remove("hidden");
    },
    showOpenError(message) {
      $("#media").innerHTML = `<pre>${esc(message)}</pre>`;
    },
    setSaveState(state, text, canSave) {
      $("#saveStatus").className = state;
      $("#saveStatus").textContent = text;
      $("#saveFile").disabled = !canSave;
      $("#saveFile").classList.toggle("hidden", !controller.openPath);
    },
    selectPath(path) {
      $$(".node").forEach(
        (node) => node.classList.toggle("selected", node.dataset.path === path)
      );
      const button = $(`.node[data-path="${CSS.escape(path)}"]`);
      button?.scrollIntoView({ block: "center" });
    },
    closeProjectMenu() {
      $("#projectMenu").classList.add("hidden");
      $("#projectToggle").setAttribute("aria-expanded", "false");
    }
  };
  return Object.assign(view, {
    attach(value) {
      controller = value;
      return view;
    }
  });
}
export {
  FilesController,
  ancestors,
  createFilesDomView,
  fileRoute,
  filesEditorText,
  openFilesEditor,
  visibleTree
};
