# Workbench correction status

Updated 2026-08-27 after phased implementation and independent subagent review.

## Phase 1 — Protect VM access

Status: core complete.

Implemented one server authorization policy boundary for RPC, sync, streams, project bytes, artifacts, runs, workflows, files and platform operations. Because this experimental Bash.tv environment cannot securely configure participant secrets, the distribution currently defaults to an explicitly labeled `open-experimental` mode that grants every visitor owner-equivalent access. Set `BASH_WORKBENCH_AUTH_REQUIRED=1` to restore the retained protected mode: owner uses the existing private control credential, configured collaborators use `BASH_WORKBENCH_COLLABORATOR_TOKENS`, browser credentials exchange into an HttpOnly/Secure/SameSite session, and cookie mutations receive origin checks. No credential is disclosed by open mode. Child commands use an explicit allowlisted environment. Audit values are redacted and bounded. Project mutations reject traversal and symlink escapes.

Remaining hardening for protected deployments: include principal identity/role in every audit event.

## Phase 2 — VM platform operations

Status: major correctness work complete.

Implemented independent stdout/stderr cursors, bounded output, process record/output retention, process terminal states and shutdown cleanup, artifact expiry/size/storage/checksum/MIME enforcement, safe archive staging and validation, truthful versioned worktree-plus-Git-bundle snapshots, restoration tests, and accurate typed content search with literal/regex, globs, context, binary/file-size exclusion, timeout and truncation. Filename fuzzy search remains separate for quick-open. Shell descriptions explicitly state authorized VM-wide behavior.

Request AbortSignal now reaches typed platform/content-search operations and kills complete subprocess groups with TERM/KILL escalation; direct grandchild and typed RPC cancellation tests pass. Managed-process retention now uses an injectable clock/options and has deterministic expiry, oldest-completed eviction, running-record preservation, and active-overflow tests. No known Phase 2 correctness item remains beyond broader long-duration soak testing.

## Phase 3 — Incremental run storage

Status: core complete.

Run summaries are version 3 and exclude events. Events append to `events.jsonl` with monotonic sequence and cursor pagination. Version 1/2 data migrates without loss. Large event payloads and final output become checksummed, bounded, expiring run artifacts with compact references. Restart, migration, retention and checksum tests pass.

Remaining: batch summary writes during extreme event bursts and expose an authenticated byte endpoint if users need to download run artifacts directly.

## Phase 4 — Incremental Live Chat

Status: core complete.

The server caches the selected Pi session file and parses only appended JSONL bytes during normal updates. Typed `live.page` cursor reads provide reset/more/completion. The frontend uses backoff, resume, deduplication and incremental DOM append rather than the former four-second full-session rerender. The controller has focused reset/reconnect/duplicate/disposal tests.

Remaining: a two-real-browser observer test and server push/long-poll if lower latency is required.

## Phase 5 — Startup performance

Status: safe target complete.

Editor, Markdown, trajectory and workflow adapters are dynamic imports and absent from the service-worker shell precache. Static text assets use gzip. API/private data is never service-worker cached. Cache version is 45. Measurements are recorded in `PERFORMANCE.md`.

Generated JS entries now have deterministic content-hashed names, an asset manifest, immutable one-year cache headers, logical compatibility URLs, stale-hash cleanup, and deployment tests. Remaining: stable main-thread timing under a non-experimental browser harness.

## Phase 6 — Typed operation catalog

Status: platform catalog complete.

All 26 platform operations, including content search, derive WebMCP names/descriptions/schemas/policy/limits/annotations and server implementation mapping from one strict catalog. Unknown operations, fields, types, ranges and enums are rejected. Browser store exposes catalog-validated `invokePlatform` rather than unchecked public string dispatch. Non-platform run/workflow RPC contracts remain typed in `@kyoot/workbench-protocol`.

Remaining: generate the TypeScript operation-name union instead of maintaining its declaration alongside the runtime catalog; decide whether to deprecate the redundant run-spawn alias after external compatibility review.

## Phase 7 — Frontend simplification

Status: in progress.

Authentication, Live Chat, agent runs, Files/editor, and Git route logic are dedicated tested modules. Optional workflow and trajectory modules are lazy. `app.js` fell from about 54 KB to about 32 KB during extraction. Generated-source drift checking is authoritative. Four override-only CSS files were consolidated into owning feature stylesheets and removed after reference/visual review.

Remaining: split the remaining application shell/palette/project-download code only where useful; continue screenshot-characterized consolidation of the larger CSS layers without visual redesign.

## Phase 8 — Duplicate transports and dead code

Status: one proven duplicate transport family removed.

Removed workflow REST/SSE, private workflow CLI, obsolete service template and associated tests/docs. Typed RPC/sync/WebMCP are supported. Bootstrap verification authenticates without printing credentials.

A repository reachability audit found no remaining obsolete service, supervisor, workflow HTTP/CLI, or old query-cache files. All vendored Kyoot packages have active imports/tests/documentation, so none were deleted speculatively. npm audit reports zero vulnerabilities after overriding Page.js's vulnerable transitive `path-to-regexp` to compatible patched 1.9.0.

## Phase 9 — Focused tests

Status: substantially expanded.

Coverage now includes authorization/session/origin, environment filtering, traversal/symlinks, cursors/Unicode/process lifecycle, artifact checksums, malicious ZIP/tar extraction, snapshot restoration, typed content search, operation catalog validation/registration, run journal migration/artifacts/retention, and Live Chat reset/backoff/deduplication/disposal.

Real Chrome verified the protected policy lifecycle: anonymous WebMCP discovers no tools and an authenticated browser registers 48 tools and executes bounded shell. Open-experimental HTTP/browser acceptance verifies anonymous RPC access, automatic startup without the dialog, and a persistent visible warning. A real Chrome WebMCP acceptance test now creates a short-lived external agent and proves it appears without reload in an already-connected Agents page; a two-client typed integration test covers the underlying RPC-to-sync publication. Editor lazy-load was verified: absent on fresh Live, loaded on file open. Managed-process virtual-time expiry/overflow tests are complete. Remaining: two-browser Live Chat observation.

## Next precise continuation point

1. Add two-browser incremental Live Chat observation/reconnect coverage.
2. Measure stable main-thread startup timing under a non-experimental browser harness.
3. Continue splitting the remaining application shell/palette code only where cohesion improves.
4. Continue screenshot-characterized consolidation of larger CSS feature layers.
5. Run long-duration process/artifact/run-retention soak tests.
