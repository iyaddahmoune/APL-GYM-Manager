const CACHE_NAME = "apl-gym-manager-v7";
const SHELL = ["/manager/", "/manager/app.css", "/manager/app.js", "/manager/manifest.webmanifest", "/manager/icon.svg", "/manager/public-key.pem", "/manager/online-public-key.pem"];
self.addEventListener("install", event => event.waitUntil(caches.open(CACHE_NAME).then(cache => cache.addAll(SHELL)).then(() => self.skipWaiting())));
self.addEventListener("activate", event => event.waitUntil(caches.keys().then(keys => Promise.all(keys.filter(key => key.startsWith("apl-gym-manager-") && key !== CACHE_NAME).map(key => caches.delete(key)))).then(() => self.clients.claim())));
self.addEventListener("fetch", event => {
  const req = event.request, url = new URL(req.url);
  if (req.method !== "GET" || url.origin !== self.location.origin || url.pathname.startsWith("/v1/") || url.search || !url.pathname.startsWith("/manager/")) return;
  event.respondWith(fetch(req).then(response => { if (response.ok) caches.open(CACHE_NAME).then(cache => cache.put(req, response.clone())); return response; }).catch(() => caches.match(req).then(hit => hit || caches.match("/manager/"))));
});
