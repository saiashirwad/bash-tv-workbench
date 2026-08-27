# Startup performance

Measured 2026-08-27 from the generated production assets.

## Before

- All generated JS/CSS: 2,488,904 bytes uncompressed.
- Service worker precached editor.js (about 1.6 MB), markdown.js (about 233 KB), workflows.js, trajectory.js, and every CSS file.
- app.ts statically imported editor, Markdown, workflow, and trajectory adapters, making those optional modules part of startup dependency discovery.
- Static responses were uncompressed.

## After

- Initial `app.js` after route extraction: about 32 KB raw (down from about 54–56 KB before extraction).
- All generated top-level JS/CSS: 2489985 bytes raw / 789889 aggregate gzip.
- `editor.js`, `markdown.js`, `workflows.js`, and `trajectory.js` are loaded only when used and are absent from the service-worker shell precache. Live Chat, runs, Files, and Git behavior now live in focused route modules; the 1.6 MB editor was verified absent on fresh Live and loaded only after opening a file.
- Static JS, CSS, HTML, JSON, SVG, and MJS responses over 1 KB use gzip when accepted.
- HTML remains `no-cache`. Generated JS entry points have deterministic 16-hex SHA-256 filenames in `public/asset-manifest.json` and use a one-year immutable cache; logical compatibility URLs use a five-minute cache. API responses are private/no-store.
- The generated HTML loads the hashed app entry while root logical JS URLs continue to resolve through the server manifest, preserving zero-build startup and compatibility.
- The service worker obtains its shell-only precache list from the generated manifest. It never handles `/api/` requests or non-shell resources and therefore does not cache credentials, project data, artifacts, command output, or lazy editor/Markdown/workflow assets.

A full cold-browser timing baseline was not stable under the experimental WebMCP Chrome bridge; byte, dependency, manifest integrity, and HTTP cache-policy acceptance are deterministic and covered by the generated build and tests.

## Data and rendering

The browser data path now has explicit size limits:

- The sync collection contains `RunSummary` records. Prompts, output, changes,
  usage, and transcript events are not replicated with the run list.
- A selected run loads its metadata and newest 50 events in parallel. Earlier
  events load in 50-event pages. New events append to the current transcript.
- Closed tool rows contain only their summary. Source highlighting, diff
  formatting, and argument formatting run when the user opens that row.
- Live Trajectory returns at most 100 summary rows to the UI. Full arguments,
  text, result details, and usage load for one selected event.
- The Live Trajectory index processes only new session rows. Search and page
  requests reuse the derived index.
- Routes register before sync hydration. Live Chat and the Files tree load only
  when their route needs them.
- JSON RPC and sync responses use gzip when the client accepts it.

Focused tests enforce a run-summary size below 1 KB for a run with a large
prompt and transcript. Trajectory tests verify that summary pages exclude event
bodies and remain small while details stay available through the event query.
