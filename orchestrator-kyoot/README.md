# Bash Workbench orchestrator

The sole production process engine for the live Workbench on `8010`. Normal agents and dynamic workflow tasks both use the bundled agent runtime. There is no supervisor socket or legacy process-engine fallback.

## Runtime guarantees

- Durable, versioned run records and restart recovery
- Atomic and serialized persistence
- Persistent bounded worker queue
- Multiple concurrent Pi RPC sessions through the bundled agent runtime
- Per-run follow-up and compaction admission locks
- Structured cancellation and process-group cleanup
- Direct typed RPC and revision-sync publication
- Independent active-agent and cold-start admission controls

Production permits three active normal agents by default and admits cold Pi starts four seconds apart. Configure these independent controls with `BASH_WORKBENCH_MAX_AGENTS` and `BASH_WORKBENCH_START_SPACING_MS`.

## Development

The parent Workbench pins Node through its root `mise.toml` and installs this package as part of one npm workspace.

```bash
cd ..
~/.local/bin/mise install
~/.local/bin/mise exec -- npm ci
mise exec -- npm run check:all
```

`test/real-parallel-pi.ts` and `test/manual-five-agents.ts` are explicit integration probes, not part of the ordinary test suite. They require the active Bash.tv entitlement environment.

The five-agent probe uses five scheduler workers and one outer `Emit.forEach` observer. It has verified five successful `bashtv/free` Pi RPC turns, 85 tagged/interleaved Pi events, and clean process teardown in 8.84 seconds. Cold starts are staggered by 1.5 seconds: starting all five Node/Pi runtimes in the same millisecond caused an I/O storm on this small VM before any agent emitted `agent_start`.

## Dynamic workflows

The workflow engine supports durable DAGs, fan-out/join, dynamic task expansion, retries, timeouts, fail-fast or continue policies, per-workflow and global concurrency, cold-start spacing, keyed task/workflow cancellation, restart recovery, and replayable cursor-based events.

Pi planner tasks can append validated work by returning a fenced JSON array:

````markdown
```workflow_tasks
[
  {
    "id": "review-auth",
    "project": "bash-workbench",
    "prompt": "Review authentication",
    "dependsOn": ["planner"]
  }
]
```
````

Workflow progress and control use the authenticated typed `workflows.*` RPC procedures and `workflows/*` sync mutations. The browser facade and WebMCP adapter expose workflow collections, control methods, cursor replay, and reconnecting watch iterators through that single application API. The obsolete parallel REST/SSE and private workflow CLI transports were removed.

## Status

The bundled engine owns both ordinary agents and dynamic workflows. The legacy supervisor and Unix socket have been removed. All package dependencies resolve from this Workbench workspace, and runtime helper paths resolve relative to source via `import.meta.url`.
