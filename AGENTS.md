# Kyoot Workbench Agent Guide

This repository is the complete deployable Kyoot Workbench. It includes the application, generated runtime assets, durable orchestrator, and all Kyoot source under `kyoot/`. It must remain copyable without a sibling Kyoot checkout or any fixed installation path.

## Setup contract

- Read `SETUP_PROMPT.md` and use `./bootstrap.sh doctor|plan|install|verify|serve`.
- Use the pinned Node `24.19.0` toolchain through `mise` and the single root npm workspace for installation and task orchestration.
- Generated `typed-server.mjs` remains compatible with Node 20 and runs with `/usr/bin/node`.
- Start the production server from the active Bash.tv agent environment using a detached/tmux coding-tool job. Do not daemonize inside `bootstrap.sh`.
- The normal production port is `8010`; leave `8012`, `8020`, and internal platform port `7890` untouched.

## Security boundaries

- Never print, inspect, copy, log, persist, or return Bash.tv entitlement or credential values.
- Use only inherited `bashtv/free` authorization. The only supported model selection is the existing free provider configuration.
- Do not modify `/opt/pi-mono`, `bashtv-agent.service`, or platform internals.
- Do not enable the included systemd template for session-authorized Pi operation. A clean systemd environment cannot obtain current Bash.tv entitlement.
- Treat preview mutations as public until trusted owner authentication is implemented.
- Preserve realpath project confinement. Never expose all of `$HOME` or bypass file policy checks.

## Architecture rules

- Kyoot is the sole normal-run and workflow process engine.
- `@kyoot/pi` owns Workbench coding sessions; `@kyoot/ai-pi` remains a lower-level raw model integration.
- Keep compact normalized collections in sync; files, search, Git, binary media, archives, and raw previews remain on-demand queries/endpoints.
- Optimistic projections and rollback belong in `WorkbenchStore`, not UI components.
- Keep the frontend vanilla TypeScript/Page.js and commit generated browser-native ESM.
- Preserve run events, usage, attribution, changes, timing, CWD, and process metadata.

## Required checks

Before committing deployment or runtime changes:

```bash
mise exec -- npm run check
mise exec -- npm run build
mise exec -- npm run check:all
./bootstrap.sh verify
```

For a destination-space acceptance test, start the server from the active Bash.tv session and run:

```bash
./bootstrap.sh verify --live
```

Do not run overlapping live probes casually: Pi cold starts are staggered because simultaneous starts can enter Linux `D` state.
