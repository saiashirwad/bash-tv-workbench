Work in the current BashTV Workbench project. Implement the corrections below.

BashTV is a shared vibe-coding site. Friends work together inside one VM. This Workbench extends the built-in Pi agent and gives authorized users access to coding runs, projects, files, Git, shell commands, processes, ports, artifacts, workflows, and WebMCP.

The Bash team has approved full VM access for this integration.

The product must support this access model:

- The workspace owner and authorized collaborators can control the VM.
- Anonymous users and public preview visitors cannot read secrets or mutate the VM.
- Authorized shell sessions can use the full VM.
- Project-scoped file tools must stay inside their declared project.
- The browser UI and WebMCP must use the same authorization rules.
- Workflows are an optional feature built on top of the core Workbench.
- Preserve the current user experience unless a change is needed for security, correctness, or clear performance improvement.

You have approval to edit the code, add tests, remove proven dead code, rebuild generated assets, and run all relevant checks. Preserve unrelated user changes. Do not reset or overwrite existing work.

Do not stop after writing another review. Make the changes.

Use small, coherent commits if Git is available. Keep the project working after each phase. If one phase becomes too large, finish a safe vertical slice and record the remaining work.

## Product structure

Move the code toward these modules. Use different names only if the existing domain model provides clearer terms.

### PiRuns

This module owns:

- creating runs
- resuming runs
- cancelling runs
- run status
- run summaries
- run events
- tool results
- run artifacts

### ProjectWorkspace

This module owns:

- project discovery
- file operations
- content search
- Git operations
- shell execution
- managed processes
- ports
- snapshots
- imports and exports
- artifacts

### WorkbenchState

This module owns:

- authorization
- durable state
- event journals
- synchronization
- operation auditing
- retention rules

### Adapters

The browser UI and WebMCP are adapters. They must call the same typed application operations. They must not contain separate copies of business rules or schemas.

### Workflows

DAG workflows are optional orchestration. They must use the core run and workspace modules. Do not let workflow-specific code control the design of basic coding runs.

## Phase 1: Protect VM access

This phase is the first priority.

### Establish one authorization boundary

Create one server-side authorization layer for every operation that can:

- execute a command
- start or stop a process
- read or write a file
- inspect environment or system information
- use Git
- create or restore a snapshot
- import or export a project
- read or create an artifact
- create, resume, or cancel a run
- mutate workflow state

Do not protect only workflow operations. Apply the same rules to the generic platform operation endpoint and every direct HTTP, RPC, SSE, and WebMCP path.

Use the existing workspace identity or token system when possible. Do not add a second unrelated authentication system.

Return a clear unauthorized or forbidden error before the requested operation starts.

### Access roles

At minimum, support these effective roles:

- Owner: full VM and Workbench access
- Collaborator: full access when the workspace has explicitly granted it
- Viewer or anonymous visitor: no VM mutation and no secret-bearing data

If the existing product has different role names, map them to these capabilities.

Keep authorization decisions on the server. UI hiding is not access control.

### Shell environment

Authorized shell commands can use the VM, but do not pass every server environment variable by default.

Build an explicit child-process environment. Include normal runtime variables such as PATH, HOME, SHELL, locale, terminal settings, and required project variables. Exclude server credentials, authentication tokens, API secrets, signing keys, and internal platform values unless a command explicitly needs one.

Add a documented allowlist or controlled configuration for extra variables.

Never return the complete server environment through errors, logs, process metadata, or system information tools.

### File boundaries and symlinks

For project-scoped file tools:

- resolve the project root to its real path
- resolve the target or its nearest existing parent to its real path
- reject symlink escapes
- reject traversal outside the project
- apply the check to reads, writes, patches, search, export, import, and snapshots

Shell access is intentionally VM-wide for authorized users. Do not pretend that the shell is project-confined. Make this difference explicit in tool names, descriptions, and documentation.

### Audit safety

Keep useful operation records, but do not store secrets.

Redact:

- authorization headers
- cookies
- tokens
- passwords
- private keys
- secret environment values
- signed artifact URLs
- secret-looking command arguments when they match known credential formats

Set a retention limit for audit records.

### Security tests

Add tests that prove:

- an anonymous caller cannot execute a command
- an anonymous caller cannot use WebMCP mutation tools
- an anonymous caller cannot read protected files or artifacts
- an authorized owner can execute a command
- an authorized collaborator can execute a command when access is granted
- authorization applies to each transport
- a project-scoped tool rejects `..` escapes
- a project-scoped tool rejects symlink escapes
- child processes do not inherit a test secret
- logs and errors do not expose the test secret

Do not continue to later refactors if these tests fail.

## Phase 2: Fix the VM platform operations

Create a typed service interface for platform operations. Each operation must have:

- a stable operation name
- an input schema
- an output schema
- authorization requirements
- scope information
- size limits
- timeout behavior
- error codes
- a short user-facing description

Do not use an unchecked string plus an untyped object as the main internal API.

### Command execution

For one-shot command execution:

- support a timeout
- support an explicit working directory
- report exit code, signal, stdout, and stderr
- cap captured output
- report when output was truncated
- cancel the child process when the request is cancelled
- avoid shell use when an argument-based process call is sufficient
- keep shell execution as an explicit operation because it is a required product feature

### Managed processes

Fix managed-process retention.

- Remove completed process records after a configurable time.
- Add a maximum record count.
- Add a maximum retained-output size per process.
- Use a ring buffer or bounded chunks for output.
- Make stop and kill behavior idempotent.
- Distinguish running, exited, failed, killed, and expired records.
- Clean up child processes when the Workbench shuts down when safe to do so.

### Output cursors

Replace the current ambiguous output cursor.

Use one of these designs:

- a sequence-numbered stream of stdout and stderr chunks, or
- separate stdout and stderr cursors

Do not calculate one cursor from a combined JSON length and then use it to slice separate strings.

A client must be able to request output after a cursor without receiving missing or duplicated bytes.

Add tests for interleaved stdout and stderr, Unicode output, truncation, multiple reads, and process completion.

### File content search

Make the search tool match its description.

If it says that it searches source content, it must search file contents. Use a safe implementation such as ripgrep where available.

Support:

- query text or regular expression
- include and exclude patterns
- result limits
- file size limits
- binary-file exclusion
- line number and short matching context
- cancellation and timeout
- a clear result when the search is truncated

If filename search is still useful, make it a separate operation with an accurate name.

### Snapshots

Make snapshot behavior truthful and restorable.

The current archive approach must not claim to include Git metadata if it only includes tracked worktree files.

Choose one clear design:

- worktree snapshot plus a Git bundle and status metadata, or
- worktree-only snapshot with an accurate description

Record:

- commit identity
- current branch
- dirty-file status
- untracked-file policy
- ignored-file policy
- archive checksum
- creation time
- format version

Test restoration into a temporary project.

Do not archive a live `.git` directory without a safe, tested reason.

### Artifacts

Enforce artifact expiration when an artifact is listed, read, downloaded, or restored.

Add:

- expiry checks
- maximum artifact size
- per-workspace storage limits
- cleanup of expired data
- content type
- checksum verification
- safe filenames
- authorization checks

Expired artifacts must not remain downloadable.

### Import and export

Protect archive extraction against:

- absolute paths
- `..` traversal
- symlink escapes
- device files
- excessive file counts
- excessive expanded size
- archive bombs

Extract into a temporary location, validate it, and then move it into the destination.

## Phase 3: Make run storage incremental

Do not rewrite and synchronize the complete run after every event.

Split persisted run data into:

### Run summary

Store small current-state fields:

- run ID
- project ID
- title
- status
- timestamps
- active agent
- latest event sequence
- compact result summary
- error summary
- artifact references

### Event journal

Store run events as an append-only journal.

Each event must have:

- run ID
- monotonically increasing sequence number
- event type
- timestamp
- compact payload
- optional artifact references

Do not store large file contents or large command output directly in the run summary. Put large values in bounded artifacts and store references.

### Incremental reads

Add an API that reads events after a sequence cursor.

The response must include:

- events after the cursor
- the next cursor
- whether more events are available
- run completion state
- a reset indication if retained history no longer contains the requested cursor

Batch durable synchronization when possible. A burst of small events must not clone and serialize the complete run many times.

### Existing data

Preserve existing runs.

Add a versioned reader or a one-time migration for the old format. Do not silently discard old run history.

### Tests

Test:

- event order
- cursor pagination
- restart recovery
- concurrent event appends
- large tool results
- artifact references
- old-format reads
- terminal run state
- cancellation
- retention behavior

## Phase 4: Stop full-session polling and rendering

Replace repeated full session scans with incremental updates.

Prefer an authenticated event stream or an existing typed subscription mechanism. If streaming is not reliable in the hosting environment, use cursor-based long polling.

The client must:

- load the current run summary once
- request only events after its last cursor
- append new message elements
- update only changed status elements
- render Markdown only for new or changed messages
- reconnect with backoff
- resume from its last cursor
- detect when a full refresh is required

The server must not scan every session directory and parse every complete JSONL file every few seconds.

Keep a small compatibility endpoint only if an active caller still needs it. Remove it after callers move to the incremental API.

Add tests for reconnect, missed events, duplicate delivery, terminal state, and two browser clients observing the same run.

## Phase 5: Reduce page startup cost

Measure the current first load before changing it. Record:

- transferred JavaScript bytes
- transferred CSS bytes
- request count
- main-thread parse and execution time if measurable
- time until the main chat or project interface is usable

Then make these changes.

### Lazy-load heavy features

Do not load the code editor until the user opens a file or editor route.

Do not load the full Markdown stack until content needs it. If the first screen always contains Markdown, load only the minimum renderer needed for that screen.

Lazy-load:

- editor
- advanced Markdown features
- workflow editor
- trajectory or run-inspection views
- large project management views

The initial application shell must contain only navigation, session state, the current lightweight view, and the code needed to request its data.

### Compression and cache policy

Serve compressible static assets with Brotli or gzip when the hosting layer does not already do it.

Use content-hashed filenames or another reliable version strategy for immutable assets.

Use suitable cache headers for versioned static assets. Do not apply `no-store` to every static asset unless the platform requires it.

Keep HTML and sensitive API responses on an appropriate no-cache policy.

### Service worker

Do not precache the complete editor bundle or every optional feature.

Precache only the small application shell and offline-safe static resources. Fetch large optional chunks when needed.

Use a new cache version during deployment. Remove obsolete caches safely.

Do not cache authenticated API responses, tokens, artifacts, command output, or private project data.

### Acceptance targets

Use measurements from the current build as the baseline.

At minimum:

- the editor bundle is absent from the initial route
- optional workflow code is absent from the initial route
- static JavaScript and CSS use compression
- the initial transferred asset size decreases substantially
- the main route still works with a cold cache
- offline or service-worker behavior does not expose private data

Report before-and-after measurements.

## Phase 6: Create one typed WebMCP operation catalog

Create one shared source of truth for all Workbench operations.

The catalog must define:

- operation name
- input type and runtime schema
- output type and runtime schema
- authorization capability
- project or VM scope
- timeout and size limits
- tool description
- whether the operation is read-only or mutating
- whether user confirmation is appropriate

Generate or derive these from the catalog:

- server dispatch validation
- WebMCP tool registration
- TypeScript client types
- user-facing tool descriptions
- test cases or test fixtures where practical

Reject unknown fields when that improves safety. Return structured validation errors.

Remove the generic unchecked dispatch path after all callers use the typed catalog.

### Tool quality

Review every exposed WebMCP tool.

For each tool:

- confirm that it works
- confirm that its description is accurate
- confirm that its scope is clear
- add input limits
- add output limits
- add authorization tests
- remove exact aliases that add no value

Remove the redundant run-creation alias if no external caller requires it. If compatibility is required, mark it deprecated and route it through the same typed operation.

Do not expose internal implementation helpers as public tools.

## Phase 7: Simplify the frontend

Split the large frontend application by route or feature.

Suggested modules:

- application shell and routing
- run/chat view
- project browser
- file editor
- Git view
- process and port view
- artifact view
- workflow view
- WebMCP adapter
- shared API client
- shared state

Keep business rules out of DOM rendering modules.

### State updates

Use a small state model with explicit events. Avoid unrelated global mutable state.

A run event must update only the state and DOM that it affects.

### CSS cleanup

The current CSS has accumulated many fixes and overrides.

Perform the cleanup carefully:

1. Identify the final computed styles for each active screen.
2. Find selectors that are fully overridden or no longer used.
3. Remove dead rules.
4. Merge navigation, layout, chat, editor, and workflow rules into clear feature stylesheets.
5. Reduce `!important` use.
6. Remove files that contain only old fixes after their active rules move to the correct stylesheet.
7. Build one versioned CSS asset, or a small set of route-based CSS chunks.

Do not redesign the product during this cleanup. Take screenshots or run visual tests for the main screens before and after the change.

Test at desktop and narrow viewport sizes.

### Generated assets

Find which files are source files and which files are generated output.

Make the build process authoritative. Do not maintain the same implementation manually in source and generated files.

Add a check that fails when committed generated assets do not match the source build, if generated assets must remain committed.

## Phase 8: Remove duplicate transports and dead code

Trace actual imports, runtime entry points, package references, scripts, and documented use before deleting code.

Look for:

- duplicate workflow RPC, REST, SSE, CLI, and WebMCP implementations
- unused vendored AI or platform packages
- obsolete service definitions
- stale workspace files
- setup scripts with no active caller
- old examples
- duplicate aliases
- compatibility layers that no supported client uses

Use one main typed application API. Keep an event transport only where live updates need it.

Remove code only when:

- no runtime entry point uses it
- no test requires it for valid behavior
- no package imports it
- no supported external contract requires it

Update package manifests, workspace configuration, scripts, documentation, and tests after removal.

Do not leave commented-out replacements or “legacy” directories.

## Phase 9: Add focused tests

The VM platform module needs direct tests. Add unit and integration coverage for:

- authorization
- environment filtering
- command timeout
- command cancellation
- output truncation
- process lifecycle
- process expiry
- output cursors
- file reads and writes
- patch application
- traversal rejection
- symlink rejection
- content search
- Git status and common Git operations
- snapshot creation and restoration
- artifact checksum and expiry
- safe archive extraction
- port listing
- typed operation validation
- WebMCP registration
- run event pagination
- synchronization after restart

Use temporary directories and temporary repositories. Do not depend on a developer’s personal files or global Git configuration.

Add a small browser end-to-end suite for:

- loading the main page
- opening a project
- starting a run
- receiving incremental output
- reconnecting to a run
- opening the editor on demand
- invoking an authorized WebMCP tool
- rejecting an unauthorized WebMCP call

## Engineering rules

Follow these rules throughout the work:

- Keep interfaces smaller than their implementations.
- Put policy in one place.
- Prefer typed operations over string dispatch.
- Prefer append-only events over whole-object rewrites.
- Prefer bounded data structures over unlimited memory retention.
- Prefer accurate narrow tools over broad tools with misleading descriptions.
- Do not add a large framework only to solve module organization.
- Do not preserve dead abstractions for possible future use.
- Do not introduce compatibility layers unless a current caller needs them.
- Do not weaken full VM access for authorized users.
- Do not expose full VM access to unauthenticated users.
- Do not change unrelated product behavior.
- Do not hide test failures.
- Do not claim success without running the relevant checks.

## Verification after each phase

After each phase:

1. Run type checks.
2. Run syntax and formatting checks.
3. Run unit and integration tests.
4. Build the frontend.
5. Confirm that generated files are current.
6. Check the working tree for unexpected changes.
7. Test the affected behavior through the browser or WebMCP.
8. Record what changed and any measured result.

Run the complete project check at the end. Also run the orchestrator test suite.

## Final response

When the work is complete, report:

- the core architecture that now exists
- the security boundary
- the main correctness fixes
- the performance measurements before and after
- the transports and aliases removed
- the packages and files removed
- new tests
- all verification commands and results
- remaining risks
- any migration or deployment steps

List changed files by repository-relative path only.

If you cannot finish every phase in one run, complete the highest-priority safe phases first. Leave the repository in a working state. State exactly which phases remain and give the next agent a precise continuation point.
