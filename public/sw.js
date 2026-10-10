// Service worker: busca sempre a versão mais nova do código (HTML/JS/CSS)
// quando há internet — nunca trava numa versão antiga depois de uma
// atualização. Imagens (raramente mudam) usam cache primeiro, atualizando
// por trás, pra abrir rápido mesmo com internet ruim no campo. Se a rede
// cair de vez, tudo cai de volta pro que já está salvo no aparelho.
const CACHE_VERSION = "pelada-v3";
const STATIC_ASSETS = [
  "/manifest.json",
  "/favicon.png",
  "/apple-touch-icon.png",
  "/assets/logo.png",
  "/assets/stadium.jpg",
  "/assets/crest-america-mineiro.png",
  "/assets/crest-cruzeiro.png",
  "/assets/crest-corinthians.png",
  "/assets/crest-atletico-mineiro.png",
  "/assets/icon-192.png",
  "/assets/icon-512.png",
];

self.addEventListener("install", (event) => {
  event.waitUntil(
    caches
      .open(CACHE_VERSION)
      .then((cache) => cache.addAll(STATIC_ASSETS))
      .then(() => self.skipWaiting())
  );
});

self.addEventListener("activate", (event) => {
  event.waitUntil(
    caches
      .keys()
      .then((keys) =>
        Promise.all(keys.filter((k) => k !== CACHE_VERSION).map((k) => caches.delete(k)))
      )
      .then(() => self.clients.claim())
  );
});

self.addEventListener("fetch", (event) => {
  if (event.request.method !== "GET") return;
  const url = new URL(event.request.url);
  const isImage = /\.(png|jpg|jpeg|svg|webp)$/i.test(url.pathname);

  if (isImage) {
    // Imagem: mostra o que já está salvo na hora (rápido) e atualiza o
    // cache por trás dos panos para a próxima vez.
    event.respondWith(
      caches.match(event.request).then((cached) => {
        const network = fetch(event.request)
          .then((response) => {
            if (response && response.status === 200) {
              const copy = response.clone();
              caches.open(CACHE_VERSION).then((cache) => cache.put(event.request, copy));
            }
            return response;
          })
          .catch(() => cached);
        return cached || network;
      })
    );
    return;
  }

  // HTML / JS / CSS (o app em si): sempre busca a rede primeiro, pra toda
  // atualização aparecer na hora. Só usa o cache salvo se a internet cair.
  event.respondWith(
    fetch(event.request)
      .then((response) => {
        if (response && response.status === 200) {
          const copy = response.clone();
          caches.open(CACHE_VERSION).then((cache) => cache.put(event.request, copy));
        }
        return response;
      })
      .catch(() => caches.match(event.request))
  );
});

// ---- Notificação push (cronômetro com o app fechado) ----
self.addEventListener("push", (event) => {
  let data = {};
  try { data = event.data ? event.data.json() : {}; } catch { data = {}; }
  event.waitUntil(
    self.registration.showNotification(data.title || "Cronômetro Pelada 4K", {
      body: data.body || "TEMPO ESGOTADO!",
      icon: "/assets/icon-192.png",
      badge: "/assets/icon-192.png",
      tag: "cronometro",
      renotify: true,
      requireInteraction: true,
      vibrate: [300, 150, 300, 150, 600],
    })
  );
});
self.addEventListener("notificationclick", (event) => {
  event.notification.close();
  event.waitUntil(
    self.clients.matchAll({ type: "window", includeUncontrolled: true }).then((list) => {
      const c = list.find((x) => "focus" in x);
      return c ? c.focus() : self.clients.openWindow("/");
    })
  );
});
