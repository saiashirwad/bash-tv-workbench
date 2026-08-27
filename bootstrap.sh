#!/usr/bin/env bash
set -euo pipefail

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd -P)"
PORT="${BASH_WORKBENCH_PORT:-8010}"
HOST="${BASH_WORKBENCH_HOST:-0.0.0.0}"
CONFIG_PATH="${BASH_WORKBENCH_CONFIG:-$HOME/.local/share/bash-workbench/projects.json}"
MAX_AGENTS="${BASH_WORKBENCH_MAX_AGENTS:-3}"
START_SPACING_MS="${BASH_WORKBENCH_START_SPACING_MS:-4000}"
COMMAND="${1:-plan}"
LIVE="${2:-}"
MISE="$(command -v mise 2>/dev/null || true)"
[[ -n "$MISE" ]] || MISE="$HOME/.local/bin/mise"

cd "$ROOT"

ok() { printf '[ok] %s\n' "$*"; }
info() { printf '[info] %s\n' "$*"; }
fail() { printf '[fail] %s\n' "$*" >&2; exit 1; }

have_node_24() {
  "$MISE" exec -- node -e 'if (Number(process.versions.node.split(".")[0]) < 24) process.exit(1)'
}

doctor() {
  [[ -f /opt/pi-mono/packages/coding-agent/dist/cli.js ]] || fail "Bash.tv Pi runtime is missing"
  ok "Bash.tv Pi runtime found"
  [[ -x "$MISE" ]] || fail "mise is required (checked PATH and $HOME/.local/bin/mise)"
  ok "mise found: $MISE"
  [[ -f mise.toml ]] || fail "mise.toml is missing"
  "$MISE" install
  have_node_24 || fail "mise could not provide Node 24 or newer"
  ok "project toolchain: $("$MISE" exec -- node --version), npm $("$MISE" exec -- npm --version)"
  [[ -f kyoot/packages/kyoot/src/index.ts ]] || fail "vendored Kyoot source is incomplete"
  [[ -f orchestrator-kyoot/src/run-engine.ts ]] || fail "orchestrator source is incomplete"
  [[ -f typed-server.mjs && -f public/workbench-store.js ]] || fail "generated runtime assets are missing"
  ok "vendored source and generated runtime assets found"
  node scripts/check-standalone.mjs
  ok "repository root: $ROOT"
  info "Pi authorization must be inherited from this active Bash.tv agent session and is never persisted."
}

plan() {
  doctor
  cat <<EOF
Install/build root: $ROOT
Self-registered project: kyoot-workbench -> $ROOT
Optional registry: $CONFIG_PATH
Listen address: $HOST:$PORT
Maximum active normal agents: $MAX_AGENTS
Cold-start spacing: ${START_SPACING_MS}ms
Runtime state: $ROOT/.state (mode 0700)

No source is copied elsewhere. This repository is the installed application.
The server must be launched from the active Bash.tv agent with its detached/tmux tool mode:
  bash ./bootstrap.sh serve
EOF
}

ensure_repository() {
  if git rev-parse --show-toplevel >/dev/null 2>&1; then
    [[ "$(git rev-parse --show-toplevel)" == "$ROOT" ]] || fail "repository root is not the Workbench root"
    ok "existing Git repository"
    return
  fi
  command -v git >/dev/null 2>&1 || fail "git is required to initialize an extracted deployment"
  info "Initializing extracted archive as a local Git repository"
  chmod +x bootstrap.sh scripts/setup-space.sh
  git init -b main
  git config user.name "Kyoot Workbench Setup"
  git config user.email "workbench@local.invalid"
  git add .
  git commit -m "Initialize standalone Kyoot Workbench deployment"
  ok "local Git repository initialized (no remote configured)"
}

install() {
  doctor
  ensure_repository
  info "Installing the unified npm workspace"
  "$MISE" exec -- npm ci
  info "Building committed runtime assets"
  "$MISE" exec -- npm run build
  info "Running Workbench and portability checks"
  "$MISE" exec -- npm run check
  mkdir -p .state
  chmod 700 .state
  ok "Kyoot Workbench installed in place at $ROOT"
  chmod +x bootstrap.sh scripts/setup-space.sh
  info "Next: start 'bash ./bootstrap.sh serve' with the Bash.tv coding tool's detached/tmux mode."
}

serve() {
  [[ -f typed-server.mjs ]] || fail "generated assets are missing; run ./bootstrap.sh install first"
  mkdir -p .state
  chmod 700 .state
  info "Starting Kyoot Workbench on $HOST:$PORT from the current session environment"
  info "This command intentionally remains in the foreground; launch it with the agent's detached/tmux tool mode."
  exec env \
    HOST="$HOST" \
    PORT="$PORT" \
    BASH_WORKBENCH_CONFIG="$CONFIG_PATH" \
    BASH_WORKBENCH_MAX_AGENTS="$MAX_AGENTS" \
    BASH_WORKBENCH_START_SPACING_MS="$START_SPACING_MS" \
    /usr/bin/node "$ROOT/server.mjs"
}

rpc() {
  local procedure="$1" input="$2"
  PROCEDURE="$procedure" INPUT="$input" PORT="$PORT" node --input-type=module <<'NODE'
const token = await (await import("node:fs/promises")).readFile(".state/workflows-v1/control.token", "utf8").then(x => x.trim());
const response = await fetch(`http://127.0.0.1:${process.env.PORT}/api/rpc`, {
  method: "POST",
  headers: { "content-type": "application/json", "x-workbench-control": token },
  body: JSON.stringify({
    version: 1,
    id: crypto.randomUUID(),
    procedure: process.env.PROCEDURE,
    input: JSON.parse(process.env.INPUT),
  }),
});
const payload = await response.json();
if (!response.ok || payload.ok === false) throw new Error(JSON.stringify(payload));
process.stdout.write(JSON.stringify(payload.output));
NODE
}

verify_static() {
  "$MISE" exec -- npm run check:portable
  [[ "$(stat -c '%a' .state)" == "700" ]] || fail ".state must have mode 0700"
  ok "state permissions"
  if find . -mindepth 2 -type d -name .git -print -quit | grep -q .; then
    fail "nested Git repository found"
  fi
  ok "single repository layout"
}

verify_server() {
  local health projects archive tmp
  health="$(curl -fsS "http://127.0.0.1:$PORT/api/health")" || fail "server is not reachable on port $PORT"
  HEALTH="$health" node -e 'const h=JSON.parse(process.env.HEALTH); if(!h.ok||h.mode!=="kyoot"||h.orchestrator?.engine!=="@kyoot/pi") process.exit(1)' \
    || fail "unexpected health response"
  ok "health: $health"
  projects="$(rpc projects.list '{}')"
  PROJECTS="$projects" ROOT="$ROOT" node - <<'NODE' || fail "self-registered project does not match this repository"
const projects = JSON.parse(process.env.PROJECTS);
const own = projects.find((project) => project.id === "kyoot-workbench");
if (!own || own.root !== process.env.ROOT || !own.writable) process.exit(1);
NODE
  ok "kyoot-workbench self-registers at $ROOT"
  tmp="$(mktemp)"
  trap 'rm -f "$tmp"' RETURN
  curl -fsS -H "x-workbench-control: $(<.state/workflows-v1/control.token)" "http://127.0.0.1:$PORT/api/projects/kyoot-workbench/source.zip" -o "$tmp" \
    || fail "standalone source archive failed"
  ARCHIVE="$tmp" node --input-type=module <<'NODE' || fail "standalone archive is incomplete"
import { execFileSync } from "node:child_process";
const listing = execFileSync("python3", ["-c", `
import sys, zipfile
with zipfile.ZipFile(sys.argv[1]) as z:
 print("\\n".join(z.namelist()))
`, process.env.ARCHIVE], { encoding: "utf8" });
for (const required of [
  "SETUP_PROMPT.md",
  "AGENTS.md",
  "bootstrap.sh",
  "package-lock.json",
  "kyoot/packages/sync/src/index.ts",
  "orchestrator-kyoot/src/run-engine.ts",
]) if (!listing.split("\n").includes(required)) process.exit(1);
if (listing.includes("node_modules/") || listing.includes(".state/")) process.exit(1);
NODE
  rm -f "$tmp"
  trap - RETURN
  ok "standalone source archive"
}

verify_live() {
  info "Submitting one bounded no-tool bashtv/free acceptance turn"
  PORT="$PORT" ROOT="$ROOT" node --input-type=module <<'NODE'
const token = await (await import("node:fs/promises")).readFile(".state/workflows-v1/control.token", "utf8").then(x => x.trim());
const call = async (procedure, input) => {
  const response = await fetch(`http://127.0.0.1:${process.env.PORT}/api/rpc`, {
    method: "POST",
    headers: { "content-type": "application/json", "x-workbench-control": token },
    body: JSON.stringify({ version: 1, id: crypto.randomUUID(), procedure, input }),
  });
  const payload = await response.json();
  if (!response.ok || payload.ok === false) throw new Error(JSON.stringify(payload));
  return payload.output;
};
let run = await call("runs.create", {
  project: "kyoot-workbench",
  title: "SPACE_SETUP_PROBE",
  prompt: "Do not use tools. Reply exactly KY OOT_WORKBENCH_READY without the space after KY.",
});
const deadline = Date.now() + 60_000;
while (Date.now() < deadline) {
  run = await call("runs.get", { id: run.id });
  if (["completed", "failed", "stopped"].includes(run.status)) break;
  await new Promise((resolve) => setTimeout(resolve, 500));
}
if (run.status !== "completed" || !run.output?.includes("KYOOT_WORKBENCH_READY")) {
  console.error(JSON.stringify({ id: run.id, status: run.status, error: run.error }));
  process.exit(1);
}
if (run.cwd !== process.env.ROOT || !run.sessionDir?.startsWith(`${process.env.ROOT}/.state/`)) process.exit(1);
console.log(`[ok] real Pi run ${run.id}: KYOOT_WORKBENCH_READY`);
NODE
  sleep 1
  if ps -eo args | grep '/opt/pi-mono/packages/coding-agent/dist/cli.js' | grep "$ROOT" | grep -v grep >/dev/null; then
    fail "an idle Pi child remains after the live probe"
  fi
  ok "no residual Pi child"
}

verify() {
  verify_static
  verify_server
  if [[ "$LIVE" == "--live" ]]; then verify_live; fi
}

archive() {
  command -v git >/dev/null 2>&1 || fail "git is required"
  git rev-parse --show-toplevel >/dev/null 2>&1 || fail "this checkout is not a Git repository"
  local output="${2:-$(dirname "$ROOT")/kyoot-workbench-standalone.zip}"
  git archive --format=zip --prefix=kyoot-workbench/ -o "$output" HEAD
  ok "wrote $output"
}

case "$COMMAND" in
  doctor) doctor ;;
  plan) plan ;;
  install | update) install ;;
  serve) serve ;;
  verify) verify ;;
  archive) archive "$@" ;;
  *)
    echo "usage: bash ./bootstrap.sh {doctor|plan|install|update|serve|verify [--live]|archive [output.zip]}" >&2
    exit 2
    ;;
esac
