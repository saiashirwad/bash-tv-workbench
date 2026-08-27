import crypto from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import { spawnSync } from "node:child_process";

const generated = ["public", "typed-server.mjs"];
const hash = (file) =>
  crypto.createHash("sha256").update(fs.readFileSync(file)).digest("hex");
const snapshot = () => {
  const files = [];
  const walk = (target) => {
    const stat = fs.statSync(target);
    if (stat.isDirectory())
      for (const name of fs.readdirSync(target).sort())
        walk(path.join(target, name));
    else files.push(target);
  };
  generated.forEach(walk);
  return Object.fromEntries(files.map((file) => [file, hash(file)]));
};
const before = snapshot();
const result = spawnSync("npm", ["run", "build"], { stdio: "inherit" });
if (result.status) process.exit(result.status ?? 1);
const after = snapshot();
const changed = [
  ...new Set([...Object.keys(before), ...Object.keys(after)]),
].filter((file) => before[file] !== after[file]);
if (changed.length) {
  console.error(`Generated assets are stale:\n${changed.join("\n")}`);
  process.exit(1);
}
const manifest = JSON.parse(
  fs.readFileSync("public/asset-manifest.json", "utf8"),
);
for (const [logical, hashed] of Object.entries(manifest.assets || {})) {
  if (!/^\/[\w-]+\.[a-f0-9]{16}\.js$/.test(hashed))
    throw new Error(`Invalid hashed asset for ${logical}`);
  const source = fs.readFileSync(path.join("public", logical.slice(1)));
  const output = fs.readFileSync(path.join("public", hashed.slice(1)));
  if (!source.equals(output))
    throw new Error(`Hashed asset content mismatch: ${hashed}`);
}
if (
  !manifest.shell?.length ||
  manifest.shell.some((url) => url.startsWith("/api/"))
)
  throw new Error("Invalid service-worker shell manifest");
console.log("Generated manifest and assets match source builds.");
