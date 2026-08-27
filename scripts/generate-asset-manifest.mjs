import crypto from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const root = path.resolve(fileURLToPath(new URL("..", import.meta.url)));
const publicRoot = path.join(root, "public");
const manifestFile = path.join(publicRoot, "asset-manifest.json");
const entries = [
  "app.js",
  "auth.js",
  "dom.js",
  "editor.js",
  "files.js",
  "git.js",
  "live-chat.js",
  "markdown.js",
  "runs.js",
  "trajectory.js",
  "webmcp.js",
  "workbench-store.js",
  "workflows.js",
];
const shellLogical = [
  "/app.js",
  "/auth.js",
  "/dom.js",
  "/files.js",
  "/git.js",
  "/live-chat.js",
  "/runs.js",
  "/webmcp.js",
  "/workbench-store.js",
  "/page.mjs",
  ...fs
    .readdirSync(publicRoot)
    .filter((name) => name.endsWith(".css"))
    .sort()
    .map((name) => `/${name}`),
];

const assets = {};
for (const name of entries) {
  const sourceFile = path.join(publicRoot, name);
  const source = fs.readFileSync(sourceFile);
  const digest = crypto
    .createHash("sha256")
    .update(source)
    .digest("hex")
    .slice(0, 16);
  const hashedName = name.replace(/\.js$/, `.${digest}.js`);
  fs.writeFileSync(path.join(publicRoot, hashedName), source);
  assets[`/${name}`] = `/${hashedName}`;
}
const shell = [
  ...new Set(
    shellLogical.flatMap((url) => (assets[url] ? [url, assets[url]] : [url])),
  ),
];
const manifest = { version: 1, assets, shell };
const serialized = `${JSON.stringify(manifest, null, 2)}\n`;
const manifestVersion = crypto
  .createHash("sha256")
  .update(serialized)
  .digest("hex")
  .slice(0, 16);
const tmpManifest = `${manifestFile}.${process.pid}.tmp`;
fs.writeFileSync(tmpManifest, serialized);
fs.renameSync(tmpManifest, manifestFile);

const workerFile = path.join(publicRoot, "sw.js");
const worker = fs
  .readFileSync(workerFile, "utf8")
  .replace("__ASSET_MANIFEST_VERSION__", manifestVersion);
if (worker.includes("__ASSET_MANIFEST_VERSION__"))
  throw new Error("service worker manifest version was not replaced");
fs.writeFileSync(workerFile, worker);

const current = new Set(Object.values(assets).map((url) => url.slice(1)));
const hashedPatterns = entries.map(
  (entry) =>
    new RegExp(
      `^${entry.slice(0, -3).replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}\\.[a-f0-9]{16}\\.js$`,
    ),
);
for (const name of fs.readdirSync(publicRoot)) {
  if (
    !current.has(name) &&
    hashedPatterns.some((pattern) => pattern.test(name))
  )
    fs.rmSync(path.join(publicRoot, name), { force: true });
}

const htmlFile = path.join(publicRoot, "index.html");
const html = fs.readFileSync(htmlFile, "utf8");
const generatedHtml = html.replace(
  /(<script\s+type="module"\s+src=")[^"]*("><\/script>)/,
  `$1${assets["/app.js"]}$2`,
);
if (generatedHtml === html && !html.includes(assets["/app.js"]))
  throw new Error("index.html module entry was not found");
fs.writeFileSync(htmlFile, generatedHtml);
console.log(
  `Generated ${path.relative(root, manifestFile)} with ${entries.length} hashed JS entries.`,
);
