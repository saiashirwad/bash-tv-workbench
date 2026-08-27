import { readdirSync, existsSync, readFileSync } from "node:fs";
import { spawnSync } from "node:child_process";
import path from "node:path";

const script = process.argv[2];
if (!script) {
  console.error("usage: node scripts/run-package-script.mjs <script>");
  process.exit(2);
}

const root = path.resolve(new URL("..", import.meta.url).pathname);
const packagesRoot = path.join(root, "kyoot/packages");
for (const name of readdirSync(packagesRoot).sort()) {
  const directory = path.join(packagesRoot, name);
  const manifest = path.join(directory, "package.json");
  if (!existsSync(manifest)) continue;
  const packageJson = JSON.parse(readFileSync(manifest, "utf8"));
  if (!packageJson.scripts?.[script]) continue;
  console.log(`\n==> ${packageJson.name}: ${script}`);
  const result = spawnSync("npm", ["--prefix", directory, "run", script], {
    stdio: "inherit",
    env: process.env,
  });
  if (result.error) throw result.error;
  if (result.status !== 0) process.exit(result.status ?? 1);
}
