# One-prompt Bash.tv Space Setup

Paste the prompt below into a new Bash.tv coding-agent session.

````text
Start the latest Bash Workbench from this repository:

https://github.com/saiashirwad/bash-tv-workbench.git

Use `/home/bashtv/workbench` as the destination. Do only the steps below. Do not describe routine work.

1. If the destination does not exist, clone the `main` branch into it.
2. If the destination is a clean Git checkout with the same remote, fetch `origin main` and use a fast-forward-only update.
3. If the destination has local changes, a different remote, or a non-fast-forward update, stop. Give one short error. Do not delete, reset, or overwrite files.
4. In `/home/bashtv/workbench`, run:

   ```bash
   bash ./bootstrap.sh install
   ```

   This installs the agent CLI as `$HOME/.local/bin/bash-workbench` and the short `$HOME/.local/bin/bw` alias. After setup, use `$HOME/.local/bin/bw --help` or read `/home/bashtv/workbench/CLI.md` for commands that control runs, workflows, files, Git, processes, artifacts, snapshots, and the VM.

5. Start this command with the Bash.tv coding tool's persistent detached or tmux mode. Do not set a timeout:

   ```bash
   bash ./bootstrap.sh serve
   ```

   Do not use `&`, `nohup`, or systemd. Use the default experimental open-access mode. Do not set `BASH_WORKBENCH_AUTH_REQUIRED`.
6. Run `$HOME/.local/bin/bw status --wait`. This command waits until `http://127.0.0.1:8010/api/health` reports `ok: true`, or exits after 60 seconds. Do not run other CLI commands during setup.
7. Call `open_preview` for port `8010`.
8. Reply with exactly this text:

   your workbench is running!

Do not use browser automation. Do not click through the Workbench. Do not test files or downloads. Do not run `verify`, `verify --live`, an agent probe, port surveys, process checks, supervisor checks, or other acceptance tests.

Never inspect, print, copy, or save Bash.tv credentials or entitlement values. Do not modify Bash.tv platform services or internal files. Leave ports `7890`, `8012`, and `8020` unchanged.
````
