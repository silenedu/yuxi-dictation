const CACHE = "yuxi-dictation-v7";
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

// 网络优先：在线时始终取最新文件（保证更新即时生效），离线时回退缓存。
// 这样不会再出现「HTML 已更新、CSS/JS 仍是旧缓存」的部分更新问题。
self.addEventListener("fetch", function (e) {
  if (e.request.method !== "GET") return;
  var url;
  try { url = new URL(e.request.url); } catch (err) { return; }
  if (url.origin !== self.location.origin) return;

  e.respondWith(
    fetch(e.request).then(function (res) {
      if (res && res.status === 200 && res.type === "basic") {
        var copy = res.clone();
        caches.open(CACHE).then(function (c) { c.put(e.request, copy); });
      }
      return res;
    }).catch(function () {
      return caches.match(e.request).then(function (h) {
        if (h) return h;
        if (isHtml(e.request)) return caches.match("index.html");
        return new Response("", { status: 504, statusText: "offline" });
      });
    })
  );
});
