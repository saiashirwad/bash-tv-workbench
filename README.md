# Kyoot Workbench

A standalone Bash.tv coding workbench built on the vendored Kyoot effect, RPC, sync, query-cache, Pi, and workflow packages. The repository is one pinned Node/npm workspace with one deterministic install and lockfile.

Everything required to build and run the application lives in this directory:

```text
frontend/                 maintained TypeScript browser source
orchestrator-kyoot/       durable run and workflow engines
kyoot/                    complete vendored Kyoot source workspace
public/                   generated browser-native deployment assets
server.mjs                production HTTP entrypoint
```

No sibling Kyoot checkout is required. The orchestrator was folded into this standalone source tree after commit `51fbe648a79fb063765852556db32887e6feae17`; its former nested repository metadata is intentionally not part of deployments.

## Deploy to a new Bash space

This repository is the deployment artifact. Copy or extract it into the destination space, give the destination coding agent the prompt in [`SETUP_PROMPT.md`](SETUP_PROMPT.md), and let that agent perform the acceptance checks.

The agent-facing lifecycle is:

```bash
bash ./bootstrap.sh doctor
bash ./bootstrap.sh plan
bash ./bootstrap.sh install
bash ./bootstrap.sh verify
# Launch this command using the Bash.tv coding tool's detached/tmux mode:
bash ./bootstrap.sh serve
bash ./bootstrap.sh verify --live
```

`./scripts/setup-space.sh` remains a short alias for `bash ./bootstrap.sh install`. When the artifact was extracted from a Source ZIP rather than cloned, installation initializes an in-place local Git repository with no remote so Source ZIP and Git bundle downloads remain available.

`serve` deliberately runs in the foreground. The destination agent must start it with its coding tool's detached/tmux mode so the durable process inherits current Bash.tv authorization in memory. Do not use `&`, `nohup`, or a clean systemd service for the authorized runtime.

To create a copyable archive:

```bash
bash ./bootstrap.sh archive
```

The server automatically registers its installation directory as the first project:

```text
kyoot-workbench — Kyoot Workbench
```

A missing project registry is valid; additional projects can be supplied through `BASH_WORKBENCH_CONFIG` or `~/.local/share/bash-workbench/projects.json`.

## Workbench access mode

This experimental distribution currently defaults to **open access** so Bash.tv chat participants can test every feature before secure environment-variable configuration is available. Anyone who can reach the preview receives owner-equivalent Workbench access, including VM-wide shell operations. The UI and `/api/health` identify this mode explicitly.

To restore the protected owner/collaborator boundary, start with `BASH_WORKBENCH_AUTH_REQUIRED=1`. The existing credential/session implementation remains intact and no credential is disclosed when open mode is used.

## Bash.tv entitlement boundary

`bashtv/free` authorization is session-bound. Start the Workbench from the destination space's active Bash.tv agent environment so child Pi processes inherit current authorization in memory. Credential values are allowlisted at child spawn, and are never returned, logged, or persisted. A clean credential-isolated systemd unit cannot independently obtain this entitlement.

## Bootstrap commands

```bash
bash ./bootstrap.sh doctor          # verify Bash.tv Pi, mise, toolchain, and repository completeness
bash ./bootstrap.sh plan            # print exact paths, port, concurrency, and state location
bash ./bootstrap.sh install         # install in place, build, check, and provision private state
bash ./bootstrap.sh serve           # foreground production runtime for a detached/tmux agent job
bash ./bootstrap.sh verify          # health, self-registration, archive, and confinement checks
bash ./bootstrap.sh verify --live   # additionally execute one bounded real bashtv/free turn
bash ./bootstrap.sh archive         # create ../kyoot-workbench-standalone.zip from Git HEAD
```

## WebMCP

The browser UI exposes typed Workbench queries and mutations as browser-native WebMCP tools when `document.modelContext` is available. See [`WEBMCP.md`](WEBMCP.md) for the tool inventory and desktop coding-harness setup.

## Development commands

```bash
mise exec -- npm ci            # install the entire workspace from package-lock.json
mise exec -- npm run build     # generate browser and typed-server assets
mise exec -- npm run check     # frontend, syntax, and portability checks
mise exec -- npm run check:all # Workbench + Kyoot + orchestrator checks
```

The root `mise.toml` pins Node `24.19.0`; npm `11.17.0` is supplied by that toolchain and owns the complete workspace through one root `package-lock.json`. Generated `typed-server.mjs` targets Node 20 and production uses `/usr/bin/node` for Bash.tv/Pi compatibility.
