import assert from "node:assert/strict";
import test from "node:test";
import {
  FilesController,
  ancestors,
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
    writeFile: async (input) => calls.push(["write", input]),
    editorText: () => text,
    openEditor: async () => {},
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

test("save conflicts preserve dirty editor state and expected revision", async () => {
  let writes = 0;
  const h = harness({
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
  assert.ok(h.states.some((state) => state[1] === "revision conflict"));
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
