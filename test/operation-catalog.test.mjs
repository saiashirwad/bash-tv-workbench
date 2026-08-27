import assert from "node:assert/strict";
import test from "node:test";
import {
  PLATFORM_OPERATION_CATALOG,
  PLATFORM_OPERATIONS,
  assertPlatformInput,
  platformOperation,
  validatePlatformInput,
} from "../workbench-operation-catalog.mjs";

const expectedNames = [
  "workbench_exec",
  "workbench_read_exec_output",
  "workbench_start_process",
  "workbench_read_process",
  "workbench_write_process",
  "workbench_stop_process",
  "workbench_list_processes",
  "workbench_search_project_content",
  "workbench_apply_patch",
  "workbench_fs_mutate",
  "workbench_export_project",
  "workbench_list_artifacts",
  "workbench_download_artifact",
  "workbench_delete_artifact",
  "workbench_import_archive",
  "workbench_create_snapshot",
  "workbench_list_snapshots",
  "workbench_restore_snapshot",
  "workbench_git_diff",
  "workbench_git_stage",
  "workbench_git_commit",
  "workbench_git_branch",
  "workbench_git_sync",
  "workbench_list_ports",
  "workbench_vm_info",
  "workbench_list_system_processes",
];

test("catalog preserves every platform WebMCP registration name and declares policy", () => {
  assert.deepEqual(
    PLATFORM_OPERATION_CATALOG.map((item) => item.name),
    expectedNames,
  );
  assert.equal(Object.keys(PLATFORM_OPERATIONS).length, expectedNames.length);
  for (const entry of PLATFORM_OPERATION_CATALOG) {
    assert.equal(entry.inputSchema.additionalProperties, false, entry.name);
    assert.ok(
      entry.description && entry.title && entry.capability && entry.method,
      entry.name,
    );
    assert.ok(["vm", "project", "workspace"].includes(entry.scope), entry.name);
    assert.ok(
      Number.isFinite(entry.limits.timeoutMs) &&
        Number.isFinite(entry.limits.maxInputBytes) &&
        Number.isFinite(entry.limits.maxOutputBytes),
      entry.name,
    );
    assert.equal(
      entry.annotations.readOnly,
      !entry.annotations.mutating,
      entry.name,
    );
  }
});

test("WebMCP registers every platform tool directly from the catalog", async (t) => {
  const registered = [];
  const previousDocument = globalThis.document;
  const previousAddEventListener = globalThis.addEventListener;
  globalThis.document = {
    modelContext: { registerTool: async (tool) => registered.push(tool) },
  };
  globalThis.addEventListener = () => {};
  t.after(() => {
    if (previousDocument === undefined) delete globalThis.document;
    else globalThis.document = previousDocument;
    if (previousAddEventListener === undefined)
      delete globalThis.addEventListener;
    else globalThis.addEventListener = previousAddEventListener;
  });
  const { registerWorkbenchWebMcp } = await import(
    `../public/webmcp.js?catalog-test=${Date.now()}`
  );
  const collection = { all: () => [], get: () => null };
  const status = await registerWorkbenchWebMcp(
    { projects: collection, runs: collection, workflows: collection },
    { navigate() {}, currentProject: () => "test" },
  );
  assert.equal(status.error, undefined);
  for (const definition of PLATFORM_OPERATION_CATALOG) {
    const tool = registered.find((item) => item.name === definition.name);
    assert.ok(tool, definition.name);
    assert.deepEqual(tool.inputSchema, definition.inputSchema);
    assert.equal(tool.description, definition.description);
    assert.equal(
      tool.annotations.readOnlyHint,
      definition.annotations.readOnly,
    );
  }
});

test("catalog rejects unknown operations and unknown fields with structured issues", () => {
  const unknown = validatePlatformInput("exec", {});
  assert.equal(unknown.ok, false);
  assert.equal(unknown.error._tag, "UnknownOperation");

  const invalid = validatePlatformInput("workbench_exec", {
    project: "p",
    command: "true",
    surprise: 1,
  });
  assert.equal(invalid.ok, false);
  assert.deepEqual(invalid.error.issues[0], {
    path: "$.surprise",
    code: "additionalProperties",
    message: "Unknown field",
  });
  assert.throws(
    () =>
      assertPlatformInput("workbench_exec", {
        project: "p",
        command: "true",
        surprise: 1,
      }),
    (error) => error._tag === "InputValidationError" && error.status === 400,
  );
});

test("catalog validates required fields, types, enums, ranges, and arrays", () => {
  const missing = validatePlatformInput("workbench_exec", {});
  assert.equal(missing.ok, false);
  assert.deepEqual(
    missing.error.issues.map((issue) => issue.code),
    ["required", "required"],
  );
  assert.equal(
    validatePlatformInput("workbench_exec", {
      project: "p",
      command: "true",
      timeoutMs: 100,
    }).ok,
    true,
  );
  assert.equal(
    validatePlatformInput("workbench_exec", {
      project: "p",
      command: "true",
      timeoutMs: 99,
    }).error.issues[0].code,
    "range",
  );
  assert.equal(
    validatePlatformInput("workbench_git_sync", {
      project: "p",
      action: "merge",
    }).error.issues[0].code,
    "enum",
  );
  assert.equal(
    validatePlatformInput("workbench_git_stage", {
      project: "p",
      paths: ["a", 2],
    }).error.issues[0].path,
    "$.paths[1]",
  );
  assert.equal(platformOperation("not-real"), null);
});
