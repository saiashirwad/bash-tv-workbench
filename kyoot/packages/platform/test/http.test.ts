import assert from "node:assert/strict";
import { test } from "node:test";
import { Http } from "../src/index.ts";

test("HttpRouter matches static routes and parameter extraction", async () => {
  const router = new Http.HttpRouter();
  router.get("/api/health", () => new Response(JSON.stringify({ ok: true }), { status: 200 }));
  router.get(
    "/api/projects/:id/files/*",
    (_req, params) =>
      new Response(JSON.stringify({ project: params.id, file: params.wildcard }), { status: 200 }),
  );

  const res1 = await router.handle(new Request("http://localhost/api/health"));
  assert.equal(res1.status, 200);
  assert.deepEqual(await res1.json(), { ok: true });

  const res2 = await router.handle(
    new Request("http://localhost/api/projects/kyoot/files/src/index.ts"),
  );
  assert.equal(res2.status, 200);
  assert.deepEqual(await res2.json(), { project: "kyoot", file: "src/index.ts" });

  const res404 = await router.handle(new Request("http://localhost/not-found"));
  assert.equal(res404.status, 404);
});
