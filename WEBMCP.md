# Bash Workbench WebMCP

## Authorization

The experimental distribution currently defaults to open access: every visitor receives owner-equivalent Workbench and WebMCP access. Set `BASH_WORKBENCH_AUTH_REQUIRED=1` to restore the protected boundary. In protected mode, exchange the existing private Workbench control credential through `/api/auth/session`; browsers receive a 12-hour HttpOnly, Secure, SameSite=Strict session cookie. Non-browser harnesses may send `Authorization: Bearer <credential>` or `X-Workbench-Control`. Configure collaborator credentials with comma-separated `BASH_WORKBENCH_COLLABORATOR_TOKENS`. Browser and WebMCP calls always use the same server-side policy; Bash.tv viewer identity is attribution only.

Shell tools intentionally provide VM-wide access to authorized users. Project file, patch, archive, import, export, and snapshot tools remain realpath-confined to their declared project and reject traversal and symlink escapes. Child commands receive an explicit safe environment. Additional variables must be named in `BASH_WORKBENCH_CHILD_ENV_ALLOWLIST`; server credentials are not inherited by default.

The Workbench registers browser-native WebMCP tools through `document.modelContext` when the browser exposes the current WebMCP API. Normal browsers without WebMCP continue to work unchanged.

## Exposed tools

- `workbench_list_projects`
- `workbench_list_runs`
- `workbench_get_run`
- `workbench_create_run`
- `workbench_message_run`
- `workbench_stop_run`
- `workbench_compact_run`
- `workbench_list_files`
- `workbench_search_files`
- `workbench_read_file`
- `workbench_write_file`
- `workbench_git_info`
- `workbench_list_workflows`
- `workbench_navigate`

Agent tools can spawn durable coding runs and complete multi-agent DAG workflows, inspect workflow state and cursor events, append dynamic tasks, cancel workflows or individual tasks, and retry tasks. `workbench_create_run` and its `workbench_spawn_agent` alias commit through the authoritative run collection, so an already-connected Agents page receives and renders externally created tasks without reload. New WebMCP-created tasks are attributed to `WebMCP`, and the Agents list sorts newest-first to match `workbench_list_runs`. Workflow tasks support dependencies, fan-out/join, retries, timeouts, concurrency limits, and fail-fast or continue policies.

Platform tools add bounded command execution and continuation, managed process start/read/write/stop/list, atomic patch application, project filesystem mutations, safe ZIP/tar.gz export, artifact listing/download/deletion/import, project snapshots, Git diff/stage/commit/branch/sync, listening ports, VM information, and a bounded system process table.

Destructive tools require an explicit `confirm: true`. Browser tools are confined to registered project roots. Home/VM/root scope, preview control, and secret mutation are intentionally not exposed until trusted owner grants and server-side authorization exist; Bash.tv viewer identity alone is not authorization.

The tools reuse the same typed `WorkbenchStore` query cache, sync collections, optimistic mutations, and RPC transport as the visible UI. There is no parallel REST implementation.

Collection tools deliberately return bounded summaries:

- `workbench_list_runs` accepts `project`, `status`, and `limit`; use `workbench_get_run` for transcript details.
- `workbench_list_files` accepts `prefix` and `limit` and reports `total` / `truncated`.
- `workbench_list_workflows` returns bounded workflow summaries.
- Query tools honor WebMCP execution cancellation.
- Unknown project/run IDs reject with explicit errors rather than returning ambiguous empty data.

## Connect a desktop coding harness

WebMCP is a browser API. A desktop MCP client therefore connects through a browser-aware MCP bridge. With a recent Chrome and `chrome-devtools-mcp`, add this MCP server to the coding harness:

```json
{
  "mcpServers": {
    "chrome-devtools": {
      "command": "npx",
      "args": [
        "-y",
        "chrome-devtools-mcp@latest",
        "--category-experimental-webmcp",
        "--chrome-arg=--enable-features=WebMCP"
      ]
    }
  }
}
```

At the time this integration was added, upstream documents the experimental category as requiring Chrome 150 or newer. Open the Workbench HTTPS URL in that Chrome instance. The harness can then discover and invoke the registered page tools through Chrome DevTools MCP.

The bridge exposes `list_webmcp_tools` and `execute_webmcp_tool`. Current releases use page-ID routing by default, so the harness first calls `list_pages`, then passes the selected numeric `pageId` to both WebMCP bridge tools. A cold Workbench page hydrates its Kyoot sync snapshot before registration; wait for the console message `WebMCP ready: 48 Workbench tools`, or retry discovery briefly.

For a manually launched Chrome, start it with WebMCP enabled and a debugging port, then configure the bridge with `--browser-url=http://127.0.0.1:9222`. Browser/bridge flags are evolving while WebMCP remains experimental; use the current `chrome-devtools-mcp` documentation when upgrading Chrome.

## End-to-end verification

With Workbench running on port 8010 and Chrome 150+ available:

```bash
mise exec -- npm run verify:webmcp
# Also create a real short-lived agent and prove it appears in an already-open Agents page:
BASH_WORKBENCH_WEBMCP_AGENT_VISIBILITY=1 mise exec -- npm run verify:webmcp
```

The verifier launches the real `chrome-devtools-mcp` stdio server, opens Chrome with native WebMCP enabled, navigates to Workbench, discovers all page tools through the DevTools WebMCP domain, and invokes `workbench_list_projects`.

Override the defaults when needed:

```bash
BASH_WORKBENCH_WEBMCP_URL=https://your-workbench.example/live \
BASH_WORKBENCH_CHROME=/path/to/chrome \
mise exec -- npm run verify:webmcp
```

## Browser console verification

In a WebMCP-enabled browser:

```js
const tools = await document.modelContext.getTools();
tools.filter((tool) => tool.name.startsWith("workbench_"));
```

The Workbench also logs `WebMCP ready: 48 Workbench tools` after registration.

## Compatibility

- The standards-shaped integration uses `document.modelContext.registerTool()`.
- Tool registration is feature-detected and tied to the document lifecycle with an `AbortSignal`.
- Read-only tools declare `readOnlyHint`; state-changing and destructive tools carry corresponding annotations.
- Tool schemas are strict JSON Schema objects.
- Tools return bounded, JSON-serializable application data.
- Workbench remains fully functional when WebMCP is unavailable or registration is rejected by browser policy.
