import assert from "node:assert/strict";
import test from "node:test";
import {
  FilesController,
  ancestors,
  createFilesDomView,
  fileRoute,
  visibleTree,
} from "../public/files.js";

const nodes = [
  { type: "dir", name: "src", path: "src" },
  { type: "dir", name: "deep", path: "src/deep" },
  { type: "file", name: "app.ts", path: "src/deep/app.ts" },
  { type: "file", name: "README.md", path: "README.md" },
];

function deferred() {
  let resolve;
  let reject;
  const promise = new Promise((ok, fail) => {
    resolve = ok;
    reject = fail;
  });
  return { promise, resolve, reject };
}

function harness(overrides = {}) {
  const renders = [];
  const states = [];
  const calls = [];
  let text = "original";
  const adapter = {
    projects: () => [
      { id: "one", name: "One" },
      { id: "two space", name: "Two" },
    ],
    loadTree: async () => nodes,
    readFile: async (_project, _path) => ({
      content: "original",
      mime: "text/plain",
      editable: true,
      version: "v1",
    }),
    fileRevision: async () => ({ revision: "v1" }),
    writeFile: async (input) => calls.push(["write", input]),
    editorText: () => text,
    openEditor: async () => {},
    replaceEditor: (content) => {
      text = content;
      calls.push(["replace", content]);
    },
    isConflict: (error) => error.message === "revision conflict",
    confirmDiscard: () => true,
    navigate: (url, replace) => calls.push(["navigate", url, replace]),
    schedule: (callback) => setTimeout(callback, 0),
    cancelScheduled: clearTimeout,
    errorMessage: (error) => error.message,
    ...overrides,
  };
  const view = {
    renderProjects: (_projects, project) => calls.push(["projects", project]),
    renderTree: (files, expanded, filter) =>
      renders.push(
        visibleTree(files, expanded, filter).map((file) => file.path),
      ),
    renderBreadcrumbs: () => {},
    beginOpen: () => {},
    showMedia: () => {},
    showEditor: () => {},
    showOpenError: (message) => calls.push(["error", message]),
    setSaveState: (state, message, canSave) =>
      states.push([state, message, canSave]),
    setConflict: (visible) => calls.push(["conflict", visible]),
    showComparison: (draft, disk) => calls.push(["compare", draft, disk]),
    selectPath: () => {},
    closeProjectMenu: () => calls.push(["menu", false]),
  };
  const controller = new FilesController(adapter, view);
  return {
    controller,
    calls,
    renders,
    states,
    setText(value) {
      text = value;
    },
  };
}

test("tree filtering includes ancestors and expand-collapse controls visibility", () => {
  assert.deepEqual(ancestors("src/deep/app.ts"), ["src", "src/deep"]);
  assert.deepEqual(visibleTree(nodes, new Set(), "app"), nodes.slice(0, 3));
  assert.deepEqual(visibleTree(nodes, new Set(), ""), [nodes[0], nodes[3]]);
  assert.deepEqual(visibleTree(nodes, new Set(["src", "src/deep"]), ""), nodes);

  const h = harness();
  h.controller.files = nodes;
  h.controller.toggle("src");
  assert.deepEqual(h.renders.at(-1), ["src", "src/deep", "README.md"]);
  h.controller.collapse();
  assert.deepEqual(h.renders.at(-1), ["src", "README.md"]);
});

test("stale tree and file loads cannot replace the active project or file", async () => {
  const firstTree = deferred();
  const secondTree = deferred();
  const firstFile = deferred();
  const secondFile = deferred();
  const h = harness({
    loadTree: (project) =>
      project === "one" ? firstTree.promise : secondTree.promise,
    readFile: (_project, path) =>
      path === "old.ts" ? firstFile.promise : secondFile.promise,
  });
  h.controller.syncProjects();
  h.controller.project = "one";
  const oldTree = h.controller.loadTree();
  h.controller.project = "two space";
  const newTree = h.controller.loadTree();
  secondTree.resolve([nodes[3]]);
  await newTree;
  firstTree.resolve([nodes[0]]);
  await oldTree;
  assert.deepEqual(h.controller.files, [nodes[3]]);

  const oldOpen = h.controller.openFile("old.ts", false, false);
  const newOpen = h.controller.openFile("new.ts", false, false);
  secondFile.resolve({ content: "new", mime: "text/plain", editable: true });
  assert.equal(await newOpen, true);
  firstFile.resolve({ content: "old", mime: "text/plain", editable: true });
  assert.equal(await oldOpen, false);
});

test("starting a file switch keeps the current preview visible", () => {
  const classes = () => {
    const values = new Set();
    return {
      values,
      add: (...names) => names.forEach((name) => values.add(name)),
      remove: (...names) => names.forEach((name) => values.delete(name)),
      toggle: (name, force) =>
        force === false ? values.delete(name) : values.add(name),
    };
  };
  const elements = {
    "#raw": { href: "", classList: classes() },
    "#media": { innerHTML: "current preview" },
    "#editor": { classList: classes() },
  };
  const view = createFilesDomView({
    query: (selector) => elements[selector],
    queryAll: () => [],
    escape: String,
    rawUrl: (_project, path) => `/raw/${path}`,
  });

  view.beginOpen("app", "next.ts");
  assert.equal(elements["#editor"].classList.values.has("hidden"), false);
  assert.equal(elements["#media"].innerHTML, "current preview");

  view.showMedia("app", "image.png", "image/png");
  assert.equal(elements["#editor"].classList.values.has("hidden"), true);
  view.showEditor(true);
  assert.equal(elements["#editor"].classList.values.has("hidden"), false);
  assert.equal(elements["#media"].innerHTML, "");
});

test("save conflicts preserve dirty editor state and expected revision", async () => {
  let writes = 0;
  let reads = 0;
  const h = harness({
    readFile: async () =>
      reads++ === 0
        ? {
            content: "original",
            mime: "text/plain",
            editable: true,
            version: "v1",
          }
        : {
            content: "agent edit",
            mime: "text/plain",
            editable: true,
            version: "v2",
          },
    writeFile: async () => {
      writes++;
      throw new Error("revision conflict");
    },
  });
  h.controller.syncProjects();
  await h.controller.openFile("README.md", false, false);
  h.setText("changed");
  h.controller.editorChanged("changed");
  assert.equal(await h.controller.save(), false);
  assert.equal(writes, 1);
  assert.equal(h.controller.dirty, true);
  assert.equal(h.controller.openVersion, "v1");
  assert.equal(h.controller.savedText, "original");
  assert.equal(h.controller.externalFile?.version, "v2");
  assert.ok(h.states.some((state) => state[1] === "CHANGED ON DISK"));
  assert.ok(h.calls.some((call) => call[0] === "conflict" && call[1] === true));
});

test("an external edit refreshes a clean editor without a save conflict", async () => {
  let disk = {
    content: "original",
    mime: "text/plain",
    editable: true,
    version: "v1",
  };
  const h = harness({
    readFile: async () => disk,
    fileRevision: async () => ({ revision: disk.version }),
  });
  h.controller.syncProjects();
  await h.controller.openFile("README.md", false, false);

  disk = { ...disk, content: "agent edit", version: "v2" };
  assert.equal(await h.controller.checkExternalChange(), true);
  assert.equal(h.controller.savedText, "agent edit");
  assert.equal(h.controller.openVersion, "v2");
  assert.equal(h.controller.dirty, false);
  assert.ok(
    h.calls.some((call) => call[0] === "replace" && call[1] === "agent edit"),
  );
});

test("an external edit preserves a dirty draft until the user resolves it", async () => {
  let disk = {
    content: "original",
    mime: "text/plain",
    editable: true,
    version: "v1",
  };
  const writes = [];
  const h = harness({
    readFile: async () => disk,
    fileRevision: async () => ({ revision: disk.version }),
    writeFile: async (input) => {
      writes.push(input);
      disk = { ...disk, content: input.content, version: "v3" };
    },
  });
  h.controller.syncProjects();
  await h.controller.openFile("README.md", false, false);
  h.setText("browser draft");
  h.controller.editorChanged("browser draft");
  disk = { ...disk, content: "agent edit", version: "v2" };

  assert.equal(await h.controller.checkExternalChange(), true);
  assert.equal(h.controller.dirty, true);
  assert.equal(h.controller.externalFile?.content, "agent edit");
  assert.equal(await h.controller.save(), false);
  assert.equal(writes.length, 0);
  h.controller.compareExternal();
  assert.ok(
    h.calls.some(
      (call) =>
        call[0] === "compare" &&
        call[1] === "browser draft" &&
        call[2] === "agent edit",
    ),
  );

  assert.equal(await h.controller.overwriteExternal(), true);
  assert.equal(writes[0].expectedRevision, "v2");
  assert.equal(h.controller.dirty, false);
  assert.equal(h.controller.externalFile, null);
});

test("project switching resets file state and emits encoded routes", async () => {
  const h = harness();
  h.controller.syncProjects();
  h.controller.project = "one";
  h.controller.openPath = "src/app.ts";
  h.controller.dirty = true;
  h.controller.expanded.add("src");
  await h.controller.switchProject("two space");

  assert.equal(h.controller.project, "two space");
  assert.equal(h.controller.openPath, null);
  assert.equal(h.controller.dirty, false);
  assert.equal(h.controller.expanded.size, 0);
  assert.deepEqual(h.calls.at(-1), [
    "navigate",
    "/files/two%20space",
    undefined,
  ]);
  assert.equal(
    fileRoute("two space", "src/a #.ts"),
    "/files/two%20space/src/a%20%23.ts",
  );
});
