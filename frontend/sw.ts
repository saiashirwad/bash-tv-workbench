/// <reference lib="webworker" />

const serviceWorker = self as unknown as ServiceWorkerGlobalScope;

// The build replaces this token so every asset manifest installs a new cache.
const CACHE = "bash-workbench-shell-__ASSET_MANIFEST_VERSION__";
const MANIFEST = "/asset-manifest.json";
let shell = new Set<string>();

const loadShell = async () => {
  const response = await fetch(MANIFEST, { cache: "no-store" });
  if (!response.ok) throw new Error("Asset manifest unavailable");
  const manifest = (await response.json()) as { shell?: unknown };
  if (
    !Array.isArray(manifest.shell) ||
    !manifest.shell.every(
      (url) =>
        typeof url === "string" &&
        url.startsWith("/") &&
        !url.startsWith("/api/"),
    )
  )
    throw new Error("Invalid asset manifest shell");
  shell = new Set(["/", ...manifest.shell]);
  return [...shell];
};

serviceWorker.addEventListener("install", (event: ExtendableEvent) =>
  event.waitUntil(
    loadShell()
      .then((urls) => caches.open(CACHE).then((cache) => cache.addAll(urls)))
      .then(() => serviceWorker.skipWaiting()),
  ),
);
serviceWorker.addEventListener("activate", (event: ExtendableEvent) =>
  event.waitUntil(
    loadShell()
      .then(() => caches.keys())
      .then((keys) =>
        Promise.all(
          keys.filter((key) => key !== CACHE).map((key) => caches.delete(key)),
        ),
      )
      .then(() => serviceWorker.clients.claim())
      .then(() => serviceWorker.clients.matchAll({ type: "window" }))
      .then((clients) =>
        clients.forEach((client) =>
          client.postMessage({ type: "workbench-update", cache: CACHE }),
        ),
      ),
  ),
);
serviceWorker.addEventListener("fetch", (event: FetchEvent) => {
  const request = event.request;
  const url = new URL(request.url);
  if (
    request.method !== "GET" ||
    url.origin !== location.origin ||
    url.pathname.startsWith("/api/")
  )
    return;
  if (request.mode === "navigate") {
    event.respondWith(
      fetch(request).catch(() => caches.match("/") as Promise<Response>),
    );
    return;
  }
  if (!shell.has(url.pathname)) return;
  event.respondWith(
    caches.match(request).then((cached) => cached || fetch(request)),
  );
});
