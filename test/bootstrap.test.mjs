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
  assert.match(prompt, /installs the pinned `mise` binary/);
  assert.match(prompt, /default experimental open-access mode/);
  assert.match(prompt, /Do not set `BASH_WORKBENCH_AUTH_REQUIRED`/);
});
