import crypto from "node:crypto";

export const Roles = Object.freeze({ OWNER: "owner", COLLABORATOR: "collaborator", VIEWER: "viewer" });

const tokenFrom = (req) => {
  const authorization = String(req.headers?.authorization || "");
  if (/^Bearer\s+/i.test(authorization)) return authorization.replace(/^Bearer\s+/i, "").trim();
  return String(req.headers?.["x-workbench-control"] || "").trim();
};
const cookieValue = (req, name) => String(req.headers?.cookie || "").split(";").map((part) => part.trim()).find((part) => part.startsWith(`${name}=`))?.slice(name.length + 1) || "";

const equalToken = (actual, expected) => {
  if (!actual || !expected) return false;
  const left = crypto.createHash("sha256").update(actual).digest();
  const right = crypto.createHash("sha256").update(expected).digest();
  return crypto.timingSafeEqual(left, right);
};

export function makeWorkbenchAuthorization({
  ownerToken,
  collaboratorTokens = [],
  authenticationRequired = true,
}) {
  const collaborators = [...collaboratorTokens].map(String).filter(Boolean);
  const sessions = new Map();
  const roleForToken = (token) => {
    if (equalToken(token, ownerToken)) return Roles.OWNER;
    if (collaborators.some((candidate) => equalToken(token, candidate))) return Roles.COLLABORATOR;
    return null;
  };
  const createSession = (token) => {
    const role = roleForToken(token);
    if (!role) return null;
    const id = crypto.randomBytes(32).toString("base64url");
    sessions.set(id, { role, expiresAt: Date.now() + 12 * 60 * 60_000 });
    return { id, role };
  };
  const principal = (req) => {
    if (!authenticationRequired)
      return { role: Roles.OWNER, authorized: true, authenticationRequired: false };
    const role = roleForToken(tokenFrom(req));
    if (role) return { role, authorized: true };
    const sessionId = cookieValue(req, "bash_workbench_session");
    const session = sessions.get(sessionId);
    if (session?.expiresAt > Date.now()) return { role: session.role, authorized: true };
    if (session) sessions.delete(sessionId);
    return { role: Roles.VIEWER, authorized: false, authenticationRequired: true };
  };
  const requireAccess = (req, capability = "workbench.access") => {
    const result = principal(req);
    if (!result.authorized) {
      throw Object.assign(new Error("Workbench authorization is required"), {
        status: 401,
        code: "Unauthorized",
        capability,
      });
    }
    const usingSession = !!cookieValue(req, "bash_workbench_session") && !tokenFrom(req);
    if (usingSession && !["GET", "HEAD", "OPTIONS"].includes(String(req.method || "GET").toUpperCase())) {
      const origin = String(req.headers?.origin || "");
      const protocol = String(req.headers?.["x-forwarded-proto"] || (req.socket?.encrypted ? "https" : "http")).split(",")[0];
      const expected = `${protocol}://${req.headers?.host || ""}`;
      if (!origin || origin !== expected) throw Object.assign(new Error("Request origin is not allowed"), { status: 403, code: "ForbiddenOrigin", capability });
    }
    return result;
  };
  const revokeSession = (req) => sessions.delete(cookieValue(req, "bash_workbench_session"));
  return { principal, requireAccess, createSession, revokeSession };
}

export function protectedCapability(pathname) {
  if (pathname === "/api/rpc" || pathname === "/api/rpc/stream") return "rpc.access";
  if (pathname === "/api/sync" || pathname === "/api/sync/stream") return "sync.access";
  if (pathname === "/api/workflows" || pathname.startsWith("/api/workflows/")) return "workflows.access";
  if (/^\/api\/artifacts\/[^/]+\/download$/.test(pathname)) return "artifacts.read";
  if (pathname === "/api/session-image") return "session.read";
  if (/^\/api\/projects\/[^/]+\/(?:raw|source\.zip|repository\.bundle)$/.test(pathname)) return "projects.read";
  return null;
}

export function collaboratorTokensFromEnvironment(env = process.env) {
  return String(env.BASH_WORKBENCH_COLLABORATOR_TOKENS || "")
    .split(",")
    .map((token) => token.trim())
    .filter(Boolean);
}
