import fs from "node:fs";
import path from "node:path";
import os from "node:os";

const applicationRoot = fs.realpathSync(path.dirname(new URL(import.meta.url).pathname));
export const configPath = path.resolve(
  process.env.BASH_WORKBENCH_CONFIG ||
    path.join(os.homedir(), ".local/share/bash-workbench/projects.json"),
);

function validId(value) {
  return typeof value === "string" && /^[a-z0-9][a-z0-9._-]{0,63}$/.test(value);
}

/** Load and validate the one project registry shared by HTTP and agent processes. */
export function loadProjects() {
  let parsed;
  try {
    parsed = JSON.parse(fs.readFileSync(configPath, "utf8"));
  } catch (error) {
    if (error?.code !== "ENOENT")
      throw new Error(`Cannot read project registry ${configPath}: ${error.message}`);
    parsed = { version: 1, projects: [] };
  }

  if (!Array.isArray(parsed.projects))
    throw new Error(`Project registry ${configPath} must contain a projects array`);
  const configured = parsed.projects.filter((entry) => entry?.id !== "kyoot-workbench");
  parsed.projects = [
    { id: "kyoot-workbench", name: "Kyoot Workbench", root: applicationRoot },
    ...configured,
  ];

  const ids = new Set();
  return parsed.projects.map((entry, index) => {
    if (!entry || !validId(entry.id)) {
      throw new Error(`Project ${index + 1} has an invalid id`);
    }
    if (ids.has(entry.id)) throw new Error(`Duplicate project id: ${entry.id}`);
    ids.add(entry.id);

    const requestedRoot = path.resolve(String(entry.root || ""));
    let root;
    try {
      root = fs.realpathSync(requestedRoot);
    } catch (error) {
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
    };
  });
}

export function containsProjectPath(projects, candidate) {
  const resolved = path.resolve(candidate);
  return projects.some(
    ({ root }) => resolved === root || resolved.startsWith(root + path.sep),
  );
}
