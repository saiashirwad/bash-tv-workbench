import assert from "node:assert/strict";
import test from "node:test";
import { makeWorkbenchAuthorization, protectedCapability, Roles } from "../workbench-auth.mjs";

const auth = makeWorkbenchAuthorization({ ownerToken: "owner-test-token", collaboratorTokens: ["friend-test-token"] });
const request = (token, bearer = false) => ({ method: "POST", headers: token ? bearer ? { authorization: `Bearer ${token}` } : { "x-workbench-control": token } : {} });

test("anonymous callers are viewers and rejected before protected operations", () => {
  assert.deepEqual(auth.principal(request()), {
    role: Roles.VIEWER,
    authorized: false,
    authenticationRequired: true,
  });
  assert.throws(() => auth.requireAccess(request(), "platform.exec"), (error) => error.status === 401 && error.code === "Unauthorized");
});

test("owner and explicitly granted collaborator tokens authorize", () => {
  assert.equal(auth.requireAccess(request("owner-test-token"), "platform.exec").role, Roles.OWNER);
  assert.equal(auth.requireAccess(request("friend-test-token", true), "platform.exec").role, Roles.COLLABORATOR);
  assert.equal(auth.principal(request("not-granted")).authorized, false);
});

test("open experimental policy grants anonymous owner access without exposing tokens", () => {
  const open = makeWorkbenchAuthorization({
    ownerToken: "owner-test-token",
    authenticationRequired: false,
  });
  assert.deepEqual(open.principal(request()), {
    role: Roles.OWNER,
    authorized: true,
    authenticationRequired: false,
  });
  assert.equal(open.requireAccess(request(), "platform.exec").role, Roles.OWNER);
});

test("all private HTTP transports and byte streams share the protected boundary", () => {
  for (const pathname of [
    "/api/rpc", "/api/rpc/stream", "/api/sync", "/api/sync/stream", "/api/workflows/events",
    "/api/artifacts/example/download", "/api/session-image", "/api/projects/project/raw",
    "/api/projects/project/source.zip", "/api/projects/project/repository.bundle",
  ]) assert.ok(protectedCapability(pathname), pathname);
  assert.equal(protectedCapability("/api/health"), null);
  assert.equal(protectedCapability("/app.js"), null);
});

test("raw credentials are not accepted from query strings or arbitrary cookies", () => {
  const principal = auth.principal({ headers: { cookie: "x-workbench-control=owner-test-token" }, url: "/api/rpc?token=owner-test-token" });
  assert.equal(principal.authorized, false);
});

test("an exchanged credential creates a bounded server-side browser session", () => {
  const session = auth.createSession("friend-test-token");
  assert.equal(session.role, Roles.COLLABORATOR);
  const browserRequest = { method: "POST", headers: { cookie: `bash_workbench_session=${session.id}`, origin: "https://workbench.example", host: "workbench.example", "x-forwarded-proto": "https" } };
  assert.equal(auth.requireAccess(browserRequest).role, Roles.COLLABORATOR);
  assert.throws(() => auth.requireAccess({ ...browserRequest, headers: { ...browserRequest.headers, origin: "https://evil.example" } }), (error) => error.code === "ForbiddenOrigin");
  assert.equal(auth.createSession("bad-token"), null);
});
