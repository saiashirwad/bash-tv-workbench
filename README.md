# Bash Workbench

A standalone Bash.tv coding workbench. The repository is one pinned Node/npm workspace with one deterministic install and lockfile.

Everything required to build and run the application lives in this directory:

```text
frontend/     maintained TypeScript browser source
public/       generated browser-native deployment assets
server.mjs    production HTTP entrypoint
```

No sibling checkout is required. All build and runtime source is in this repository.

## Deploy to a new Bash space

Give the destination coding agent the one-paste prompt in [`SETUP_PROMPT.md`](SETUP_PROMPT.md). The prompt clones the latest `main` branch from `https://github.com/saiashirwad/bash-tv-workbench.git`, or safely fast-forwards an existing clean checkout, then installs and opens the Workbench.

The agent-facing lifecycle is:

```bash
bash ./bootstrap.sh install
# Launch this command using the Bash.tv coding tool's detached/tmux mode:
bash ./bootstrap.sh serve
```

The `verify` and `verify --live` commands are optional release and acceptance checks. Setup does not run them.

`doctor` installs pinned `mise v2026.8.14` into `$HOME/.local/bin/mise` when it is absent, verifies the official binary checksum, and installs Node `24.19.0` from `mise.toml`. `./scripts/setup-space.sh` remains a short alias for `bash ./bootstrap.sh install`. When the artifact was extracted from a Source ZIP rather than cloned, installation initializes an in-place local Git repository with no remote so Source ZIP and Git bundle downloads remain available.

`serve` deliberately runs in the foreground. The destination agent must start it with its coding tool's detached/tmux mode so the durable process inherits current Bash.tv authorization in memory. Do not use `&`, `nohup`, or a clean systemd service for the authorized runtime.

To create a copyable archive:

```bash
bash ./bootstrap.sh archive
```

The server automatically registers its installation directory as the first project, named Bash Workbench.

A missing project registry is valid; additional projects can be supplied through `BASH_WORKBENCH_CONFIG` or `~/.local/share/bash-workbench/projects.json`.

## Workbench access mode

This experimental distribution currently defaults to **open access** so Bash.tv chat participants can test every feature before secure environment-variable configuration is available. Anyone who can reach the preview receives owner-equivalent Workbench access, including VM-wide shell operations. The UI and `/api/health` identify this mode explicitly.

To restore the protected owner/collaborator boundary, start with `BASH_WORKBENCH_AUTH_REQUIRED=1`. The existing credential/session implementation remains intact and no credential is disclosed when open mode is used.

## Bash.tv entitlement boundary

`bashtv/free` authorization is session-bound. Start the Workbench from the destination space's active Bash.tv agent environment so child Pi processes inherit current authorization in memory. Credential values are allowlisted at child spawn, and are never returned, logged, or persisted. A clean credential-isolated systemd unit cannot independently obtain this entitlement.

## Bootstrap commands

```bash
bash ./bootstrap.sh doctor          # verify Bash.tv Pi; install mise and Node if needed; check repository completeness
bash ./bootstrap.sh plan            # print exact paths, port, concurrency, and state location
bash ./bootstrap.sh install         # install in place, build, and provision private state
bash ./bootstrap.sh serve           # foreground production runtime for a detached/tmux agent job
bash ./bootstrap.sh verify          # health, self-registration, archive, and confinement checks
bash ./bootstrap.sh verify --live   # additionally execute one bounded real bashtv/free turn
bash ./bootstrap.sh archive         # create a standalone ZIP from Git HEAD
```

## WebMCP

The browser UI exposes typed Workbench queries and mutations as browser-native WebMCP tools when `document.modelContext` is available. See [`WEBMCP.md`](WEBMCP.md) for the tool inventory and desktop coding-harness setup.

## Development commands

```bash
mise exec -- npm ci            # install the entire workspace from package-lock.json
mise exec -- npm run build     # generate browser and typed-server assets
mise exec -- npm run check     # frontend, syntax, and portability checks
mise exec -- npm run check:all # complete Workbench and orchestrator checks
```

The root `mise.toml` pins Node `24.19.0`; npm `11.17.0` is supplied by that toolchain and owns the complete workspace through one root `package-lock.json`. Generated `typed-server.mjs` targets Node 20 and production uses `/usr/bin/node` for Bash.tv/Pi compatibility.
