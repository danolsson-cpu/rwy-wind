// Keeps a copy of the app on the phone so it works without internet.
// Online: always loads the newest page from the web and refreshes the saved copy.
// Offline: uses the saved copy.
const VERSION = "rwy-wind-v5";
const FILES = ["./", "index.html", "manifest.webmanifest", "icon-180.png", "icon-192.png", "icon-512.png"];

self.addEventListener("install", e => {
  e.waitUntil(caches.open(VERSION).then(c => c.addAll(FILES.map(f => new Request(f, { cache: "reload" })))).then(() => self.skipWaiting()));
});

self.addEventListener("activate", e => {
  e.waitUntil(caches.keys()
    .then(keys => Promise.all(keys.filter(k => k !== VERSION).map(k => caches.delete(k))))
    .then(() => self.clients.claim()));
});

function save(req, res) {
  if (res.ok || res.type === "opaque") { const copy = res.clone(); caches.open(VERSION).then(c => c.put(req, copy)); }
  return res;
}

self.addEventListener("fetch", e => {
  const req = e.request;
  if (req.method !== "GET") return;
  const sameSite = new URL(req.url).origin === self.location.origin;
  if (sameSite) {
    // Network first, so updates show up straight away; saved copy when offline.
    e.respondWith(fetch(req, { cache: "no-cache" }).then(res => save(req, res))
      .catch(() => caches.match(req, { ignoreSearch: true }).then(hit => hit || caches.match("index.html"))));
  } else {
    // Fonts: saved copy first, they never change.
    e.respondWith(caches.match(req).then(hit => hit || fetch(req).then(res => save(req, res))));
  }
});
