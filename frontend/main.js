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

const openTicketsArray = [];
const closedTicketsArray = [];

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
let themeCtrl = null;

let initAuthorizedPromise = null;
let authorizedForUserId = null;
let addressesLoading = false;
let addressesReloadPending = false;

const TENANT_CACHE_KEY = "lift_tenant_info";
const TENANT_TTL = 5 * 60 * 1000;

/**
 * Единая точка очистки перед сменой маршрута.
 * Вызывается ДО замены DOM, поэтому unmount видит старую разметку.
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

function activeTicketsController() {
  if (openTicketsCtrl._isActive) return openTicketsCtrl;
  if (closedTicketsCtrl._isActive) return closedTicketsCtrl;
  return null;
}

/** Шапка — всегда; кнопка таблицы — только у активного экрана. */
function refreshSyncUi() {
  const ctrl = activeTicketsController() || openTicketsCtrl;
  Promise.resolve(ctrl._updateSyncButton()).catch((e) =>
    console.warn("[App] Не удалось обновить индикатор синхронизации:", e),
  );
  updateOutboxFlag();
}

// --- 1.21: флаг непустой очереди для beforeunload ---
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
    const c = await offlineDB.getOutboxCounts();
    // После 2.14 getOutboxCount = только pending. Для предупреждения
    // о потере работы учитываем все четыре статуса.
    window.__hasPendingOutbox = c.total > 0;
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

window.addEventListener("beforeunload", (e) => {
  if (navigator.onLine || !authStore.hasAccess()) return;
  if (!window.__hasPendingOutbox) return;
  e.preventDefault();
  e.returnValue = "";
  return "";
});

window.addEventListener("online", updateOutboxFlag);
window.addEventListener("offline", updateOutboxFlag);
// --- Обновление схемы IndexedDB между вкладками ---
// Регистрация ДО первого обращения к offlineDB: событие blocked
// диспатчится синхронно внутри openDB и не переигрывается.
let dbUpgradeToast = null;

window.addEventListener("db:upgrade-blocked", () => {
  if (dbUpgradeToast) return;
  logHistoryAction(
    "Обновление базы данных ожидает закрытия других вкладок приложения.",
  );
  dbUpgradeToast = notify.warning(
    "Обновление базы данных заблокировано другой вкладкой. Закройте остальные вкладки приложения и обновите страницу.",
    {
      timeout: 0,
      persistent: true,
      actionText: "Обновить страницу",
      onAction: () => window.location.reload(),
    },
  );
});

// Блокировка снялась: другая вкладка отпустила соединение, апгрейд прошёл.
window.addEventListener("db:upgrade-ready", () => {
  dbUpgradeToast?.dismiss?.();
  dbUpgradeToast = null;
  notify.success("База данных обновлена. Можно продолжать работу.", {
    once: true,
  });
});

// Мы держали старую версию, соединение уже закрыто в blocking().
// Работать дальше нельзя — данные пишет другая вкладка на новой схеме.
window.addEventListener("db:upgrade-required", () => {
  logHistoryAction(
    "База данных обновлена в другой вкладке. Требуется перезагрузка страницы.",
  );
  notify.warning(
    "Данные приложения обновлены в другой вкладке. Обновите страницу.",
    {
      timeout: 0,
      persistent: true,
      actionText: "Обновить страницу",
      onAction: () => window.location.reload(),
    },
  );
});
// --- 1.23: полный teardown приложения ---
let tornDown = false;
function teardownApp() {
  if (tornDown) return;
  tornDown = true;

 leaveAll();

  try {
    detailsCtrl.destroy?.();
  } catch (e) {
    console.warn("[App] detailsCtrl.destroy:", e);
  }

  try {
    themeCtrl?.unmount?.();
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

// bfcache: persisted=true — страница вернётся живой, рвать нельзя.
window.addEventListener("pagehide", (e) => {
  if (!e.persisted) teardownApp();
});

async function initAuthorizedApp() {
  const uid = authStore.getUser()?.id ?? null;
  if (initAuthorizedPromise) return initAuthorizedPromise;
  if (menuManager && authorizedForUserId === uid) return;

  initAuthorizedPromise = (async () => {
    if (!menuManager) menuManager = new MenuManager(api, router, "dynamicMenu");
    await menuManager.initialize();
    await refreshAddresses({ silent: true });
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
      const formatted = `${user.surname || ""} ${user.name || ""}`.trim();
      navUserName.textContent = formatted || "Пользователь";
    }
    if (navUserAvatar) {
      const nameForAvatar = user.name || user.surname || "Пользователь";
      navUserAvatar.textContent = nameForAvatar.charAt(0).toUpperCase();
    }

    if (!notifPoller) {
      notifPoller = new NotificationsPoller(api);
      notifPoller.start();
      window.notificationsPollerInstance = notifPoller;
    }
    if (!inactivityTracker) {
      inactivityTracker = new InactivityTracker(router, 30 * 60 * 1000);
      inactivityTracker.startTracking();
    }
  } else {
    if (historyWrapper) historyWrapper.style.display = "none";
    if (userProfileWrapper) userProfileWrapper.style.display = "none";

    notifPoller?.stop();
    notifPoller = null;
    inactivityTracker?.stopTracking();
    inactivityTracker = null;

    const menu = document.getElementById("dynamicMenu");
    if (menu) menu.innerHTML = "";
  }
}

/**
 * Единая загрузка адресов с защитой от повторного входа.
 * Кэш не очищается до получения новых данных.
 */
async function refreshAddresses({ silent = false, force = false } = {}) {
  if (addressesLoading) {
    addressesReloadPending = true;
    return;
  }
  addressesLoading = true;

  try {
    if (!force) {
      const cities = await offlineDB.getCities();
      if (cities.length > 0) return;
    }
    if (!navigator.onLine) return;

    if (!silent) {
      notify.info("Обновление справочника адресов. Пожалуйста, подождите...", {
        once: true,
      });
    }

    const response = await api.post({ data: "loadAddress" }, null, "global");
    if (response && response.status === "ok") {
      const flatData = flattenAddresses(response);
      if (flatData.length === 0) throw new Error("Пустой справочник адресов");
      await offlineDB.saveAddresses(flatData);
      window.dispatchEvent(new CustomEvent("addresses:updated"));
      notify.success(`Справочник адресов загружен (${flatData.length} шт.)`, {
        once: true,
      });
    }
  } catch (err) {
    console.error("[App] Ошибка загрузки адресов:", err);
    if (!silent) notify.error("Не удалось обновить справочник адресов.");
  } finally {
    addressesLoading = false;
    if (addressesReloadPending) {
      addressesReloadPending = false;
      refreshAddresses({ silent: true, force: true });
    }
  }
}

/** Единственный источник имени тенанта — get_tenant_info (§18.3). */
async function loadTenantInfo() {
  const tenantEl = document.getElementById("navTenantName");
  const paint = (name) => {
    const value = name == null ? "" : String(name).trim();
    if (tenantEl && value) tenantEl.textContent = value;
  };

  let cached = null;
  try {
    const raw = localStorage.getItem(TENANT_CACHE_KEY);
    if (raw) cached = JSON.parse(raw);
  } catch (e) {
    console.warn("[App] Ошибка чтения кэша тенанта", e);
  }

  if (cached?.data?.org_name) paint(cached.data.org_name);
  else paint(localStorage.getItem("lift_org_name"));

  if (cached?.ts && Date.now() - cached.ts < TENANT_TTL) return;
  if (!navigator.onLine) return;

  try {
    const resp = await api.post({ action: "get_tenant_info" }, null, "public");
    if (resp && resp.status === "ok" && resp.data) {
      const orgName = (resp.data.org_name || "").trim();
      paint(orgName);
      localStorage.setItem(
        TENANT_CACHE_KEY,
        JSON.stringify({ data: resp.data, ts: Date.now() }),
      );
      if (orgName) localStorage.setItem("lift_org_name", orgName);
      else localStorage.removeItem("lift_org_name");
    } else if (resp && resp.code === "tenant_not_found") {
      console.error("[App] Домен не привязан к организации");
    }
  } catch (err) {
    console.warn("[App] Не удалось фоновое обновление tenant_info:", err);
  }
}

document.addEventListener("DOMContentLoaded", async () => {
  loadTenantInfo();

  if (!themeCtrl) themeCtrl = new ThemeController("themeToggle");

  setNotifyRouter(router);
  syncTableSettingsFromStorage();
  syncIndicator.init();
  offlineBanner.init();

window.addEventListener("sync:fetch_staff", async (e) => {
    const version = e.detail?.version;
    try {
        if (!menuManager) await initAuthorizedApp();   // дедуп уже есть внутри
        const ok = await menuManager.initialize();
        if (!ok) throw new Error("config not applied");
        if (version != null) {
            window.dispatchEvent(new CustomEvent("sync:applied", {
                detail: { layer: "staff", version },
            }));
        }
    } catch (err) {
        window.dispatchEvent(new CustomEvent("sync:apply_failed", {
            detail: { layer: "staff" },
        }));
    }
});
window.addEventListener("sync:fetch_dicts", async (e) => {
    const version = e.detail?.version;
    try {
        if (!menuManager) await initAuthorizedApp();   // дедуп уже есть внутри
        const ok = await menuManager.initialize();
        if (!ok) throw new Error("config not applied");
        if (version != null) {
            window.dispatchEvent(new CustomEvent("sync:applied", {
                detail: { layer: "dicts", version },
            }));
        }
    } catch (err) {
        window.dispatchEvent(new CustomEvent("sync:apply_failed", {
            detail: { layer: "dicts" },
        }));
    }
});


window.addEventListener("sync:fetch_addresses", async (e) => {
  const version = e.detail?.version;
  try {
    await refreshAddresses({ force: true });
    if (version != null) {
      window.dispatchEvent(new CustomEvent("sync:applied", {
        detail: { layer: "addresses", version },
      }));
    }
  } catch (err) {
    window.dispatchEvent(new CustomEvent("sync:apply_failed", {
      detail: { layer: "addresses" },
    }));
  }
});

window.addEventListener("sync:fetch_open_tickets", async (e) => {
  const version = e.detail?.version;
  try {
    if (openTicketsCtrl.isActive) {
      await openTicketsCtrl.refreshSilently(openTicketsArray);
    }
    if (version != null) {
      window.dispatchEvent(new CustomEvent("sync:applied", {
        detail: { layer: "open_tickets", version },
      }));
    }
  } catch (err) {
    window.dispatchEvent(new CustomEvent("sync:apply_failed", {
      detail: { layer: "open_tickets" },
    }));
  }
});

window.addEventListener("sync:fetch_closed_tickets", async (e) => {
  const version = e.detail?.version;
  try {
    if (closedTicketsCtrl.isActive) {
      await closedTicketsCtrl.refreshSilently(closedTicketsArray);
    }
    if (version != null) {
      window.dispatchEvent(new CustomEvent("sync:applied", {
        detail: { layer: "closed_tickets", version },
      }));
    }
  } catch (err) {
    window.dispatchEvent(new CustomEvent("sync:apply_failed", {
      detail: { layer: "closed_tickets" },
    }));
  }
});

  window.addEventListener("refreshSyncState", refreshSyncUi);

  window.addEventListener("auth:updated", syncAuthUI);

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
    // Outbox сохраняем — синхронизация продолжится при следующем логине.
  });

  if (AUTH.BYPASS_AUTH) {
    authStore.setSession("mock-token", Date.now() + 86400000, {
      id: 1,
      name: "Тестовый Доступ",
      role: "guest",
    });
  } else {
    await api.tryAutoLogin();
  }

  syncAuthUI();
  if (authStore.hasAccess()) await initAuthorizedApp();

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
    };
  }

  const navLogo = document.getElementById("navLogo");
  if (navLogo) navLogo.addEventListener("click", () => router.navigate("#/"));

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

  const historyWrapper = document.getElementById("historyWrapper");
  const historyTitle = document.getElementById("historyTitle");
  if (historyTitle && historyWrapper) {
    historyTitle.style.cursor = "pointer";
    historyTitle.onclick = () =>
      historyWrapper.classList.toggle("is-collapsed");
  }

  syncManager = new SyncManager(
    api,
    router,
    (newTickets) => {
      const safeTickets = Array.isArray(newTickets) ? newTickets : [];
      openTicketsArray.splice(0, openTicketsArray.length, ...safeTickets);
      if (openTicketsCtrl._isActive)
        openTicketsCtrl.refreshFromMemory(openTicketsArray);
      refreshSyncUi();
    },
    {
      onDuplicateDetected: (record, existingTickets) =>
        duplicateTicketModal.show(record, existingTickets),
    },
  );

  window.syncManagerInstance = syncManager;

  if (navigator.onLine) {
    setTimeout(() => syncManager.startSync(), 1000);
  }

  const runFailedCleanup = () => {
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

  const updateSW = registerSW({
    onNeedRefresh() {
      notify.warning("Доступна новая версия приложения", {
        timeout: 0,
        persistent: true,
        actionText: "Обновить сейчас",
        onAction: () => updateSW(true),
      });
    },
    onOfflineReady() {
      notify.success("Приложение готово к работе офлайн", { once: true });
    },
    onRegisterError(error) {
      console.error("❌ Ошибка регистрации SW:", error);
    },
  });

  router._handleRoute();
});
