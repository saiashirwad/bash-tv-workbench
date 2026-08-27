import fs from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { build } from "esbuild";

const root = path.resolve(fileURLToPath(new URL("..", import.meta.url)));
const chunks = path.join(root, "public/chunks");

await fs.mkdir(chunks, { recursive: true });
for (const name of await fs.readdir(chunks)) {
  if (name.startsWith("editor-") && name.endsWith(".js"))
    await fs.rm(path.join(chunks, name));
}

await build({
  absWorkingDir: root,
  entryPoints: ["editor-entry.ts"],
  bundle: true,
  format: "esm",
  splitting: true,
  target: "es2022",
  minify: true,
  outdir: "public",
  entryNames: "editor",
  chunkNames: "chunks/editor-[name]-[hash]",
});
