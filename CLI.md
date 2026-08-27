# Bash Workbench CLI

The CLI is the main control interface for coding agents inside a Bash.tv
space. It uses the same typed Workbench operations and validated platform
operation catalog as the browser. Agents do not need custom JavaScript or HTTP
requests for routine work.

## Start

`bootstrap.sh install` creates `bash-workbench` and the short `bw` alias. The
default server is `http://127.0.0.1:8010`. The CLI reads the local control token
silently when protected access is active. It never prints the token.

```text
--url URL
--project PROJECT_ID
--timeout MILLISECONDS
--compact
--raw
```

Normal results are JSON. Use `--compact` for one-line JSON. Use `--raw` for
file content, command output, and diffs.

## Discover the Workbench

```bash
bw status
bw projects list
bw op list
bw op describe workbench_exec
```

`op list` comes from the platform operation catalog. `op call` gives access to
every catalog operation. `rpc` gives access to every typed procedure.

```bash
bw op call workbench_vm_info --input '{}'
bw op call workbench_fs_mutate --file input.json
bw rpc runs.get --input '{"id":"RUN_ID"}'
```

## Runs

```bash
bw runs list [--project ID] [--status running,queued] [--limit 50]
bw runs get RUN_ID [--events] [--limit 500]
bw runs create --project ID --title "Title" --prompt "Task"
bw runs create --project ID --prompt-file prompt.md
bw runs message RUN_ID --message "Continue with the tests"
bw runs stop RUN_ID
bw runs compact RUN_ID
bw runs events RUN_ID --tail 50
bw runs events RUN_ID --after CURSOR --limit 100
bw runs watch RUN_ID
bw runs wait RUN_ID
```

`watch` writes one JSON event per line. It exits when the run is complete.
`wait` returns the final run record. Use `--wait-timeout` and `--interval` to
change their limits.

## Workflows

```bash
bw workflows create --file workflow.json
bw workflows list
bw workflows get WORKFLOW_ID
bw workflows events WORKFLOW_ID --after 0
bw workflows wait WORKFLOW_ID
bw workflows add-tasks WORKFLOW_ID --file tasks.json
bw workflows cancel-task WORKFLOW_ID TASK_ID
bw workflows retry-task WORKFLOW_ID TASK_ID
bw workflows cancel WORKFLOW_ID
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
bw live info
bw live messages --limit 100
bw trajectory list --limit 100
bw trajectory list --query "apply patch"
bw trajectory get EVENT_ID
```

Trajectory lists contain small summaries. Full text, arguments, and results
load only for one selected event.

## Files and search

```bash
bw files tree --project ID [--path src]
bw files read --project ID src/index.ts --raw
bw files write --project ID src/index.ts --file replacement.ts
bw files search --project ID --query index
bw files grep --project ID --query "TODO" --include "src/**"
bw files grep --project ID --query "foo.+bar" --regex --context 2
bw files patch --project ID --file change.patch
bw files patch --project ID --file change.patch --dry-run
```

Use `-` instead of a file name to read from standard input.

Filesystem operations use project-relative paths:

```bash
bw fs mkdir --project ID tmp/output
bw fs copy --project ID source.txt copy.txt
bw fs move --project ID old.txt archive/old.txt
bw fs delete --project ID generated --recursive --confirm
bw fs chmod --project ID script.sh --mode 0755
bw fs symlink --project ID link --destination target
```

## Git

```bash
bw git status --project ID
bw git log --project ID --limit 20
bw git diff --project ID [--cached] [--ref REF] --raw
bw git stage --project ID path/to/file another/file
bw git commit --project ID --message "Commit message"
bw git branch --project ID feature/name --create
bw git fetch --project ID
bw git pull --project ID --confirm
bw git push --project ID --confirm
```

Pull and push require `--confirm`.

## Commands and managed processes

```bash
bw exec --project ID -- npm test
bw exec --project ID --cwd packages/app -- npm run build

bw process start --project ID -- npm run dev
bw process list
bw process read PROCESS_ID
bw process follow PROCESS_ID
bw process write PROCESS_ID --text $'\003'
bw process stop PROCESS_ID
bw process stop PROCESS_ID --force
```

## Artifacts and snapshots

```bash
bw artifact export --project ID --format zip --name source
bw artifact list
bw artifact download ARTIFACT_ID
bw artifact import ARTIFACT_ID --project ID --dry-run
bw artifact import ARTIFACT_ID --project ID --confirm
bw artifact delete ARTIFACT_ID --confirm

bw snapshot create --project ID --name before-refactor
bw snapshot list --project ID
bw snapshot restore SNAPSHOT_ID --project ID --confirm
```

## VM inspection

```bash
bw vm info
bw vm ports
bw vm ps --limit 100
```

These commands do not return process environments or credential values.
