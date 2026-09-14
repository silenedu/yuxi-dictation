const CACHE = "yuxi-dictation-v2";
const ASSETS = [
  ".",
  "index.html",
  "css/style.css",
  "js/data.js",
  "js/app.js",
  "manifest.webmanifest",
  "icon.svg",
  "icons/icon-192.png",
  "icons/icon-512.png"
];

function isHtml(req) {
  if (req.mode === "navigate") return true;
  var accept = req.headers.get("accept");
  if (accept && accept.indexOf("text/html") !== -1) return true;
  try { return /\.html?$/.test(new URL(req.url).pathname); } catch (e) { return false; }
}

self.addEventListener("install", function (e) {
  self.skipWaiting();
  e.waitUntil(
    caches.open(CACHE).then(function (c) {
      return Promise.all(ASSETS.map(function (u) {
        return c.add(new Request(u, { cache: "reload" })).catch(function () { return Promise.resolve(); });
      }));
    })
  );
});

self.addEventListener("activate", function (e) {
  e.waitUntil(
    caches.keys().then(function (keys) {
      return Promise.all(keys.filter(function (k) { return k !== CACHE; }).map(function (k) { return caches.delete(k); }));
    }).then(function () { return self.clients.claim(); })
  );
});

self.addEventListener("fetch", function (e) {
  if (e.request.method !== "GET") return;
  var url;
  try { url = new URL(e.request.url); } catch (err) { return; }
  if (url.origin !== self.location.origin) return;

  if (isHtml(e.request)) {
    e.respondWith(
      fetch(e.request).then(function (res) {
        var copy = res.clone();
        caches.open(CACHE).then(function (c) { c.put(e.request, copy); });
        return res;
      }).catch(function () {
        return caches.match(e.request).then(function (h) { return h || caches.match("index.html"); });
      })
    );
    return;
  }

  e.respondWith(
    caches.match(e.request).then(function (hit) {
      if (hit) return hit;
      return fetch(e.request).then(function (res) {
        var copy = res.clone();
        caches.open(CACHE).then(function (c) { c.put(e.request, copy); });
        return res;
      }).catch(function () { return hit; });
    })
  );
});
