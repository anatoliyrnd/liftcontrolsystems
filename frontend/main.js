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
import { registerSW } from "virtual:pwa-register";
import { syncIndicator } from "./js/components/sync-indicator.js";
import { offlineBanner } from "./js/components/offline-banner.js";
import { duplicateTicketModal } from "./js/components/duplicate-ticket-modal.js";
import { queuePageTemplate } from "./js/route/pages/queue.js";
import { QueueController } from "./js/queue-controller.js";

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
const queueCtrl = new QueueController(api, router);

let menuManager = null;
let notifPoller = null;
let inactivityTracker = null;
let syncManager = null;

// 1.23: ссылка на ThemeController — unmount вызывается при полном teardown.
let themeCtrl = null;

// Защита от повторной инициализации: auth:loggedin и стартовая ветка
// вызывают initAuthorizedApp одновременно.
let initAuthorizedPromise = null;
let authorizedForUserId = null;

const TENANT_CACHE_KEY = "lift_tenant_info";
const TENANT_TTL = 5 * 60 * 1000;

/**
 * Централизованная очистка перед каждым переходом.
 * Регистрируется в router.onBeforeNavigate — вызывается ДО замены DOM,
 * поэтому unmount активных контроллеров видит старую разметку.
 * Каждый unmount идемпотентен.
 */
function leaveAll() {
  const targets = [
    ["openTicketsCtrl", openTicketsCtrl],
    ["closedTicketsCtrl", closedTicketsCtrl],
    ["detailsCtrl", detailsCtrl],
    ["createCtrl", createCtrl],
    ["queueCtrl", queueCtrl],
    ["settingsCtrl", settingsCtrl],
    ["profileCtrl", profileCtrl],
    ["loginCtrl", loginCtrl],
  ];
  for (const [name, ctrl] of targets) {
    try {
      ctrl.unmount?.();
    } catch (e) {
      console.warn(`[leaveAll] ${name}:`, e);
    }
  }
}

router.onBeforeNavigate(leaveAll);

// --- 1.15: какой экран заявок сейчас активен ---
function activeTicketsController() {
  if (openTicketsCtrl._isActive) return openTicketsCtrl;
  if (closedTicketsCtrl._isActive) return closedTicketsCtrl;
  return null;
}

/**
 * 1.11 + 1.21: шапка обновляется всегда, кнопка таблицы — только
 * у активного контроллера (guard внутри _updateSyncButton).
 */
function refreshSyncUi() {
  const ctrl = activeTicketsController() || openTicketsCtrl;
  Promise.resolve(ctrl._updateSyncButton()).catch((e) =>
    console.warn("[App] Не удалось обновить индикатор синхронизации:", e),
  );
  updateOutboxFlag();
}

/**
 * 1.21: флаг непустой очереди для beforeunload.
 * Повторный вызов во время чтения не плодит транзакции — ставим dirty
 * и пересчитываем один раз после завершения.
 * При ошибке чтения предыдущее значение сохраняем: неизвестность
 * не должна ни пугать лишним диалогом, ни снимать предупреждение.
 */
let outboxFlagBusy = false;
let outboxFlagDirty = false;
window.__hasPendingOutbox = false;

async function updateOutboxFlag() {
  if (outboxFlagBusy) {
    outboxFlagDirty = true;
    return;
  }
  outboxFlagBusy = true;
  try {
    const [pending, failed] = await Promise.all([
      offlineDB.getOutboxCount(),
      offlineDB.getFailedCount(),
    ]);
    window.__hasPendingOutbox = pending + failed > 0;
  } catch (e) {
    console.warn("[App] Не удалось прочитать счётчики очереди:", e);
  } finally {
    outboxFlagBusy = false;
    if (outboxFlagDirty) {
      outboxFlagDirty = false;
      updateOutboxFlag();
    }
  }
}

// 1.21: ровно одна регистрация, на верхнем уровне — не внутри runFailedCleanup.
window.addEventListener("beforeunload", (e) => {
  if (navigator.onLine || !authStore.hasAccess()) return;
  if (!window.__hasPendingOutbox) return;
  e.preventDefault();
  e.returnValue = "";
  return "";
});

// Момент потери связи — самый важный для предупреждения: пересчитываем флаг.
window.addEventListener("online", updateOutboxFlag);
window.addEventListener("offline", updateOutboxFlag);

// --- 1.23: полный teardown приложения ---
let tornDown = false;
function teardownApp() {
  if (tornDown) return;
  tornDown = true;

  leaveAll();

  try {
    themeCtrl?.unmount();
  } catch (e) {
    console.warn("[App] ThemeController.unmount:", e);
  }
  themeCtrl = null;

  try {
    notifPoller?.stop();
  } catch (e) {
    console.warn("[App] notifPoller.stop:", e);
  }
  notifPoller = null;

  try {
    inactivityTracker?.stopTracking();
  } catch (e) {
    console.warn("[App] inactivityTracker.stopTracking:", e);
  }
  inactivityTracker = null;
}

// bfcache: при persisted=true страница вернётся живой — рвать нельзя.
window.addEventListener("pagehide", (e) => {
  if (!e.persisted) teardownApp();
});

// --- ВСПОМОГАТЕЛЬНЫЕ ФУНКЦИИ ---
async function initAuthorizedApp() {
  const uid = authStore.getUser()?.id ?? null;
  if (initAuthorizedPromise) return initAuthorizedPromise;
  if (menuManager && authorizedForUserId === uid) return;

  initAuthorizedPromise = (async () => {
    if (!menuManager) {
      menuManager = new MenuManager(api, router, "dynamicMenu");
    }
    await menuManager.initialize();
    await initAppData();
    authorizedForUserId = uid;
  })().finally(() => {
    initAuthorizedPromise = null;
  });

  return initAuthorizedPromise;
}

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
      const formattedName =
        user.surname || user.name
          ? `${user.surname || ""} ${user.name || ""}`.trim()
          : "";
      navUserName.textContent = formattedName || "Пользователь";
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

async function initAppData() {
  try {
    const cities = await offlineDB.getCities();
    if (cities.length === 0) {
      const response = await api.post({ data: "loadAddress" }, null, "global");
      if (response && response.status === "ok") {
        const flatData = flattenAddresses(response);
        await offlineDB.saveAddresses(flatData);
        window.dispatchEvent(new CustomEvent("addresses:updated"));
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

/**
 * 1.18: единственный источник имени тенанта.
 * Правильный экшен — get_tenant_info, значение — resp.data.org_name
 * (API_PROTOCOL.md §18.3). Дублирующий блок в login-controller.js удалён.
 */
async function loadTenantInfo() {
  const tenantEl = document.getElementById("navTenantName");

  const paint = (name) => {
    if (tenantEl && name && String(name).trim()) {
      tenantEl.textContent = String(name).trim();
    }
  };

  let cached = null;
  try {
    const raw = localStorage.getItem(TENANT_CACHE_KEY);
    if (raw) cached = JSON.parse(raw);
  } catch (e) {
    console.warn("[App] Ошибка чтения кэша тенанта", e);
  }

  // 1. Мгновенно показываем из кэша; легаси-ключ — только если кэша нет.
  if (cached?.data?.org_name) {
    paint(cached.data.org_name);
  } else {
    paint(localStorage.getItem("lift_org_name"));
  }

  if (cached?.ts && Date.now() - cached.ts < TENANT_TTL) return;
  if (!navigator.onLine) return;

  // 2. Фоновое обновление
  try {
    const resp = await api.post({ action: "get_tenant_info" }, null, "public");
    if (resp && resp.status === "ok" && resp.data) {
      const orgName = resp.data.org_name || "";
      paint(orgName);
      localStorage.setItem(
        TENANT_CACHE_KEY,
        JSON.stringify({ data: resp.data, ts: Date.now() }),
      );
      // Обратная совместимость: пустое значение не пишем — иначе в шапке пробел.
      if (orgName) localStorage.setItem("lift_org_name", orgName);
      else localStorage.removeItem("lift_org_name");
    } else if (resp && resp.code === "tenant_not_found") {
      console.error("[App] Домен не привязан к организации");
    }
  } catch (err) {
    console.warn("[App] Не удалось фоновое обновление tenant_info:", err);
  }
}

// --- ЗАПУСК ПРИЛОЖЕНИЯ ---
document.addEventListener("DOMContentLoaded", async () => {
  // 1. Базовая инициализация
  loadTenantInfo();

  if (!themeCtrl) themeCtrl = new ThemeController("themeToggle");

  setNotifyRouter(router);
  syncTableSettingsFromStorage();
  syncIndicator.init();
  offlineBanner.init();

  // Справочник сотрудников
  window.addEventListener("sync:fetch_staff", async () => {
    if (menuManager) await menuManager.initialize();
  });

  // Справочники отделов / типов / групп
  window.addEventListener("sync:fetch_dicts", async () => {
    if (menuManager) await menuManager.initialize();
  });

  // 1.15: обновление открытых — только если экран активен.
  window.addEventListener("sync:fetch_open_tickets", () => {
    if (openTicketsCtrl._isActive) {
      openTicketsCtrl.refreshSilently(openTicketsArray);
    }
  });

  // 1.15: то же для закрытых. Ключ closed_tickets появится в волне 2 —
  // до этого событие просто не приходит, обработчик безвреден.
  window.addEventListener("sync:fetch_closed_tickets", () => {
    if (closedTicketsCtrl._isActive) {
      closedTicketsCtrl.refreshSilently(closedTicketsArray);
    }
  });

  // Адресный справочник
  window.addEventListener("sync:fetch_addresses", async () => {
    notify.info("Обновление справочника адресов. Пожалуйста, подождите...", {
      once: true,
    });
    try {
      const response = await api.post({ data: "loadAddress" }, null, "global");
      if (response && response.status === "ok") {
        const flatData = flattenAddresses(response);
        await offlineDB.saveAddresses(flatData);
        window.dispatchEvent(new CustomEvent("addresses:updated"));
        notify.success(`Справочник адресов обновлен (${flatData.length} шт.)`);
      }
    } catch (err) {
      console.error("[App] Ошибка фонового обновления адресов:", err);
      notify.error("Не удалось обновить справочник адресов.");
    }
  });

  // 2. Подписки на события
  // triggerSync и online обрабатываются ВНУТРИ SyncManager (_bindTriggers).

  // 1.11 + 1.21: активный контроллер + пересчёт флага очереди.
  window.addEventListener("refreshSyncState", refreshSyncUi);

  window.addEventListener("auth:updated", () => {
    syncAuthUI();
  });

  window.addEventListener("auth:loggedin", async () => {
    syncAuthUI();
    await initAuthorizedApp();
    updateOutboxFlag();
  });

  window.addEventListener(ApiService.AUTH_LOST_EVENT, (e) => {
    authStore.clear();
    authorizedForUserId = null;
    syncAuthUI();

    const msg =
      e.detail?.reason === "device_mismatch"
        ? "Устройство изменилось, войдите заново"
        : "Сессия истекла, войдите заново";

    logHistoryAction(msg);
    notify.warning(msg);
    router.navigate("#/login");
    // Outbox НЕ очищаем — при следующем логине синхронизация продолжится.
  });

  // 3. Аутентификация
  if (AUTH.BYPASS_AUTH) {
    authStore.setSession("mock-token", Date.now() + 86400000, {
      id: 1,
      name: "Тестовый Доступ",
      role: "guest",
    });
  } else {
    await api.tryAutoLogin();
  }

  // 4. Инициализация UI после авторизации
  syncAuthUI();
  if (authStore.hasAccess()) {
    await initAuthorizedApp();
  }

  const userProfileBtn = document.getElementById("userProfileBtn");
  const userDropdown = document.getElementById("userDropdown");
  const userProfileWrapper = document.getElementById("userProfileWrapper");

  if (userProfileBtn && userDropdown && userProfileWrapper) {
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
      authorizedForUserId = null;

      openTicketsArray.splice(0, openTicketsArray.length);
      closedTicketsArray.splice(0, closedTicketsArray.length);

      syncAuthUI();
      logHistoryAction("Вы вышли из системы");
      notify.info("Вы вышли из системы");
      router.navigate("#/login");
      // Outbox сохраняется — синхронизируется при следующем логине.
      // Тема не сбрасывается: ThemeController живёт до teardown приложения.
    };
  }

  const navLogo = document.getElementById("navLogo");
  if (navLogo) navLogo.addEventListener("click", () => router.navigate("#/"));

  // 6. Роутинг. leaveAll() вызывает router.onBeforeNavigate.
  router.addRoute(
    "#/login",
    () => loginPageTemplate(),
    () => loginCtrl.mount(),
  );
  router.addRoute(
    "#/",
    () => mainPageTemplate(),
    () => openTicketsCtrl.mount(openTicketsArray),
  );
  router.addRoute(
    "#/closed",
    () => mainPageTemplate(),
    () => closedTicketsCtrl.mount(closedTicketsArray),
  );
  router.addRoute(
    "#/create",
    () => createPageTemplate(),
    () => createCtrl.mount(openTicketsArray),
  );
  router.addRoute(
    "#/ticket",
    (id) => detailsPageTemplate(id),
    (id) => detailsCtrl.mount(id, [...openTicketsArray, ...closedTicketsArray]),
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
  router.addRoute(
    "#/queue",
    () => queuePageTemplate(),
    () => queueCtrl.mount(),
  );

  // 7. Сворачивание истории
  const historyWrapper = document.getElementById("historyWrapper");
  const historyTitle = document.getElementById("historyTitle");
  if (historyTitle && historyWrapper) {
    historyTitle.style.cursor = "pointer";
    historyTitle.onclick = () =>
      historyWrapper.classList.toggle("is-collapsed");
  }

  // 8. Синхронизация outbox
  syncManager = new SyncManager(
    api,
    router,
    (newTickets) => {
      // Атомарная замена: синхронный splice вместо .length=0 + .push.
      const safeTickets = Array.isArray(newTickets) ? newTickets : [];
      openTicketsArray.splice(0, openTicketsArray.length, ...safeTickets);

      // 1.15: рендерим только на активном экране открытых.
      if (openTicketsCtrl._isActive) {
        openTicketsCtrl.refreshFromMemory(openTicketsArray);
      }
      refreshSyncUi();
      // Колбэк уходит целиком в волне 2 (п. 2.1).
    },
    {
      onDuplicateDetected: (record, existingTickets) =>
        duplicateTicketModal.show(record, existingTickets),
    },
  );

  window.syncManagerInstance = syncManager;

  // Стартовая синхронизация. Задержку 3 с и debounce вводит волна 2 (п. 2.11).
  if (navigator.onLine) {
    setTimeout(() => syncManager.startSync(), 1000);
  }

  const runFailedCleanup = () => {
    // Если менеджер синхронизирует — откладываем, защищаясь от гонки
    // read-write транзакций в IndexedDB.
    if (window.syncManagerInstance?.isSyncing) {
      setTimeout(runFailedCleanup, 60_000);
      return;
    }

    offlineDB
      .cleanupFailed(7)
      .then((removed) => {
        if (removed > 0) {
          console.log(`[App] Очищено устаревших failed-команд: ${removed}`);
          window.dispatchEvent(new Event("refreshSyncState"));
        }
        updateOutboxFlag();
      })
      .catch((err) => {
        console.warn("[App] Ошибка очистки failed-команд:", err);
        updateOutboxFlag();
      });
  };

  runFailedCleanup();
  updateOutboxFlag();

  // 9. Service Worker & PWA Auto-Update
  const updateSW = registerSW({
    onNeedRefresh() {
      notify.warning("Доступна новая версия приложения", {
        timeout: 0,
        persistent: true,
        actionText: "Обновить сейчас",
        onAction: () => {
          updateSW(true);
        },
      });
    },
    onOfflineReady() {
      notify.success("Приложение готово к работе офлайн", { once: true });
    },
    onRegisterError(error) {
      console.error("❌ Ошибка регистрации SW:", error);
    },
  });

  // 10. Старт роутера
  router._handleRoute();
});
