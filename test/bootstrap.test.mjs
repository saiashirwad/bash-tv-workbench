import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { readFile } from "node:fs/promises";
import { test } from "node:test";

const root = new URL("../", import.meta.url);
const bootstrapPath = new URL("bootstrap.sh", root);

test("bootstrap shell syntax is valid", () => {
  execFileSync("bash", ["-n", bootstrapPath.pathname]);
});

test("doctor bootstraps a pinned checksummed mise binary", async () => {
  const source = await readFile(bootstrapPath, "utf8");
  assert.match(source, /MISE_VERSION="2026\.8\.14"/);
  assert.match(source, /mise-v\$\{MISE_VERSION\}-linux-x64/);
  assert.match(source, /mise-v\$\{MISE_VERSION\}-linux-arm64/);
  assert.match(source, /verify_sha256 "\$download" "\$checksum"/);
  assert.match(source, /ensure_mise\n/);
  assert.ok(
    source.indexOf("ensure_mise\n") < source.indexOf('"$MISE" install'),
    "doctor must install mise before it installs the project toolchain",
  );
});

test("one-paste setup clones GitHub and keeps open experimental access", async () => {
  const prompt = await readFile(new URL("SETUP_PROMPT.md", root), "utf8");
  assert.match(
    prompt,
    /https:\/\/github\.com\/saiashirwad\/bash-tv-workbench\.git/,
  );
  assert.match(prompt, /bash \.\/bootstrap\.sh install/);
  assert.match(prompt, /default experimental open-access mode/);
  assert.match(prompt, /Do not set `BASH_WORKBENCH_AUTH_REQUIRED`/);
  assert.match(prompt, /\$HOME\/\.local\/bin\/bw status --wait/);
  assert.doesNotMatch(prompt, /until .*grep/);
  assert.match(prompt, /If a required command fails, stop/);
  assert.match(prompt, /Use `runs batch` for independent parallel tasks/);
});

test("space installation uses committed deployment assets", async () => {
  const source = await readFile(bootstrapPath, "utf8");
  const install = source.slice(
    source.indexOf("install() {"),
    source.indexOf("serve() {"),
  );
  assert.match(install, /npm ci --omit=dev/);
  assert.doesNotMatch(install, /npm run build/);
  assert.match(install, /Bash Workbench installed/);
  assert.doesNotMatch(install, /Kyoot Workbench/);
});

test("agent-facing setup files use the Bash Workbench identity", async () => {
  const sources = await Promise.all(
    [
      "README.md",
      "SETUP_PROMPT.md",
      "AGENTS.md",
      "orchestrator-kyoot/README.md",
      "public/index.html",
    ].map((file) => readFile(new URL(file, root), "utf8")),
  );
  for (const source of sources) {
    assert.doesNotMatch(source, /kyoot/i);
  }
});
