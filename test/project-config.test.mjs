import assert from "node:assert/strict";
import { mkdtemp, mkdir, readFile, rm, stat } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { loadProjects, registerProject } from "../project-config.mjs";

test("project registry exposes Bash Workbench and keeps the old ID hidden", () => {
  const projects = loadProjects();
  assert.deepEqual(
    projects
      .filter((project) => !project.hidden)
      .map(({ id, name }) => ({ id, name })),
    [{ id: "bash-workbench", name: "Bash Workbench" }],
  );
  const legacy = projects.find((project) => project.id === "kyoot-workbench");
  assert.equal(legacy?.hidden, true);
  assert.equal(legacy?.root, projects[0].root);
});

test("project registration is persistent and idempotent", async (t) => {
  const temporary = await mkdtemp(
    path.join(os.tmpdir(), "workbench-projects-"),
  );
  t.after(() => rm(temporary, { recursive: true, force: true }));
  const root = path.join(temporary, "Example App");
  const registry = path.join(temporary, "state", "projects.json");
  await mkdir(root);

  const first = registerProject({ root, name: "Example App" }, registry);
  const second = registerProject({ root, name: "Ignored Name" }, registry);

  assert.equal(first.id, "example-app");
  assert.deepEqual(second, first);
  assert.deepEqual(
    loadProjects(registry)
      .filter((project) => !project.hidden)
      .map(({ id, name, root }) => ({ id, name, root })),
    [
      {
        id: "bash-workbench",
        name: "Bash Workbench",
        root: loadProjects(registry)[0].root,
      },
      { id: "example-app", name: "Example App", root: first.root },
    ],
  );
  assert.equal((await stat(registry)).mode & 0o777, 0o600);
  const persisted = JSON.parse(await readFile(registry, "utf8"));
  assert.deepEqual(persisted.projects, [
    { id: "example-app", name: "Example App", root: first.root },
  ]);
});
