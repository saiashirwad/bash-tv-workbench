const object = (properties, required = []) =>
  Object.freeze({
    type: "object",
    properties: Object.freeze(properties),
    ...(required.length ? { required: Object.freeze(required) } : {}),
    additionalProperties: false,
  });
const text = (description) => ({ type: "string", description });
const boolean = (description) => ({ type: "boolean", description });
const integer = (description, minimum = 1, maximum = 500) => ({
  type: "integer",
  description,
  minimum,
  maximum,
});
const choice = (description, values) => ({
  type: "string",
  description,
  enum: values,
});
const strings = (description, maxItems = 500) => ({
  type: "array",
  description,
  items: { type: "string" },
  maxItems,
});

const operation = ({
  name,
  title,
  description,
  capability,
  scope,
  method,
  properties = {},
  required = [],
  readOnly = false,
  confirmation = false,
  timeoutMs = 30_000,
  maxInputBytes = 1024 * 1024,
  maxOutputBytes = 512 * 1024,
  methodInput,
}) =>
  Object.freeze({
    name,
    title,
    description,
    inputSchema: object(properties, required),
    capability,
    scope,
    limits: Object.freeze({ timeoutMs, maxInputBytes, maxOutputBytes }),
    annotations: Object.freeze({ readOnly, mutating: !readOnly, confirmation }),
    method,
    ...(methodInput ? { methodInput: Object.freeze(methodInput) } : {}),
  });
const project = text("Registered project ID");
const cwd = text(
  "Optional project-relative starting directory; the authorized shell itself has VM-wide access",
);

const entries = [
  operation({
    name: "workbench_exec",
    title: "Run a command",
    description:
      "Run a bounded authorized VM shell command, starting in a registered project.",
    capability: "vm.shell",
    scope: "vm",
    method: "exec",
    properties: {
      project,
      cwd,
      command: text("Shell command"),
      timeoutMs: integer("Timeout in milliseconds", 100, 300000),
      maxOutputBytes: integer("Initial output byte limit", 1024, 524288),
    },
    required: ["project", "command"],
    timeoutMs: 300000,
  }),
  operation({
    name: "workbench_read_exec_output",
    title: "Continue command output",
    description:
      "Read bounded stdout and stderr after independent byte cursors.",
    capability: "vm.shell",
    scope: "vm",
    method: "readOutput",
    readOnly: true,
    properties: {
      outputId: text("Output ID"),
      stdoutCursor: integer("Stdout byte cursor", 0, 4194304),
      stderrCursor: integer("Stderr byte cursor", 0, 4194304),
      maxOutputBytes: integer("Output byte limit", 1024, 524288),
    },
    required: ["outputId"],
  }),
  operation({
    name: "workbench_start_process",
    title: "Start a process",
    description:
      "Start an authorized VM shell process, initially in a registered project.",
    capability: "vm.process",
    scope: "vm",
    method: "startProcess",
    properties: { project, cwd, command: text("Shell command") },
    required: ["project", "command"],
  }),
  operation({
    name: "workbench_read_process",
    title: "Read process",
    description: "Read bounded managed-process output and status.",
    capability: "vm.process",
    scope: "vm",
    method: "readProcess",
    readOnly: true,
    properties: {
      id: text("Process ID"),
      stdoutCursor: integer("Stdout byte cursor", 0, 4194304),
      stderrCursor: integer("Stderr byte cursor", 0, 4194304),
      maxOutputBytes: integer("Output byte limit", 1024, 524288),
    },
    required: ["id"],
  }),
  operation({
    name: "workbench_write_process",
    title: "Write to process",
    description: "Send bounded text to a managed process stdin.",
    capability: "vm.process",
    scope: "vm",
    method: "writeProcess",
    properties: {
      id: text("Process ID"),
      text: text("Text or terminal escape sequence"),
    },
    required: ["id", "text"],
    maxInputBytes: 524288,
  }),
  operation({
    name: "workbench_stop_process",
    title: "Stop process",
    description:
      "Idempotently interrupt or forcefully terminate a managed process.",
    capability: "vm.process",
    scope: "vm",
    method: "stopProcess",
    confirmation: true,
    properties: {
      id: text("Process ID"),
      force: boolean("Send SIGKILL instead of SIGINT"),
    },
    required: ["id"],
  }),
  operation({
    name: "workbench_list_processes",
    title: "List managed processes",
    description: "List bounded commands started through Workbench.",
    capability: "vm.process",
    scope: "vm",
    method: "listProcesses",
    readOnly: true,
    properties: { project: text("Optional project filter") },
  }),
  operation({
    name: "workbench_search_project_content",
    title: "Search project content",
    description:
      "Search text file contents inside a realpath-confined project with ripgrep. This never falls back to filename search.",
    capability: "project.read",
    scope: "project",
    method: "contentSearch",
    readOnly: true,
    properties: {
      project,
      query: text("Literal text or regular expression"),
      regex: boolean(
        "Interpret query as a ripgrep regular expression instead of literal text",
      ),
      include: strings("Include glob patterns", 100),
      exclude: strings("Exclude glob patterns", 100),
      limit: integer("Maximum matching lines", 1, 500),
      maxFileSize: integer("Maximum searched file size in bytes", 1, 67108864),
      contextLines: integer("Context lines before and after each match", 0, 10),
      timeoutMs: integer("Search timeout in milliseconds", 1, 300000),
    },
    required: ["project", "query"],
    timeoutMs: 300000,
  }),
  operation({
    name: "workbench_apply_patch",
    title: "Apply patch",
    description:
      "Atomically check or apply a Git unified patch inside a registered project.",
    capability: "project.write",
    scope: "project",
    method: "applyPatch",
    properties: {
      project,
      patch: text("Unified patch text"),
      dryRun: boolean("Validate without changing files"),
    },
    required: ["project", "patch"],
    maxInputBytes: 4 * 1024 * 1024,
  }),
  operation({
    name: "workbench_fs_mutate",
    title: "Mutate filesystem",
    description:
      "Create, copy, move, rename, delete, chmod, or symlink realpath-confined project paths.",
    capability: "project.write",
    scope: "project",
    method: "fsMutate",
    confirmation: true,
    properties: {
      project,
      operation: choice("Filesystem operation", [
        "mkdir",
        "copy",
        "move",
        "rename",
        "delete",
        "chmod",
        "symlink",
      ]),
      path: text("Project-relative source path"),
      destination: text("Project-relative destination"),
      recursive: boolean("Operate recursively"),
      mode: text("Octal permission mode"),
      confirm: boolean("Confirm destructive operation"),
    },
    required: ["project", "operation", "path"],
  }),
  operation({
    name: "workbench_export_project",
    title: "Export project",
    description:
      "Create a safe bounded ZIP or tar.gz project archive artifact.",
    capability: "project.export",
    scope: "project",
    method: "exportProject",
    properties: {
      project,
      format: choice("Archive format", ["zip", "tar.gz"]),
      name: text("Archive base name"),
      includeGit: boolean("Include .git"),
      includeIgnored: boolean("Include ignored files"),
      include: strings("Included path prefixes"),
      exclude: strings("Additional path exclusions"),
    },
    required: ["project"],
    timeoutMs: 300000,
  }),
  operation({
    name: "workbench_list_artifacts",
    title: "List artifacts",
    description: "List unexpired authorized downloadable artifacts.",
    capability: "artifact.read",
    scope: "workspace",
    method: "listArtifacts",
    readOnly: true,
    properties: { project: text("Optional project filter") },
  }),
  operation({
    name: "workbench_download_artifact",
    title: "Download artifact",
    description:
      "Return the authorized download link and metadata for an unexpired artifact.",
    capability: "artifact.read",
    scope: "workspace",
    method: "downloadArtifact",
    readOnly: true,
    properties: { id: text("Artifact ID") },
    required: ["id"],
  }),
  operation({
    name: "workbench_delete_artifact",
    title: "Delete artifact",
    description: "Delete a generated artifact.",
    capability: "artifact.write",
    scope: "workspace",
    method: "deleteArtifact",
    confirmation: true,
    properties: {
      id: text("Artifact ID"),
      confirm: boolean("Required confirmation"),
    },
    required: ["id", "confirm"],
  }),
  operation({
    name: "workbench_import_archive",
    title: "Import archive",
    description:
      "Dry-run or safely extract an artifact archive into a registered project.",
    capability: "project.import",
    scope: "project",
    method: "importArchive",
    confirmation: true,
    properties: {
      project,
      artifactId: text("Artifact ID"),
      dryRun: boolean("Only inspect entries and conflicts"),
      overwrite: boolean("Overwrite conflicts"),
      confirm: boolean("Confirm extraction"),
    },
    required: ["project", "artifactId"],
    timeoutMs: 300000,
  }),
  operation({
    name: "workbench_create_snapshot",
    title: "Create snapshot",
    description: "Create a restorable project snapshot with Git metadata.",
    capability: "project.snapshot",
    scope: "project",
    method: "createSnapshot",
    properties: { project, name: text("Optional snapshot name") },
    required: ["project"],
    timeoutMs: 300000,
  }),
  operation({
    name: "workbench_list_snapshots",
    title: "List snapshots",
    description: "List unexpired project recovery snapshots.",
    capability: "project.snapshot",
    scope: "project",
    method: "listSnapshots",
    readOnly: true,
    properties: { project: text("Optional project filter") },
  }),
  operation({
    name: "workbench_restore_snapshot",
    title: "Restore snapshot",
    description: "Restore a project snapshot after explicit confirmation.",
    capability: "project.snapshot",
    scope: "project",
    method: "restoreSnapshot",
    confirmation: true,
    properties: {
      project,
      id: text("Snapshot artifact ID"),
      confirm: boolean("Required confirmation"),
    },
    required: ["project", "id", "confirm"],
    timeoutMs: 300000,
  }),
  operation({
    name: "workbench_git_diff",
    title: "Git diff",
    description:
      "Show a registered project's working tree, staged, or ref diff.",
    capability: "project.git",
    scope: "project",
    method: "git",
    methodInput: { operation: "diff" },
    readOnly: true,
    properties: {
      project,
      cached: boolean("Show staged diff"),
      ref: text("Optional Git ref"),
    },
    required: ["project"],
  }),
  operation({
    name: "workbench_git_stage",
    title: "Git stage",
    description: "Stage registered-project paths.",
    capability: "project.git",
    scope: "project",
    method: "git",
    methodInput: { operation: "stage" },
    properties: { project, paths: strings("Project-relative paths") },
    required: ["project", "paths"],
  }),
  operation({
    name: "workbench_git_commit",
    title: "Git commit",
    description: "Commit staged registered-project changes.",
    capability: "project.git",
    scope: "project",
    method: "git",
    methodInput: { operation: "commit" },
    properties: { project, message: text("Commit message") },
    required: ["project", "message"],
  }),
  operation({
    name: "workbench_git_branch",
    title: "Git branch",
    description: "Switch to or create a registered-project branch.",
    capability: "project.git",
    scope: "project",
    method: "git",
    methodInput: { operation: "branch" },
    properties: {
      project,
      name: text("Branch name"),
      create: boolean("Create branch"),
    },
    required: ["project", "name"],
  }),
  operation({
    name: "workbench_git_sync",
    title: "Git sync",
    description:
      "Fetch, pull, or push a registered project; pull and push require confirmation.",
    capability: "project.git",
    scope: "project",
    method: "git",
    methodInput: { operation: "sync" },
    confirmation: true,
    properties: {
      project,
      action: choice("Sync action", ["fetch", "pull", "push"]),
      remote: text("Optional remote"),
      confirm: boolean("Confirm pull or push"),
    },
    required: ["project", "action"],
    timeoutMs: 120000,
  }),
  operation({
    name: "workbench_list_ports",
    title: "List ports",
    description: "List listening TCP ports in the VM.",
    capability: "vm.inspect",
    scope: "vm",
    method: "listPorts",
    readOnly: true,
  }),
  operation({
    name: "workbench_vm_info",
    title: "VM information",
    description:
      "Get non-secret CPU, memory, disk, OS, and uptime information.",
    capability: "vm.inspect",
    scope: "vm",
    method: "vmInfo",
    readOnly: true,
  }),
  operation({
    name: "workbench_list_system_processes",
    title: "List VM processes",
    description: "List bounded VM process metadata without environments.",
    capability: "vm.inspect",
    scope: "vm",
    method: "systemProcesses",
    readOnly: true,
    properties: { limit: integer("Maximum rows", 1, 500) },
  }),
];

export const PLATFORM_OPERATION_CATALOG = Object.freeze(entries);
export const PLATFORM_OPERATIONS = Object.freeze(
  Object.fromEntries(entries.map((entry) => [entry.name, entry])),
);
export const platformOperation = (name) => PLATFORM_OPERATIONS[name] || null;

export function validatePlatformInput(name, input) {
  const definition = platformOperation(name);
  if (!definition)
    return {
      ok: false,
      error: {
        _tag: "UnknownOperation",
        message: `Unknown platform operation: ${name}`,
        operation: String(name),
        issues: [],
      },
    };
  const issues = [];
  validate(definition.inputSchema, input, "$", issues);
  let bytes = Infinity;
  try {
    bytes = new TextEncoder().encode(JSON.stringify(input)).length;
  } catch {}
  if (bytes > definition.limits.maxInputBytes)
    issues.push({
      path: "$",
      code: "maxInputBytes",
      message: `Input exceeds ${definition.limits.maxInputBytes} bytes`,
    });
  return issues.length
    ? {
        ok: false,
        error: {
          _tag: "InputValidationError",
          message: `Invalid input for ${name}`,
          operation: name,
          issues,
        },
      }
    : { ok: true, definition, value: input };
}

function validate(schema, value, path, issues) {
  if (schema.type === "object") {
    if (!value || typeof value !== "object" || Array.isArray(value)) {
      issues.push({ path, code: "type", message: "Expected object" });
      return;
    }
    for (const key of schema.required || [])
      if (!(key in value))
        issues.push({
          path: `${path}.${key}`,
          code: "required",
          message: "Required field is missing",
        });
    for (const [key, item] of Object.entries(value)) {
      if (!(key in schema.properties)) {
        issues.push({
          path: `${path}.${key}`,
          code: "additionalProperties",
          message: "Unknown field",
        });
        continue;
      }
      validate(schema.properties[key], item, `${path}.${key}`, issues);
    }
  } else if (schema.type === "array") {
    if (!Array.isArray(value)) {
      issues.push({ path, code: "type", message: "Expected array" });
      return;
    }
    if (schema.maxItems !== undefined && value.length > schema.maxItems)
      issues.push({
        path,
        code: "maxItems",
        message: `Expected at most ${schema.maxItems} items`,
      });
    value.forEach((item, index) =>
      validate(schema.items, item, `${path}[${index}]`, issues),
    );
  } else if (schema.type === "integer") {
    if (!Number.isInteger(value))
      issues.push({ path, code: "type", message: "Expected integer" });
    else if (value < schema.minimum || value > schema.maximum)
      issues.push({
        path,
        code: "range",
        message: `Expected ${schema.minimum}..${schema.maximum}`,
      });
  } else if (typeof value !== schema.type)
    issues.push({ path, code: "type", message: `Expected ${schema.type}` });
  else if (schema.enum && !schema.enum.includes(value))
    issues.push({
      path,
      code: "enum",
      message: `Expected one of: ${schema.enum.join(", ")}`,
    });
}

export function assertPlatformInput(name, input) {
  const result = validatePlatformInput(name, input);
  if (!result.ok)
    throw Object.assign(new Error(result.error.message), result.error, {
      status: 400,
    });
  return result;
}
