# Runtime reachability audit

Audited 2026-08-27 using repository imports, package manifests, scripts, runtime entry points, tests, and documentation.

## Removed as proven duplicate or obsolete

- Workflow REST/SSE adapter and test
- Private workflow CLI
- Obsolete Workbench systemd template
- Legacy supervisor/socket implementation (removed earlier)
- Four override-only CSS layers after declarations moved to owning stylesheets

No obsolete service, supervisor, workflow HTTP/CLI, Bun workspace, split lockfile, or old query-cache implementation remains.

## Retained intentionally

Every package in `kyoot/packages/*` has active repository imports, tests, or maintained integration documentation:

- `@kyoot/pi` drives coding runs and workflow tasks.
- `@kyoot/workbench-protocol`, `@kyoot/rpc`, `@kyoot/sync`, and `@kyoot/schema` implement the typed application API and browser state.
- `kyoot` provides the effect runtime used by those packages.
- `@kyoot/platform`, `@kyoot/ai`, `@kyoot/ai-pi`, and `@kyoot/registry` remain maintained/tested workspace packages and are not deleted merely because Workbench runtime paths use only a subset directly.

Generated `public/*.js`, hashed entry assets, `asset-manifest.json`, and `typed-server.mjs` remain committed deployment artifacts. `npm run check:generated` proves they match source.

Further deletion requires an explicit supported-package decision rather than a file-level reachability guess.
