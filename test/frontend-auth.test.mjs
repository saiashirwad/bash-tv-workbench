import assert from "node:assert/strict";
import test from "node:test";
import { readFile } from "node:fs/promises";
import { exchangeWorkbenchCredential } from "../public/auth.js";

test("browser credential exchange uses only the session request body", async () => {
  const credential = "test-credential-never-persist";
  let request;
  const result = await exchangeWorkbenchCredential(
    credential,
    async (url, options) => {
      request = { url, options };
      return new Response(JSON.stringify({ ok: true, role: "collaborator" }), {
        status: 200,
        headers: { "content-type": "application/json" },
      });
    },
  );

  assert.deepEqual(result, { ok: true, role: "collaborator" });
  assert.equal(request.url, "/api/auth/session");
  assert.equal(request.options.method, "POST");
  assert.equal(new URL(request.url, "https://workbench.example").search, "");
  assert.deepEqual(JSON.parse(request.options.body), { token: credential });
  assert.equal(
    JSON.stringify(request.options.headers).includes(credential),
    false,
  );
});

test("browser credential exchange presents safe errors without reflecting credentials", async () => {
  const credential = "credential-that-must-not-be-reflected";
  await assert.rejects(
    exchangeWorkbenchCredential(
      credential,
      async () =>
        new Response(
          JSON.stringify({ error: `server reflected ${credential}` }),
          {
            status: 401,
            headers: { "content-type": "application/json" },
          },
        ),
    ),
    (error) => {
      assert.match(error.message, /wasn’t accepted/);
      assert.equal(error.message.includes(credential), false);
      return true;
    },
  );
});

test("authentication dialog keeps credentials private and cannot be escaped", async () => {
  const [html, source] = await Promise.all([
    readFile(new URL("../public/index.html", import.meta.url), "utf8"),
    readFile(new URL("../frontend/auth.ts", import.meta.url), "utf8"),
  ]);
  assert.match(html, /<dialog[^>]+id="authDialog"[^>]+aria-labelledby="authTitle"/);
  assert.match(html, /id="authCredential"[^>]+type="password"[^>]+required/);
  assert.match(html, /id="authError"[^>]+role="alert"[^>]+aria-live="assertive"/);
  assert.match(source, /addEventListener\("cancel", \(event\) => event\.preventDefault\(\)\)/);
  assert.doesNotMatch(source, /localStorage|sessionStorage|prompt\(|console\./);
});

test("browser credential exchange rejects malformed success responses", async () => {
  await assert.rejects(
    exchangeWorkbenchCredential(
      "test",
      async () => new Response("not json", { status: 200 }),
    ),
    /Could not authenticate/,
  );
});
