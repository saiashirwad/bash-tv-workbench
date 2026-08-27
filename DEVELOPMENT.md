# Development

The workbench intentionally stays a small Node server plus browser-native ES modules. There is no frontend framework or required dev server. The complete Kyoot source workspace is vendored under `kyoot/`; no sibling checkout is a build or runtime dependency.

## Code map

### Server

- `project-config.mjs` — validates the shared project registry used by both processes.
- `server.mjs` — HTTP routes, project confinement, session parsing, Git/files/download APIs, and the production Kyoot runtime.
- `orchestrator-kyoot/src/run-engine.ts` — durable concurrent normal-run scheduling, lifecycle transitions, per-run operation locks, cancellation, and recovery.
- `orchestrator-kyoot/src/pi-runs.ts` — normal-run execution through `@kyoot/pi`, event mapping, Git change tracking, and scoped process cleanup.
- `orchestrator-kyoot/src/workflow-engine.ts` / `pi-workflow.ts` — dynamic DAG workflow orchestration and Pi task execution.
- `child-provider.mjs` — registers only the inherited `bashtv/free` provider for child Pi processes.

### Browser

- `frontend/app.ts` — shell state, Page.js route handlers, Live chat, agents, project files, Git, and event wiring.
- `frontend/workflows.ts` — workflow collection, task, progress, and event views.
- `frontend/trajectory.ts` — trajectory loading, filtering, overview, event selection, and inspector rendering.
- `frontend/dom.ts` — shared DOM selectors and HTML escaping.
- `frontend/query-cache.ts` — IndexedDB stale-while-revalidate cache and request deduplication.
- `frontend/sw.ts` — static shell cache. Bump `CACHE` after changing a cached browser asset.
- `editor-entry.ts` / `markdown-entry.ts` — TypeScript entry points for the CodeMirror and Markdown bundles.
- `public/page.mjs` — vendored Page.js client router; update from the pinned `page` package rather than editing it.
- `public/*.js` — generated browser-native deployment assets; do not edit by hand.

CSS is split by feature. `style.css` and `bash-theme.css` provide the older base layers; later feature sheets intentionally override them. New feature-specific rules should go in the nearest existing feature sheet rather than adding to `style.css`.

## Commands

```bash
mise exec -- npm ci                    # install the unified workspace
mise exec -- npm run typecheck:frontend # TypeScript-check browser source
mise exec -- npm run build              # rebuild browser and typed-server assets
mise exec -- npm run check              # frontend, syntax, and portability checks
mise exec -- npm run check:all          # include Kyoot and orchestrator checks
mise exec -- npm run format             # format authored source and assets
```

Generated assets are committed so an installed workbench does not need `node_modules` or a build step at runtime.

## Local verification

```bash
node server.mjs
curl http://127.0.0.1:8010/api/health
```

The system service runs the same server. Both normal agents and workflow tasks are owned by the in-process Kyoot orchestrator. Bash.tv model entitlement is discovered only at child spawn time and is never persisted.

## Conventions

- Keep filesystem operations inside the Workbench installation root or roots from the project registry; never add machine-specific project paths to source or service templates.
- Never return or log credential values.
- Escape hand-built HTML with `escapeHtml`; conversational Markdown must use `renderMarkdown`.
- Keep raw tool output in `<pre>` blocks.
- In nested grid layouts, use `minmax(0, 1fr)` and `min-height: 0` on scroll boundaries.
- Page.js routes are authoritative. UI selections must navigate to a route, and route handlers must restore the complete view.
- When embedded by Bash.tv, the parent `/p/:sandbox/:port` URL cannot mirror iframe history. The top-bar Link menu exposes the direct, restorable app URL. `bash-route` messages are also emitted for future parent-shell support.
- Preserve route and API compatibility when moving code between modules.
