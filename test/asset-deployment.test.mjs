import assert from "node:assert/strict";
import { once } from "node:events";
import { readFile } from "node:fs/promises";
import { spawn } from "node:child_process";
import test from "node:test";

const root = new URL("../", import.meta.url);
const manifest = JSON.parse(
  await readFile(new URL("public/asset-manifest.json", root), "utf8"),
);

async function withServer(run) {
  const port = 18000 + Math.floor(Math.random() * 1000);
  const child = spawn("/usr/bin/node", ["server.mjs"], {
    cwd: root,
    env: { ...process.env, HOST: "127.0.0.1", PORT: String(port) },
    stdio: ["ignore", "pipe", "pipe"],
  });
  const timeout = setTimeout(() => child.kill("SIGKILL"), 10_000);
  try {
    await Promise.race([
      once(child.stdout, "data"),
      once(child, "exit").then(([code]) => {
        throw new Error(`server exited ${code}`);
      }),
    ]);
    await run(`http://127.0.0.1:${port}`);
  } finally {
    child.kill("SIGTERM");
    await once(child, "exit").catch(() => {});
    clearTimeout(timeout);
  }
}

test("asset manifest maps deterministic JS entries and shell excludes private routes", async () => {
  assert.equal(manifest.version, 1);
  assert.match(manifest.assets["/app.js"], /^\/app\.[a-f0-9]{16}\.js$/);
  assert.ok(manifest.shell.includes("/app.js"));
  assert.ok(manifest.shell.includes(manifest.assets["/app.js"]));
  assert.equal(
    manifest.shell.some((url) => url.startsWith("/api/")),
    false,
  );
  for (const [logical, hashed] of Object.entries(manifest.assets)) {
    assert.deepEqual(
      await readFile(new URL(`public${logical}`, root)),
      await readFile(new URL(`public${hashed}`, root)),
    );
  }
});

test("HTTP cache policy distinguishes HTML, hashed, compatibility, and API responses", async () => {
  await withServer(async (base) => {
    const html = await fetch(`${base}/`);
    assert.equal(html.headers.get("cache-control"), "no-cache");
    assert.ok((await html.text()).includes(manifest.assets["/app.js"]));

    const hashed = await fetch(`${base}${manifest.assets["/app.js"]}`);
    assert.equal(
      hashed.headers.get("cache-control"),
      "public, max-age=31536000, immutable",
    );
    const logical = await fetch(`${base}/app.js`);
    assert.equal(logical.headers.get("cache-control"), "public, max-age=300");
    assert.deepEqual(
      Buffer.from(await logical.arrayBuffer()),
      Buffer.from(await hashed.arrayBuffer()),
    );

    const api = await fetch(`${base}/api/health`);
    assert.equal(api.headers.get("cache-control"), "private, no-store");
  });
});

test("service worker only intercepts manifest shell and explicitly bypasses APIs", async () => {
  const worker = await readFile(new URL("frontend/sw.ts", root), "utf8");
  assert.match(worker, /url\.pathname\.startsWith\("\/api\/"\)/);
  assert.match(worker, /if \(!shell\.has\(url\.pathname\)\) return/);
  assert.doesNotMatch(JSON.stringify(manifest.shell), /\/api\//);
});
