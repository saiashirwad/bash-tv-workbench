# Bash Workbench

A standalone Bash.tv coding workbench. The repository is one pinned Node/npm workspace with one deterministic install and lockfile.

Bash Workbench is a background development tool, not the application that a user asks the Bash.tv agent to build. Keep each user project outside the Workbench installation directory, and register it so that it is visible and controllable in the Workbench.

Everything required to build and run the application lives in this directory:

```text
frontend/     maintained TypeScript browser source
public/          committed browser-native deployment assets
typed-server.mjs committed typed backend bundle
server.mjs       production HTTP entrypoint
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

The server registers its own installation directory for Workbench maintenance. This is not the user project. Register the user's actual project after its directory exists:

```bash
$HOME/.local/bin/bw projects register \
  --root /home/bashtv/my-app \
  --name "My App" \
  --id my-app
```

Registration updates the running browser and persists the project for the next Workbench start. A missing project registry is valid. Its default path is `~/.local/share/bash-workbench/projects.json`, and `BASH_WORKBENCH_CONFIG` can select a different path.

## Workbench access mode

This experimental distribution currently defaults to **open access** so Bash.tv chat participants can test every feature before secure environment-variable configuration is available. Anyone who can reach the preview receives owner-equivalent Workbench access, including VM-wide shell operations. The UI and `/api/health` identify this mode explicitly.

To restore the protected owner/collaborator boundary, start with `BASH_WORKBENCH_AUTH_REQUIRED=1`. The existing credential/session implementation remains intact and no credential is disclosed when open mode is used.

## Bash.tv entitlement boundary

`bashtv/free` authorization is session-bound. Start the Workbench from the destination space's active Bash.tv agent environment so child Pi processes inherit current authorization in memory. Credential values are allowlisted at child spawn, and are never returned, logged, or persisted. A clean credential-isolated systemd unit cannot independently obtain this entitlement.

## Bootstrap commands

```bash
bash ./bootstrap.sh doctor          # verify Bash.tv Pi; install mise and Node if needed; check repository completeness
bash ./bootstrap.sh plan            # print exact paths, port, concurrency, and state location
bash ./bootstrap.sh install         # install dependencies, state, and the agent CLI
bash ./bootstrap.sh serve           # foreground production runtime for a detached/tmux agent job
bash ./bootstrap.sh verify          # health, self-registration, archive, and confinement checks
bash ./bootstrap.sh verify --live   # additionally execute one bounded real bashtv/free turn
bash ./bootstrap.sh archive         # create a standalone ZIP from Git HEAD
```

## WebMCP

The browser UI exposes typed Workbench queries and mutations as browser-native WebMCP tools when `document.modelContext` is available. See [`WEBMCP.md`](WEBMCP.md) for the tool inventory and desktop coding-harness setup.

## Agent CLI

`bootstrap.sh install` adds `bash-workbench` and the short `bw` alias to
`$HOME/.local/bin`. Bash.tv does not always add this directory to `PATH`, so
agents must use the full `$HOME/.local/bin/bw` path. The CLI gives an agent
direct control of runs, workflows, files, Git, managed processes, artifacts,
snapshots, VM inspection, Live Trajectory, and every validated platform
operation.

```bash
$HOME/.local/bin/bw status --wait
$HOME/.local/bin/bw projects list
$HOME/.local/bin/bw projects register --root /home/bashtv/my-app --name "My App" --id my-app
$HOME/.local/bin/bw runs create --project my-app --prompt "Fix the failing build"
$HOME/.local/bin/bw runs batch --file parallel-runs.json --concurrency 2
$HOME/.local/bin/bw runs watch RUN_ID
$HOME/.local/bin/bw exec --project my-app -- npm test
$HOME/.local/bin/bw op list
```

See [`CLI.md`](CLI.md) for the complete command interface.

`public/` and `typed-server.mjs` are committed deployment assets. Normal setup
uses these files directly and does not rebuild them. Developers run
`npm run build` before they commit source changes.

## Development commands

```bash
mise exec -- npm ci            # install the entire workspace from package-lock.json
mise exec -- npm run build     # generate browser and typed-server assets
mise exec -- npm run check     # frontend, syntax, and portability checks
mise exec -- npm run check:all # complete Workbench and orchestrator checks
```

The root `mise.toml` pins Node `24.19.0`; npm `11.17.0` is supplied by that toolchain and owns the complete workspace through one root `package-lock.json`. Generated `typed-server.mjs` targets Node 20 and production uses `/usr/bin/node` for Bash.tv/Pi compatibility.
