import assert from "node:assert/strict";
import test from "node:test";
import { access, readFile } from "node:fs/promises";

const root = new URL("../", import.meta.url);
const removedOverrides = [
  "nav-fix.css",
  "no-page-bars.css",
  "chat-match.css",
  "palette-tint.css",
];

test("every local linked stylesheet exists and removed overrides are unreferenced", async () => {
  const [html, worker] = await Promise.all([
    readFile(new URL("public/index.html", root), "utf8"),
    readFile(new URL("frontend/sw.ts", root), "utf8"),
  ]);
  const stylesheets = [
    ...html.matchAll(
      /<link\b(?=[^>]*\brel=["']stylesheet["'])[^>]*\bhref=["']([^"']+)["'][^>]*>/g,
    ),
  ].map((match) => match[1]);

  assert.ok(stylesheets.length > 0, "index.html must link local stylesheets");
  for (const href of stylesheets) {
    const url = new URL(href, "https://workbench.invalid/");
    assert.equal(
      url.origin,
      "https://workbench.invalid",
      `stylesheet must be local: ${href}`,
    );
    await access(new URL(`public/${url.pathname.slice(1)}`, root));
  }

  for (const filename of removedOverrides) {
    assert.equal(html.includes(filename), false, `${filename} remains linked`);
    assert.equal(
      worker.includes(filename),
      false,
      `${filename} remains precached`,
    );
  }
});
