# One-prompt Bash.tv Space Setup

Paste the prompt below into a new Bash.tv coding-agent session. No source archive or manual file copy is required.

````text
Set up the latest Kyoot Workbench from this Git repository:

https://github.com/saiashirwad/bash-tv-workbench.git

Use /home/bashtv/workbench as the destination.

1. Inspect the destination before you change it.
   - If it does not exist, clone the `main` branch from the repository URL into `/home/bashtv/workbench`.
   - If it is a clean Git checkout of the same repository, fetch `origin main` and update it with a fast-forward-only merge.
   - If it contains local changes, has a different remote, or cannot update by fast-forward, stop and report the condition. Do not delete, reset, or overwrite it.
2. Enter `/home/bashtv/workbench`. Read `README.md`, `AGENTS.md`, `SETUP_PROMPT.md`, and `bootstrap.sh` before you change or install anything.
3. Keep the repository standalone. Do not use a sibling Kyoot checkout or a fixed Kyoot installation path.
4. Never print, inspect, copy, return, log, or persist Bash.tv entitlement or credential values. Use only the inherited `bashtv/free` authorization. Do not modify `/opt/pi-mono`, `bashtv-agent.service`, or platform internals. Leave internal port `7890` and ports `8012` and `8020` untouched.
5. Run these commands in order:

   ```bash
   bash ./bootstrap.sh doctor
   bash ./bootstrap.sh plan
   bash ./bootstrap.sh install
   bash ./bootstrap.sh verify
   ```

   `doctor` installs the pinned `mise` binary into `$HOME/.local/bin/mise` when it is missing. It verifies the official release checksum, then uses `mise.toml` to install Node `24.19.0` and npm. Do not use a piped remote installer. Stop and report any failed prerequisite. Do not work around a missing Bash.tv Pi runtime.
6. Start the production Workbench from this active Bash.tv agent session with the coding tool's detached or tmux job mode:

   ```bash
   bash ./bootstrap.sh serve
   ```

   Do not use `&`, `nohup`, or a credential-isolated systemd service. The server must bind to `0.0.0.0:8010` unless port `8010` is already used by an unrelated process. Inspect an existing listener before you replace it. Start with the default experimental open-access mode because secure secret configuration is not available yet. Do not set `BASH_WORKBENCH_AUTH_REQUIRED`.
7. Open the preview for port `8010`. Confirm all of these items:
   - Health reports mode `kyoot`.
   - The project list contains `Kyoot Workbench` and points to `/home/bashtv/workbench`.
   - The Files view can open `kyoot/packages/sync/src/index.ts`.
   - The Standalone Workbench ZIP downloads successfully.
8. Run one live acceptance test:

   ```bash
   bash ./bootstrap.sh verify --live
   ```

   This command starts one bounded real `bashtv/free` agent turn. Do not run overlapping live probes.
9. Confirm that ports `8012` and `8020` remain stopped, no idle Pi child remains, and no legacy supervisor or supervisor socket exists.
10. Report the repository commit, path, detached job identifier, port, health result, verification result, and live-probe result. Do not report credential values.
````

The prompt clones the current `main` branch. Later setup sessions can use the same prompt to apply safe fast-forward updates.
