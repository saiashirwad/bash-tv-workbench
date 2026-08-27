# @kyoot/workbench-protocol

Shared typed contracts for incrementally moving Bash Workbench behind `@kyoot/rpc` and `@kyoot/sync`.

Replicated collections:

- Runs
- Registered project summaries
- Durable workflow snapshots and nested task summaries

On-demand RPC queries:

- File trees and contents
- Search
- Git commits and diffs

The package contains no server implementation and no credentials. `@kyoot/workbench-protocol/browser` exposes a `WorkbenchStore`: UI code subscribes to `runs` and `projects`, sends typed mutations, and reads file/Git query objects without handling Fetch, RPC envelopes, revisions, or cache invalidation directly.

The browser store also exposes workflow creation, dynamic task addition, keyed cancellation/retry, cursor replay, and reconnecting collective or task-filtered event streams.

Every collection mutation has a built-in optimistic projection: run creation/follow-up/compaction/stop and workflow creation/add/cancel/task-cancel/task-retry. File writes optimistically replace their keyed query value and exactly restore the previous query state on rejection. Components never construct or sequence overlays themselves.

Browser distributions can prebuild this package to native ESM and commit the generated asset, preserving the workbench's zero-build runtime. Existing REST routes remain useful as rollback compatibility during screen-by-screen migration.
