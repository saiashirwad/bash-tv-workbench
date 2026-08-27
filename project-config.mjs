import fs from "node:fs";
import path from "node:path";
import os from "node:os";
import crypto from "node:crypto";

const applicationRoot = fs.realpathSync(
  path.dirname(new URL(import.meta.url).pathname),
);
export const configPath = path.resolve(
  process.env.BASH_WORKBENCH_CONFIG ||
    path.join(os.homedir(), ".local/share/bash-workbench/projects.json"),
);

function validId(value) {
  return typeof value === "string" && /^[a-z0-9][a-z0-9._-]{0,63}$/.test(value);
}

const reservedIds = new Set(["bash-workbench", "kyoot-workbench"]);

function readRegistry(filename) {
  try {
    return JSON.parse(fs.readFileSync(filename, "utf8"));
  } catch (error) {
    if (error?.code === "ENOENT") return { version: 1, projects: [] };
    throw new Error(
      `Cannot read project registry ${filename}: ${error.message}`,
    );
  }
}

function projectId(value) {
  const id = String(value || "project")
    .normalize("NFKD")
    .toLowerCase()
    .replace(/[^a-z0-9._-]+/g, "-")
    .replace(/^[^a-z0-9]+|[-._]+$/g, "")
    .slice(0, 64);
  return id || "project";
}

function projectEntry(entry, index) {
  if (!entry || !validId(entry.id)) {
    throw new Error(`Project ${index + 1} has an invalid id`);
  }
  const requestedRoot = path.resolve(String(entry.root || ""));
  let root;
  try {
    root = fs.realpathSync(requestedRoot);
  } catch {
    throw new Error(
      `Project root does not exist (${entry.id}): ${requestedRoot}`,
    );
  }
  if (!fs.statSync(root).isDirectory()) {
    throw new Error(`Project root is not a directory (${entry.id}): ${root}`);
  }
  return {
    id: entry.id,
    name: String(entry.name || path.basename(root)),
    root,
    hidden: entry.hidden === true,
  };
}

/** Load and validate the one project registry shared by HTTP and agent processes. */
export function loadProjects(filename = configPath) {
  const parsed = readRegistry(filename);

  if (!Array.isArray(parsed.projects))
    throw new Error(
      `Project registry ${filename} must contain a projects array`,
    );
  const configured = parsed.projects.filter(
    (entry) => !reservedIds.has(entry?.id),
  );
  parsed.projects = [
    { id: "bash-workbench", name: "Bash Workbench", root: applicationRoot },
    ...configured,
    {
      id: "kyoot-workbench",
      name: "Bash Workbench",
      root: applicationRoot,
      hidden: true,
    },
  ];

  const ids = new Set();
  return parsed.projects.map((entry, index) => {
    const project = projectEntry(entry, index);
    if (ids.has(entry.id)) throw new Error(`Duplicate project id: ${entry.id}`);
    ids.add(entry.id);
    return project;
  });
}

/** Persist one user project and return its normalized registry entry. */
export function registerProject(input, filename = configPath) {
  if (typeof input?.root !== "string" || !input.root.trim()) {
    throw new Error("Project root is required");
  }
  const requestedRoot = path.resolve(input.root);
  let root;
  try {
    root = fs.realpathSync(requestedRoot);
  } catch {
    throw new Error(`Project root does not exist: ${requestedRoot}`);
  }
  if (!fs.statSync(root).isDirectory()) {
    throw new Error(`Project root is not a directory: ${root}`);
  }
  if (
    root === path.parse(root).root ||
    root === fs.realpathSync(os.homedir())
  ) {
    throw new Error(
      "Register a specific project directory, not the home or root directory",
    );
  }
  if (root === applicationRoot || root.startsWith(applicationRoot + path.sep)) {
    throw new Error("The user project must be outside the Workbench directory");
  }

  const name = String(input?.name || path.basename(root)).trim();
  if (!name || name.length > 100) {
    throw new Error("Project name must contain 1 to 100 characters");
  }
  const id = input?.id == null ? projectId(name) : String(input.id);
  if (!validId(id)) {
    throw new Error(
      "Project id must use 1 to 64 lowercase letters, numbers, dots, dashes, or underscores",
    );
  }
  if (reservedIds.has(id)) throw new Error(`Project id is reserved: ${id}`);

  const projects = loadProjects(filename).filter(
    (project) => !reservedIds.has(project.id),
  );
  const sameRoot = projects.find((project) => project.root === root);
  if (sameRoot) return sameRoot;
  if (projects.some((project) => project.id === id)) {
    throw new Error(`Duplicate project id: ${id}`);
  }

  const project = { id, name, root, hidden: false };
  const directory = path.dirname(filename);
  const temporary = path.join(
    directory,
    `.${path.basename(filename)}.${process.pid}.${crypto.randomUUID()}.tmp`,
  );
  fs.mkdirSync(directory, { recursive: true, mode: 0o700 });
  try {
    fs.writeFileSync(
      temporary,
      `${JSON.stringify({ version: 1, projects: [...projects, project].map(({ id, name, root }) => ({ id, name, root })) }, null, 2)}\n`,
      { encoding: "utf8", mode: 0o600, flag: "wx" },
    );
    fs.renameSync(temporary, filename);
    fs.chmodSync(filename, 0o600);
  } finally {
    try {
      fs.unlinkSync(temporary);
    } catch (error) {
      if (error?.code !== "ENOENT") throw error;
    }
  }
  return project;
}

export function containsProjectPath(projects, candidate) {
  const resolved = path.resolve(candidate);
  return projects.some(
    ({ root }) => resolved === root || resolved.startsWith(root + path.sep),
  );
}
