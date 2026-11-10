/* Service worker do Moto Taxi Timbauba (PWA v25.14).
   Cache do app shell para abrir rapido e instalar na tela inicial.
   Estrategia network-first para a pagina (nunca serve versao velha
   travada: a atualizacao do site chega na hora) e cache-first so para
   os arquivos estaticos do PWA (manifesto e icones). Chamadas ao
   backend e a CDNs nao passam por aqui (outra origem). */
var CACHE = "mtt-v25.14";
var SHELL = [
  "/",
  "/index.html",
  "/manifest.json",
  "/icon-192.png",
  "/icon-512.png",
  "/icon-512-maskable.png",
  "/apple-touch-icon.png"
];

self.addEventListener("install", function (e) {
  e.waitUntil(
    caches.open(CACHE).then(function (c) {
      return Promise.all(SHELL.map(function (u) {
        return c.add(u).catch(function () {});
      }));
    }).then(function () { return self.skipWaiting(); })
  );
});

self.addEventListener("activate", function (e) {
  e.waitUntil(
    caches.keys().then(function (keys) {
      return Promise.all(keys.map(function (k) {
        if (k !== CACHE) return caches.delete(k);
      }));
    }).then(function () { return self.clients.claim(); })
  );
});

self.addEventListener("fetch", function (e) {
  var req = e.request;
  if (req.method !== "GET") return;
  var url = new URL(req.url);
  if (url.origin !== self.location.origin) return; // backend e CDNs: nao intercepta
  var isNav = req.mode === "navigate" || req.destination === "document";
  if (isNav) {
    // Pagina: rede primeiro; sem rede, usa o cache (nunca trava versao velha).
    e.respondWith(
      fetch(req).then(function (res) {
        var copy = res.clone();
        caches.open(CACHE).then(function (c) { c.put("/index.html", copy); });
        return res;
      }).catch(function () {
        return caches.match("/index.html").then(function (r) {
          return r || caches.match("/");
        });
      })
    );
    return;
  }
  var isStatic = SHELL.indexOf(url.pathname) !== -1;
  if (isStatic) {
    // Manifesto e icones: cache primeiro, rede como reserva.
    e.respondWith(
      caches.match(req).then(function (hit) {
        if (hit) return hit;
        return fetch(req).then(function (res) {
          var copy = res.clone();
          caches.open(CACHE).then(function (c) { c.put(req, copy); });
          return res;
        });
      })
    );
  }
  // Qualquer outra requisicao da mesma origem: passa direto, sem cache.
});
