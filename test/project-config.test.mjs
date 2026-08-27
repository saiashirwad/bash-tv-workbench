import assert from "node:assert/strict";
import test from "node:test";
import { loadProjects } from "../project-config.mjs";

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
