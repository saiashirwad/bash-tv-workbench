import assert from "node:assert/strict";
import test from "node:test";
import { GitController } from "../public/git.js";

const emptyGit = {
  branch: "",
  upstream: "",
  ahead: 0,
  behind: 0,
  status: "",
  commits: [],
  latest: null,
  detail: null,
};

function deferred() {
  let resolve;
  let reject;
  const promise = new Promise((ok, fail) => {
    resolve = ok;
    reject = fail;
  });
  return { promise, resolve, reject };
}

function harness(load = async () => emptyGit) {
  const calls = [];
  const renders = [];
  const errors = [];
  const adapter = {
    load: (project, commit, force) => {
      calls.push(["load", project, commit, force]);
      return load(project, commit, force);
    },
    setProject: (project) => calls.push(["project", project]),
    navigate: (url) => calls.push(["navigate", url]),
    schedule: (callback) => callback(),
  };
  const view = {
    render: (data, selectedCommit) => renders.push({ data, selectedCommit }),
    renderProject: (project) => calls.push(["renderProject", project]),
    setProjectMenu: (open) => calls.push(["menu", open]),
    showError: (error) => errors.push(error.message),
  };
  return {
    controller: new GitController(adapter, view),
    calls,
    renders,
    errors,
  };
}

test("project changes reset selection and preserve the project route", async () => {
  const h = harness();
  await h.controller.route("first", "abc");
  h.controller.changeProject("space two");

  assert.equal(h.controller.project, "space two");
  assert.equal(h.controller.selectedCommit, null);
  assert.deepEqual(h.calls.slice(-3), [
    ["project", "space two"],
    ["menu", false],
    ["navigate", "/git/space%20two"],
  ]);
});

test("commit selection and deep-link routes load the selected commit", async () => {
  const h = harness();
  await h.controller.route("repo", "feature/hash");
  h.controller.selectCommit("next/hash");

  assert.deepEqual(
    h.calls.find((call) => call[0] === "load"),
    ["load", "repo", "feature/hash", false],
  );
  assert.equal(h.renders.at(-1).selectedCommit, "feature/hash");
  assert.deepEqual(h.calls.at(-1), ["navigate", "/git/repo/next%2Fhash"]);
});

test("empty repositories render and load errors use the error state", async () => {
  const h = harness(async (project) => {
    if (project === "broken") throw new Error("git unavailable");
    return emptyGit;
  });

  await h.controller.route("empty");
  await h.controller.route("broken");

  assert.equal(h.renders.length, 1);
  assert.deepEqual(h.renders[0].data, emptyGit);
  assert.deepEqual(h.errors, ["git unavailable"]);
});

test("an older request cannot replace a newer project response", async () => {
  const first = deferred();
  const second = deferred();
  const h = harness((project) =>
    project === "first" ? first.promise : second.promise,
  );

  const oldLoad = h.controller.route("first");
  const newLoad = h.controller.route("second");
  second.resolve({ ...emptyGit, branch: "new" });
  await newLoad;
  first.resolve({ ...emptyGit, branch: "old" });
  await oldLoad;

  assert.equal(h.renders.length, 1);
  assert.equal(h.renders[0].data.branch, "new");
});
