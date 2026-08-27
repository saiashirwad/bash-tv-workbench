# Bash Workbench CLI

The CLI is the main control interface for coding agents inside a Bash.tv
space. It uses the same typed Workbench operations and validated platform
operation catalog as the browser. Agents do not need custom JavaScript or HTTP
requests for routine work.

## Start

`bootstrap.sh install` creates `bash-workbench` and the short `bw` alias in
`$HOME/.local/bin`. Bash.tv does not always add this directory to `PATH`. Use
the full `$HOME/.local/bin/bw` path in agent commands. The default server is
`http://127.0.0.1:8010`. The CLI reads the local control token silently when
protected access is active. It never prints the token.

```text
--url URL
--project PROJECT_ID
--timeout MILLISECONDS
--compact
--raw
```

Normal results are JSON. Use `--compact` for one-line JSON. Use `--raw` for
file content, command output, and diffs.

Boolean options can be before or after the command. Use `--help` after a group
or command to show only the applicable options.

## Discover the Workbench

```bash
$HOME/.local/bin/bw status
$HOME/.local/bin/bw status --wait
$HOME/.local/bin/bw projects list
$HOME/.local/bin/bw op list
$HOME/.local/bin/bw op describe workbench_exec
```

`op list` comes from the platform operation catalog. `op call` gives access to
every catalog operation. `rpc` gives access to every typed procedure.

```bash
$HOME/.local/bin/bw op call workbench_vm_info --input '{}'
$HOME/.local/bin/bw op call workbench_fs_mutate --file input.json
$HOME/.local/bin/bw rpc runs.get --input '{"id":"RUN_ID"}'
```

## Runs

```bash
$HOME/.local/bin/bw runs list [--project ID] [--status running,queued] [--limit 50]
$HOME/.local/bin/bw runs get RUN_ID [--events] [--limit 500]
$HOME/.local/bin/bw runs create --project ID --title "Title" --prompt "Task"
$HOME/.local/bin/bw runs create --project ID --prompt-file prompt.md
$HOME/.local/bin/bw runs batch --file runs.json [--concurrency 10] [--full]
$HOME/.local/bin/bw runs message RUN_ID --message "Continue with the tests"
$HOME/.local/bin/bw runs stop RUN_ID
$HOME/.local/bin/bw runs compact RUN_ID
$HOME/.local/bin/bw runs events RUN_ID --tail 50
$HOME/.local/bin/bw runs events RUN_ID --after CURSOR --limit 100
$HOME/.local/bin/bw runs watch RUN_ID
$HOME/.local/bin/bw runs wait RUN_ID
```

`watch` writes one JSON event per line. It exits when the run is complete.
`wait` returns the final run record. Use `--wait-timeout` and `--interval` to
change their limits.

Use `runs batch` to start independent agents in parallel. The input is an array
of run requests. The command returns small run records by default.

```json
[
  {
    "project": "bash-workbench",
    "title": "Weather in Prague",
    "prompt": "Find the current weather in Prague."
  },
  {
    "project": "bash-workbench",
    "title": "Weather in Mumbai",
    "prompt": "Find the current weather in Mumbai."
  }
]
```

## Workflows

```bash
$HOME/.local/bin/bw workflows create --file workflow.json
$HOME/.local/bin/bw workflows list
$HOME/.local/bin/bw workflows get WORKFLOW_ID
$HOME/.local/bin/bw workflows events WORKFLOW_ID --after 0
$HOME/.local/bin/bw workflows wait WORKFLOW_ID
$HOME/.local/bin/bw workflows add-tasks WORKFLOW_ID --file tasks.json
$HOME/.local/bin/bw workflows cancel-task WORKFLOW_ID TASK_ID
$HOME/.local/bin/bw workflows retry-task WORKFLOW_ID TASK_ID
$HOME/.local/bin/bw workflows cancel WORKFLOW_ID
```

Example workflow file:

```json
{
  "title": "Check and repair",
  "maxConcurrency": 2,
  "failurePolicy": "fail-fast",
  "tasks": [
    {
      "id": "inspect",
      "project": "bash-workbench",
      "prompt": "Inspect the failure and report the cause"
    },
    {
      "id": "repair",
      "project": "bash-workbench",
      "prompt": "Apply the repair and run focused checks",
      "dependsOn": ["inspect"]
    }
  ]
}
```

## Live session and Trajectory

```bash
$HOME/.local/bin/bw live info
$HOME/.local/bin/bw live messages --limit 100
$HOME/.local/bin/bw trajectory list --limit 100
$HOME/.local/bin/bw trajectory list --query "apply patch"
$HOME/.local/bin/bw trajectory get EVENT_ID
```

Trajectory lists contain small summaries. Full text, arguments, and results
load only for one selected event.

## Files and search

```bash
$HOME/.local/bin/bw files tree --project ID [--path src]
$HOME/.local/bin/bw files read --project ID src/index.ts --raw
$HOME/.local/bin/bw files write --project ID src/index.ts --file replacement.ts
$HOME/.local/bin/bw files search --project ID --query index
$HOME/.local/bin/bw files grep --project ID --query "TODO" --include "src/**"
$HOME/.local/bin/bw files grep --project ID --query "foo.+bar" --regex --context 2
$HOME/.local/bin/bw files patch --project ID --file change.patch
$HOME/.local/bin/bw files patch --project ID --file change.patch --dry-run
```

Use `-` instead of a file name to read from standard input.

Filesystem operations use project-relative paths:

```bash
$HOME/.local/bin/bw fs mkdir --project ID tmp/output
$HOME/.local/bin/bw fs copy --project ID source.txt copy.txt
$HOME/.local/bin/bw fs move --project ID old.txt archive/old.txt
$HOME/.local/bin/bw fs delete --project ID generated --recursive --confirm
$HOME/.local/bin/bw fs chmod --project ID script.sh --mode 0755
$HOME/.local/bin/bw fs symlink --project ID link --destination target
```

## Git

```bash
$HOME/.local/bin/bw git status --project ID
$HOME/.local/bin/bw git log --project ID --limit 20
$HOME/.local/bin/bw git diff --project ID [--cached] [--ref REF] --raw
$HOME/.local/bin/bw git stage --project ID path/to/file another/file
$HOME/.local/bin/bw git commit --project ID --message "Commit message"
$HOME/.local/bin/bw git branch --project ID feature/name --create
$HOME/.local/bin/bw git fetch --project ID
$HOME/.local/bin/bw git pull --project ID --confirm
$HOME/.local/bin/bw git push --project ID --confirm
```

Pull and push require `--confirm`.

## Commands and managed processes

```bash
$HOME/.local/bin/bw exec --project ID -- npm test
$HOME/.local/bin/bw exec --project ID --cwd packages/app -- npm run build

$HOME/.local/bin/bw process start --project ID -- npm run dev
$HOME/.local/bin/bw process list
$HOME/.local/bin/bw process read PROCESS_ID
$HOME/.local/bin/bw process follow PROCESS_ID
$HOME/.local/bin/bw process write PROCESS_ID --text $'\003'
$HOME/.local/bin/bw process stop PROCESS_ID
$HOME/.local/bin/bw process stop PROCESS_ID --force
```

## Artifacts and snapshots

```bash
$HOME/.local/bin/bw artifact export --project ID --format zip --name source
$HOME/.local/bin/bw artifact list
$HOME/.local/bin/bw artifact download ARTIFACT_ID
$HOME/.local/bin/bw artifact import ARTIFACT_ID --project ID --dry-run
$HOME/.local/bin/bw artifact import ARTIFACT_ID --project ID --confirm
$HOME/.local/bin/bw artifact delete ARTIFACT_ID --confirm

$HOME/.local/bin/bw snapshot create --project ID --name before-refactor
$HOME/.local/bin/bw snapshot list --project ID
$HOME/.local/bin/bw snapshot restore SNAPSHOT_ID --project ID --confirm
```

## VM inspection

```bash
$HOME/.local/bin/bw vm info
$HOME/.local/bin/bw vm ports
$HOME/.local/bin/bw vm ps --limit 100
```

These commands do not return process environments or credential values.
