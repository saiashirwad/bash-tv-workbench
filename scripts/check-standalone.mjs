import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const root = path.resolve(fileURLToPath(new URL("..", import.meta.url)));
const ignoredDirectories = new Set([".git", ".state", "node_modules"]);
const ignoredFiles = new Set(["typed-server.mjs", "workbench-store.js", "check-standalone.mjs"]);
const textExtensions = new Set([
  ".js", ".mjs", ".ts", ".tsx", ".json", ".md", ".toml", ".yaml", ".yml", ".service", ".sh",
]);
const forbidden = [
  { label: "external Kyoot checkout", pattern: /\/home\/[^/]+\/kyoot(?:\/|\b)/ },
  { label: "old two-level package link", pattern: /file:\.\.\/\.\.\/kyoot/ },
  { label: "fixed Workbench install path", pattern: /\/home\/[^/]+\/workbench(?:\/|\b)/ },
  { label: "legacy supervisor", pattern: /supervisor\.sock|supervisor\.mjs|legacyBackend/ },
];
const failures = [];
const walk = (directory) => {
  for (const entry of fs.readdirSync(directory, { withFileTypes: true })) {
    if (entry.isDirectory() && ignoredDirectories.has(entry.name)) continue;
    const filename = path.join(directory, entry.name);
    if (entry.isDirectory()) walk(filename);
    else if (
      !ignoredFiles.has(entry.name) &&
      (textExtensions.has(path.extname(entry.name)) || entry.name === "Dockerfile")
    ) {
      const source = fs.readFileSync(filename, "utf8");
      for (const rule of forbidden)
        if (rule.pattern.test(source)) failures.push(`${path.relative(root, filename)}: ${rule.label}`);
    }
  }
};
walk(root);
for (const required of [
  "kyoot/packages/kyoot/src/index.ts",
  "kyoot/packages/pi/src/node.ts",
  "kyoot/packages/rpc/src/http.ts",
  "kyoot/packages/sync/src/index.ts",
  "kyoot/packages/workbench-protocol/src/browser.ts",
  "orchestrator-kyoot/src/run-engine.ts",
  "AGENTS.md",
  "WEBMCP.md",
  "SETUP_PROMPT.md",
  "bootstrap.sh",
  "scripts/setup-space.sh",
  "scripts/check-typed-pages.mjs",
  "scripts/verify-webmcp.mjs",
  "public/webmcp-connect.css",
  "public/brand.css",
  "workbench-platform.mjs",
  "workbench-auth.mjs",
  "workbench-operation-catalog.mjs",
  "goal.md",
  "package-lock.json",
]) {
  if (!fs.existsSync(path.join(root, required))) failures.push(`${required}: missing required source`);
}
for (const obsolete of [
  "bun.lock",
  "bunfig.toml",
  "kyoot/pnpm-lock.yaml",
  "orchestrator-kyoot/package-lock.json",
]) {
  if (fs.existsSync(path.join(root, obsolete))) failures.push(`${obsolete}: obsolete non-npm workspace artifact`);
}
if (failures.length) {
  console.error("Standalone portability check failed:\n" + failures.map((item) => `- ${item}`).join("\n"));
  process.exit(1);
}
console.log("Standalone portability check passed: all runtime/build source is Workbench-local.");
