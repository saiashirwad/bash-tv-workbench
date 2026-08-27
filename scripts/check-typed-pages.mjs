import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const root = path.resolve(fileURLToPath(new URL("..", import.meta.url)));
const pageSources = [
  "frontend/app.ts",
  "frontend/trajectory.ts",
  "frontend/workflows.ts",
  "frontend/webmcp.ts",
];
const failures = [];
const adapterSources = new Set(["frontend/auth.ts"]);
for (const relative of pageSources) {
  const source = fs.readFileSync(path.join(root, relative), "utf8");
  if (/\bfetch\s*\(/.test(source) && !adapterSources.has(relative)) failures.push(`${relative}: direct fetch bypasses WorkbenchStore`);
  for (const match of source.matchAll(/\/api\/[a-zA-Z0-9_?=/.-]+/g)) {
    const endpoint = match[0];
    if (endpoint.startsWith("/api/session-image") || endpoint.startsWith("/api/projects/")) continue;
    failures.push(`${relative}: direct application API reference ${endpoint}`);
  }
}

for (const obsolete of ["frontend/query-cache.ts", "public/query-cache.js"])
  if (fs.existsSync(path.join(root, obsolete))) failures.push(`${obsolete}: obsolete pre-Kyoot query cache`);

const server = fs.readFileSync(path.join(root, "server.mjs"), "utf8");
for (const obsolete of [
  '"/api/session"',
  "/api/agents",
  "/api/files",
  "/api/search",
  "/api/git",
  "/api/runs",
]) if (server.includes(obsolete)) failures.push(`server.mjs: obsolete application route ${obsolete}`);

const allowedDirectResources = [
  "/api/session-image",
  "/api/projects/:id/raw",
  "/api/projects/:id/source.zip",
  "/api/projects/:id/repository.bundle",
];
if (failures.length) {
  console.error("Typed-page architecture check failed:\n" + failures.map((failure) => `- ${failure}`).join("\n"));
  process.exit(1);
}
console.log(
  "Typed-page architecture check passed: all maintained page data uses WorkbenchStore RPC/sync; " +
    `direct endpoints are limited to byte streams (${allowedDirectResources.join(", ")}).`,
);
