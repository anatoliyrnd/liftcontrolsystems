import { Router } from "./js/route/router.js";
import { ApiService } from "./js/api-service.js";
import {
  mainPageTemplate,
  createPageTemplate,
  detailsPageTemplate,
  loginPageTemplate,
  profilePageTemplate,
  settingsPageTemplate,
} from "./js/route/pages/index.js";
import {
  setRouter as setNotifyRouter,
  notify,
} from "./js/components/notify.js";
import { ThemeController } from "./js/theme-controller.js";
import { MenuManager } from "./js/route/menu-manager.js";
import { API, AUTH } from "./js/config.js";
import { authStore } from "./js/auth-store.js";
import { TicketsController } from "./js/tickets-controller.js";
import { CreateController } from "./js/create-controller.js";
import { DetailsController } from "./js/details-controller.js";
import { LoginController } from "./js/login-controller.js";
import { SettingsController } from "./js/settings-controller.js";
import { ProfileController } from "./js/profile-controller.js";
import { SyncManager } from "./js/sync-manager.js";
import { NotificationsPoller } from "./js/notifications-poller.js";
import { InactivityTracker } from "./js/route/inactivity-tracker.js";
import { logHistoryAction } from "./js/history-logger.js";
import { offlineDB } from "./js/offline-db.js";
import { flattenAddresses } from "./js/utils/address-flattener.js";
import { syncTableSettingsFromStorage } from "./js/table/settings.js";
const api = new ApiService(API.URL, { local: false });
const router = new Router(() => authStore.hasAccess());

let openTicketsArray = [];
let closedTicketsArray = [];

// Контроллеры
const openTicketsCtrl = new TicketsController(api, router, "open");
const closedTicketsCtrl = new TicketsController(api, router, "close");
const createCtrl = new CreateController(api, router);
const detailsCtrl = new DetailsController(api, router);
const loginCtrl = new LoginController(api, router);
const settingsCtrl = new SettingsController(api, router);
const profileCtrl = new ProfileController(api, router);

let menuManager = null;
let notifPoller = null;
let inactivityTracker = null;
let syncManager = null;

// --- ВСПОМОГАТЕЛЬНЫЕ ФУНКЦИИ ---
async function initAuthorizedApp() {
  if (!menuManager) {
    menuManager = new MenuManager(api, router, "dynamicMenu");
  }
  await menuManager.initialize();
  initAppData(); // Загрузка адресов
}
// 1. Синхронизация шапки (профиль, история)
function syncAuthUI() {
  const historyWrapper = document.getElementById("historyWrapper");
  const userProfileWrapper = document.getElementById("userProfileWrapper");
  const navUserAvatar = document.getElementById("navUserAvatar");
  const navUserName = document.getElementById("navUserName");

  const user = authStore.getUser();
  const isAuth = authStore.hasAccess();

  if (isAuth && user) {
    if (historyWrapper) historyWrapper.style.display = "flex";
    if (userProfileWrapper) userProfileWrapper.style.display = "flex";
    if (navUserName) {
      if (user.surname || user.name) {
        // Если пришли раздельные поля, склеиваем их. Иначе используем старый fallback-вариант name
        const formattedName = user.surname
          ? `${user.surname} ${user.name || ""}`.trim()
          : user.name;
        navUserName.textContent = formattedName || "Пользователь";
      } else {
        navUserName.textContent = "Пользователь";
      }
    }
    if (navUserAvatar) {
      const nameForAvatar = user.name || user.surname || "Пользователь";
      navUserAvatar.textContent = nameForAvatar.charAt(0).toUpperCase();
    }

    if (!notifPoller) {
      notifPoller = new NotificationsPoller(api);
      notifPoller.start();
    }
    if (!inactivityTracker) {
      inactivityTracker = new InactivityTracker(router, 30 * 60 * 1000);
      inactivityTracker.startTracking();
    }
  } else {
    if (historyWrapper) historyWrapper.style.display = "none";
    if (userProfileWrapper) userProfileWrapper.style.display = "none";
    if (notifPoller) {
      notifPoller.stop();
      notifPoller = null;
    }
    if (inactivityTracker) {
      inactivityTracker.stopTracking();
      inactivityTracker = null;
    }
    const menu = document.getElementById("dynamicMenu");
    if (menu) menu.innerHTML = "";
  }
}

// 2. Фоновая загрузка адресов
async function initAppData() {
  try {
    let cities = await offlineDB.getCities();
    if (cities.length === 0) {
      const response = await api.post({ data: "loadAddress" }, null, "global");
      if (response && response.status === "ok") {
        const flatData = flattenAddresses(response);
        await offlineDB.saveAddresses(flatData);
        notify.success(`Справочник адресов загружен (${flatData.length} шт.)`, {
          once: true,
        });
      }
    }
  } catch (err) {
    console.error("[App] Ошибка загрузки адресов:", err);
    notify.error("Не удалось загрузить справочник адресов.", { once: true });
  }
}

// --- ЗАПУСК ПРИЛОЖЕНИЯ ---
document.addEventListener("DOMContentLoaded", async () => {
  // 1. Базовая инициализация (тема, тосты, настройки таблиц)
  new ThemeController("themeToggle");
  setNotifyRouter(router);
  syncTableSettingsFromStorage();

  // 2. Подписка на события
  window.addEventListener("triggerSync", () => {
    if (syncManager) syncManager.startSync();
  });
  window.addEventListener("refreshSyncState", () => {
    if (openTicketsCtrl) openTicketsCtrl._updateSyncButton();
  });
  window.addEventListener("auth:updated", () => {
    syncAuthUI(); // Перерисовываем шапку после смены профиля
  });
  window.addEventListener("auth:loggedin", async () => {
    syncAuthUI();
    await initAuthorizedApp();
  });
  window.addEventListener(ApiService.AUTH_LOST_EVENT, (e) => {
    authStore.clear();
    syncAuthUI();
    const msg =
      e.detail?.reason === "device_mismatch"
        ? "Устройство изменилось, войдите заново"
        : "Сессия истекла, войдите заново";
    logHistoryAction(msg);
    notify.warning(msg);
    router.navigate("#/login");
  });

  // 3. АУТЕНТИФИКАЦИЯ (сначала проверяем, кто мы)
  if (AUTH.BYPASS_AUTH) {
    authStore.setSession("mock-token", Date.now() + 86400000, {
      id: 1,
      name: "Тестовый Доступ",
      role: "guest",
    });
  } else {
    await api.tryAutoLogin();
  }

  // 4. ИНИЦИАЛИЗАЦИЯ UI ПОСЛЕ АВТОРИЗАЦИИ
  syncAuthUI();
  if (authStore.hasAccess()) {
    await initAuthorizedApp();
  }

  // 5. Обработчики шапки (Меню профиля и Выход)
  const userProfileBtn = document.getElementById("userProfileBtn");
  const userDropdown = document.getElementById("userDropdown");
  const userProfileWrapper = document.getElementById("userProfileWrapper");

  if (userProfileBtn && userDropdown) {
    userProfileBtn.onclick = (e) => {
      e.stopPropagation();
      userDropdown.classList.toggle("show");
      userProfileWrapper.classList.toggle("open");
    };
    document.addEventListener("click", (e) => {
      if (!userProfileWrapper.contains(e.target)) {
        userDropdown.classList.remove("show");
        userProfileWrapper.classList.remove("open");
      }
    });
  }

  const logoutBtn = document.getElementById("logoutBtn");
  if (logoutBtn) {
    logoutBtn.onclick = async () => {
      await api.logout();
      authStore.clear();

      // Очищаем данные заявок в памяти
      openTicketsArray.length = 0;
      closedTicketsArray.length = 0;

      syncAuthUI();
      logHistoryAction("Вы вышли из системы");
      notify.info("Вы вышли из системы");
      router.navigate("#/login");
    };
  }

  const navLogo = document.getElementById("navLogo");
  if (navLogo) navLogo.addEventListener("click", () => router.navigate("#/"));

  // 6. Роутинг
  router.addRoute(
    "#/login",
    () => loginPageTemplate(),
    () => loginCtrl.mount(),
  );
  router.addRoute(
    "#/",
    () => mainPageTemplate(),
    () => {
      closedTicketsCtrl.unmount();
      openTicketsCtrl.mount(openTicketsArray);
    },
  );
  router.addRoute(
    "#/closed",
    () => mainPageTemplate(),
    () => {
      openTicketsCtrl.unmount();
      closedTicketsCtrl.mount(closedTicketsArray);
    },
  );
  router.addRoute(
    "#/create",
    () => createPageTemplate(),
    () => {
      openTicketsCtrl.unmount();
      createCtrl.unmount();
      createCtrl.mount(openTicketsArray);
    },
  );
  router.addRoute(
    "#/ticket",
    (id) => detailsPageTemplate(id),
    (id) => {
      openTicketsCtrl.unmount();
      detailsCtrl.mount(id, [...openTicketsArray, ...closedTicketsArray]);
    },
  );
  router.addRoute(
    "#/settings",
    () => settingsPageTemplate(),
    () => settingsCtrl.mount(),
  );
  router.addRoute(
    "#/profile",
    () => profilePageTemplate(),
    () => profileCtrl.mount(),
  );

  const createPlaceholderRoute = (title) => () =>
    `<div class="container"><h1>${title}</h1><p style="color:var(--text-secondary); margin-top:10px;">Экран в разработке.</p></div>`;
  router.addRoute("#/reports", createPlaceholderRoute("Аналитические Отчеты"));
  router.addRoute(
    "#/addresses",
    createPlaceholderRoute("Реестр лифтовых адресов"),
  );
  router.addRoute(
    "#/more",
    createPlaceholderRoute("Прочие инструменты диспетчера"),
  );

  // 7. Сворачивание истории
  const historyWrapper = document.getElementById("historyWrapper");
  const historyTitle = document.getElementById("historyTitle");
  if (historyTitle && historyWrapper) {
    historyTitle.style.cursor = "pointer";
    historyTitle.onclick = () =>
      historyWrapper.classList.toggle("is-collapsed");
  }

  // 8. Синхронизация
  syncManager = new SyncManager(api, router, (newTickets) => {
    openTicketsArray.length = 0;
    openTicketsArray.push(...newTickets);
    if (window.location.hash === "#/" || window.location.hash === "") {
      openTicketsCtrl.refreshFromMemory(openTicketsArray);
    }
  });
  window.syncManagerInstance = syncManager;
  if (navigator.onLine) setTimeout(() => syncManager.startSync(), 1000);

  // 9. Service Worker
  if ("serviceWorker" in navigator) {
    window.addEventListener("load", () => {
      navigator.serviceWorker
        .register("./sw.js")
        .catch((err) => console.error("❌ Ошибка SW:", err));
    });
  }

  // 10. Старт роутера
  router._handleRoute();
});
