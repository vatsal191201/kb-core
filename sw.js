const CACHE = "kbcore-v20";

// Precache the shell. Media clips are large, so they are cached lazily on
// first play by the fetch handler below.
const SHELL = [
  "./",
  "index.html",
  "styles.css",
  "app.js",
  "library.js",
  "sources.js",
  "sources.json",
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

const isMedia = url => /\.(mp4|m4v|webm|mov)$/i.test(new URL(url).pathname);

/*
 * VIDEO + SERVICE WORKER: the bug that broke playback in v7.
 *
 * Browsers fetch <video> with a `Range:` header and REQUIRE a 206 Partial
 * Content response with a Content-Range header. Two things go wrong in a naive
 * cache-first handler:
 *   1. `cache.put()` THROWS on a 206 response - the Cache API cannot store
 *      partial responses at all.
 *   2. Serving a cached full 200 body in reply to a Range request makes iOS
 *      Safari refuse to decode the video. It sits on the poster frame forever
 *      with no error event, which is exactly the "clip is stuck" symptom.
 *
 * So: never hand a cached 200 straight back to a Range request. Slice the
 * cached body and synthesise a real 206 instead. That keeps offline playback
 * working AND satisfies the range machinery.
 */
async function rangeResponse(request, cached) {
  const buf = await cached.arrayBuffer();
  const total = buf.byteLength;
  const header = request.headers.get("range") || "";
  const m = /bytes=(\d*)-(\d*)/.exec(header);
  if (!m) return new Response(buf, { status: 200, headers: cached.headers });

  let start = m[1] === "" ? null : parseInt(m[1], 10);
  let end = m[2] === "" ? null : parseInt(m[2], 10);
  if (start === null) {                 // suffix form: bytes=-500
    const len = end === null ? total : end;
    start = Math.max(0, total - len);
    end = total - 1;
  } else if (end === null || end >= total) {
    end = total - 1;
  }
  if (start > end || start >= total) {
    return new Response(null, {
      status: 416,
      headers: { "Content-Range": `bytes */${total}` }
    });
  }

  return new Response(buf.slice(start, end + 1), {
    status: 206,
    statusText: "Partial Content",
    headers: {
      "Content-Type": cached.headers.get("Content-Type") || "video/mp4",
      "Content-Length": String(end - start + 1),
      "Content-Range": `bytes ${start}-${end}/${total}`,
      "Accept-Ranges": "bytes"
    }
  });
}

self.addEventListener("fetch", e => {
  const req = e.request;
  if (req.method !== "GET") return;

  const url = new URL(req.url);
  if (url.origin !== self.location.origin) return;   // never touch cross-origin

  if (isMedia(req.url)) {
    e.respondWith((async () => {
      const cache = await caches.open(CACHE);
      // Media is always stored under a bare URL key, never under the Range
      // request, so one cached copy serves every range.
      const cached = await cache.match(url.pathname);

      if (cached) {
        return req.headers.has("range")
          ? rangeResponse(req, cached.clone())
          : cached;
      }

      try {
        // Fetch the WHOLE file (no range) so we have something cacheable, then
        // answer this request from it.
        const full = await fetch(url.pathname, { cache: "no-store" });
        if (full.ok && full.status === 200) {
          await cache.put(url.pathname, full.clone());
          return req.headers.has("range")
            ? rangeResponse(req, full.clone())
            : full;
        }
        return fetch(req);          // give up on caching, just proxy it
      } catch (_) {
        return fetch(req);
      }
    })());
    return;
  }

  // Everything else: cache-first, then fill the cache. Only ever store 200s.
  e.respondWith(
    caches.match(req).then(hit => hit || fetch(req).then(res => {
      if (res.ok && res.status === 200 && res.type === "basic") {
        const copy = res.clone();
        caches.open(CACHE).then(c => c.put(req, copy).catch(() => {}));
      }
      return res;
    }).catch(() => hit))
  );
});
