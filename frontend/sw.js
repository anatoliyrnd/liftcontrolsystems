// Версия поднята до v7 из-за изменения структуры файлов
const CACHE_NAME = "lift-cache-v72";

// Список файлов, которые нужны для запуска приложения (App Shell)
const ASSETS_TO_CACHE = [
  "./",
  "./index.html",
  "./style.css",
  "./main.js",
  "./manifest.json",
  "./icons/icon-192.png",
  "./icons/icon-512.png",

  // Модули JS
  "./js/route/router.js",
  // УДАЛЕНО: "./js/route/pages.js",
  // ДОБАВЛЕНО: Новая папка pages
  "./js/route/pages/index.js",
  "./js/route/pages/tickets.js",
  "./js/route/pages/create.js",
  "./js/route/pages/details.js",
  "./js/route/pages/login.js",
  "./js/route/pages/profile.js",
  "./js/route/pages/settings.js",

  "./js/route/menu-manager.js",
  "./js/route/inactivity-tracker.js",
  "./js/api-service.js",
  "./js/auth-store.js",
  "./js/config.js",
  "./js/history-logger.js",
  "./js/login-controller.js",
  "./js/tickets-controller.js",
  "./js/create-controller.js",
  "./js/details-controller.js",
  "./js/settings-controller.js",
  "./js/profile-controller.js", // <-- ДОБАВЛЕНО (создадим на следующем шаге)
  "./js/offline-db.js",
  "./js/sync-manager.js",
  "./js/app-state.js",
  "./js/dict-store.js",
  "./js/staff-store.js",
  "./js/user-store.js",
  "./js/theme-controller.js",
  "./js/notifications-poller.js",
  "./js/utils/escape-html.js",
  "./js/utils/date-utils.js",
  "./js/utils/address-flattener.js",
  "./js/components/notify.js",
  "./js/components/dict-select.js",
  "./js/components/staff-select.js",
  "./js/components/repair-time-picker.js",
  "./js/components/address-picker.js",
  "./js/components/validated-textarea.js",
  "./js/components/voiceInput.js",
  "./js/components/network-led.js",
  "./js/components/api-status.js",
  "./js/vendor/idb.js",
];

// 1. Установка (кэшируем файлы)
self.addEventListener("install", (event) => {
  event.waitUntil(
    caches.open(CACHE_NAME).then((cache) => {
      console.log("[SW] Кэширование файлов оболочки (v6)");
      // Кэшируем каждый файл отдельно. Если один файл (например, favicon) отдаст 404,
      // остальные всё равно закэшируются, а SW успешно установится.
      return Promise.all(
        ASSETS_TO_CACHE.map((url) => {
          return cache.add(url).catch((err) => {
            console.warn("[SW] Не удалось закэшировать файл:", url, err);
          });
        }),
      );
    }),
  );
  self.skipWaiting();
});

// 2. Активация (удаляем старый кэш)
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
  self.clients.claim();
});

// 3. Перехват запросов
self.addEventListener("fetch", (event) => {
  // КРИТИЧЕСКАЯ ПРАВКА: Service Worker не умеет кэшировать POST/PUT/DELETE.
  // Пропускаем всё, что не является GET-запросом, напрямую в сеть.
  if (event.request.method !== "GET") {
    return;
  }

  const url = new URL(event.request.url);

  // Запросы к API (test_calls.php, auth_stub.php) НЕ кэшируем
  if (url.pathname.endsWith(".php")) {
    return;
  }

  // Для статики: Сначала сеть, если сети нет — берем из кэша
  event.respondWith(
    fetch(event.request)
      .then((response) => {
        // Если ответ успешный — обновляем кэш
        if (response && response.status === 200) {
          const responseClone = response.clone();
          caches.open(CACHE_NAME).then((cache) => {
            cache.put(event.request, responseClone);
          });
        }
        return response;
      })
      .catch(() => {
        // Если сети нет — отдаем из кэша
        return caches.match(event.request);
      }),
  );
});
