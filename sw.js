const CACHE = "kbcore-v6";

// Precache the shell. Media clips are large, so they are cached lazily on
// first play by the fetch handler below.
const SHELL = [
  "./",
  "index.html",
  "styles.css",
  "app.js",
  "library.js",
  "workout.json",
  "exercises.json",
  "manifest.json",
  "icon-192.png",
  "icon-512.png"
];

self.addEventListener("install", e => {
  e.waitUntil(
    caches.open(CACHE)
      // addAll is all-or-nothing: one 404 would leave the app with no cache at
      // all. Cache each entry independently so a missing file degrades to
      // "that one asset is online-only" instead of "offline is broken".
      .then(c => Promise.all(SHELL.map(url => c.add(url).catch(() => {}))))
      .then(() => self.skipWaiting())
  );
});

self.addEventListener("activate", e => {
  e.waitUntil(caches.keys().then(ks =>
    Promise.all(ks.filter(k => k !== CACHE).map(k => caches.delete(k)))
  ).then(() => self.clients.claim()));
});

// cache-first, then fill the cache (media clips get cached on first play)
self.addEventListener("fetch", e => {
  if (e.request.method !== "GET") return;
  e.respondWith(
    caches.match(e.request).then(hit => hit || fetch(e.request).then(res => {
      if (res.ok && res.type === "basic") {
        const copy = res.clone();
        caches.open(CACHE).then(c => c.put(e.request, copy));
      }
      return res;
    }).catch(() => hit))
  );
});
