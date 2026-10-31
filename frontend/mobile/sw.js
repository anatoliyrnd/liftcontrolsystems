// Меняй версию при каждом глобальном обновлении файлов (v2, v3...)
const CACHE_NAME = "lift-mobile-v2";

const ASSETS_TO_CACHE = [
  "./",
  "./index.html",
  "./style.css",
  "./manifest.json",
  "./main.js",
  "./api.js",
  "./api-service.js",
  "./auth-store.js",
  "./config.js",
  "./sync-manager.js",
  "./offline-db.js",
  "./controllers/list-controller.js",
  "./controllers/card-controller.js",
  "./controllers/closed-controller.js",
  "./controllers/login-controller.js",
  "./controllers/profile-controller.js",
  "./components/image-compressor.js",
  "./components/ui-modal.js",
  "./components/api-status.js",
  "./utils/webgl-fingerprint.js",
  "./utils/sanitize.js",
  "./utils/format.js",
  "./vendor/idb.js",
];
self.addEventListener("message", (event) => {
  if (event.data === "SKIP_WAITING") {
    self.skipWaiting();
  }
});
self.addEventListener("install", (event) => {
  event.waitUntil(
    caches.open(CACHE_NAME).then((cache) => {
      // Кэшируем по одному, чтобы падение одного файла не ломало установку
      return Promise.all(
        ASSETS_TO_CACHE.map((url) => {
          return cache
            .add(url)
            .catch((err) => console.warn("[SW] Ошибка кэша:", url));
        }),
      );
    }),
  );
  //
});

self.addEventListener("activate", (event) => {
  event.waitUntil(
    caches.keys().then((cacheNames) => {
      return Promise.all(
        cacheNames.map((cache) => {
          if (cache !== CACHE_NAME) {
            console.log("[SW] Удаление старого кэша:", cache);
            return caches.delete(cache);
          }
        }),
      );
    }),
  );
  self.clients.claim(); // Захватываем контроль над страницами
});

self.addEventListener("fetch", (event) => {
  const url = new URL(event.request.url);

  // Запросы к API (php) не кэшируем вообще
  if (event.request.method !== "GET" || url.pathname.endsWith(".php")) {
    return;
  }

  // Стратегия Network First для всего остального (HTML, JS, CSS)
  event.respondWith(
    fetch(event.request)
      .then((response) => {
        // Если сеть ответила успешно — обновляем кэш
        if (response && response.status === 200) {
          const responseClone = response.clone();
          caches.open(CACHE_NAME).then((cache) => {
            cache.put(event.request, responseClone);
          });
        }
        return response;
      })
      .catch(() => {
        // Если сети нет — достаем из кэша
        return caches.match(event.request).then((cachedResponse) => {
          if (cachedResponse) return cachedResponse;

          // Если это запрос на переход по ссылке (навигация), отдаем index.html
          if (event.request.mode === "navigate") {
            return caches.match("./index.html");
          }
        });
      }),
  );
});
