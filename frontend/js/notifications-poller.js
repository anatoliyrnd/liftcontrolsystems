import { notify } from "./components/notify.js";
import { logHistoryAction } from "./history-logger.js";
import { staffStore } from "./staff-store.js";
import { dictStore } from "./dict-store.js";
import { authStore } from "./auth-store.js";
import { API, BUSINESS, SYNC } from "./config.js";
import { escapeHtml } from "./utils/escape-html.js";
import { withIdbWriteLock } from "./utils/idb-write-lock.js";

const STORAGE_KEY = API.NOTIFICATIONS_STORAGE_KEY;
const POLL_INTERVAL_MS = API.NOTIFICATIONS_POLL_MS;
const TYPE_MAP = BUSINESS.EVENT_TOAST_TYPE;
const RELOAD_PENDING_KEY = "forceReloadPending";
const RELOAD_SNOOZE_MS = 20 * 1000;

export class NotificationsPoller {
  constructor(api) {
    this.api = api;
    this.intervalId = null;
    this.isRunning = false;
    this._reloadModalShown = false;
    this._isTicking = false;

    this._onVisibilityChange = this._onVisibilityChange.bind(this);
     this._refreshStores = this._refreshStores.bind(this); 
  }
 _handleForceReload(reason) {
    console.warn("[NotificationsPoller] Получен force_reload. Причина:", reason);
    // TODO: реализовать модалку принудительной перезагрузки, если потребуется.
    // Пока просто игнорируем, чтобы не крашить приложение.
  }
  start() {
    if (this.isRunning) return;
    this.isRunning = true;

    this._tick();
    this.intervalId = setInterval(() => this._tick(), POLL_INTERVAL_MS);
    document.addEventListener("visibilitychange", this._onVisibilityChange);
  }

  stop() {
    this.isRunning = false;
    if (this.intervalId) {
      clearInterval(this.intervalId);
      this.intervalId = null;
    }
    document.removeEventListener("visibilitychange", this._onVisibilityChange);
  }

  _onVisibilityChange() {
    if (!this.isRunning) return;
    if (document.visibilityState === "visible") {
      this._tick();
    }
  }

  async _tick() {
    if (this._isTicking) return;
    if (!navigator.onLine) return;
    if (!authStore.hasAccess()) return;

    this._isTicking = true;
    try {
      const sinceId = this._loadLastId();
      const localVersions = this._loadVersions();

      const response = await this.api.post(
        { data: "notifications", since_id: sinceId, versions: localVersions },
        "",
      );

      if (!response || typeof response !== "object") return;
      if (response._authLost === true) return;

          // 🚨 ОБРАБОТКА ВЕРСИЙ (ДЕЛЬТА-СИНХРОНИЗАЦИЯ) 🚨
      if (response.versions) {
        const serverVersions = response.versions;
        
        // 1. Нормализуем ключи (бэкенд отдает tickets, фронт ждет open_tickets)
        const vTickets = Number(serverVersions.tickets ?? serverVersions.open_tickets ?? 0);
        const vStaff = Number(serverVersions.staff ?? 0);
        const vDicts = Number(serverVersions.dicts ?? 0);
        const vAddresses = Number(serverVersions.addresses ?? 0);

        const lTickets = Number(localVersions.open_tickets ?? 0);
        const lStaff = Number(localVersions.staff ?? 0);
        const lDicts = Number(localVersions.dicts ?? 0);
        const lAddresses = Number(localVersions.addresses ?? 0);

        // 2. Используем Set, чтобы избежать двойных перезагрузок за один тик
        const eventsToDispatch = new Set();

        if (vTickets > lTickets) eventsToDispatch.add("sync:fetch_open_tickets");
        if (vStaff > lStaff) eventsToDispatch.add("sync:fetch_staff");
        if (vDicts > lDicts) eventsToDispatch.add("sync:fetch_dicts");
        if (vAddresses > lAddresses) eventsToDispatch.add("sync:fetch_addresses");

        // 3. Сохраняем нормализованные версии (чтобы tickets всегда сохранялся как open_tickets)
        this._saveVersions({
          open_tickets: vTickets,
          staff: vStaff,
          dicts: vDicts,
          addresses: vAddresses
        });

        // 4. Обрабатываем массив outdated (добавляем в тот же Set)
        if (Array.isArray(response.outdated)) {
            if (response.outdated.includes("open_tickets") || response.outdated.includes("tickets")) {
                eventsToDispatch.add("sync:fetch_open_tickets");
            }
            if (response.outdated.includes("staff")) eventsToDispatch.add("sync:fetch_staff");
            if (response.outdated.includes("dicts")) eventsToDispatch.add("sync:fetch_dicts");
            if (response.outdated.includes("addresses")) eventsToDispatch.add("sync:fetch_addresses");
        }

        // 5. Кидаем уникальные события (только если не идет фоновая синхронизация)
        if (!window.syncManagerInstance?.isSyncing) {
          eventsToDispatch.forEach(eventName => {
            window.dispatchEvent(new CustomEvent(eventName));
          });
        }
      }
      const events = Array.isArray(response.notifications) ? response.notifications : [];
      
      await withIdbWriteLock(async () => {
        const newLastId = parseInt(response.last_id, 10);
        if (!isNaN(newLastId) && newLastId > sinceId) {
          this._saveLastId(newLastId);
        }
      /*   if (Array.isArray(response.outdated) && response.outdated.length > 0) {
          await this._refreshStores(response.outdated);
        } */
      });

      if (response.force_reload === true) {
        this._handleForceReload(response.reason);
      }

      if (events.length === 0) return;

      const myId = authStore.getUser()?.id;
      const filteredEvents = events.filter((ev) => ev.actor_id !== myId);

      const toasts = filteredEvents.map((ev) => ({
        id: "ntf_" + ev.id,
        type: TYPE_MAP[ev.event_type] || "info",
        text: ev.text,
        ticketId: ev.ticket_id || null,
        once: false,
        sound: !!ev.sound,
        timeout: typeof ev.timeout === "number" ? ev.timeout : undefined,
      }));

      filteredEvents.forEach((ev) => {
        if (ev.text) logHistoryAction(ev.text);
      });

      if (toasts.length > 0) notify.batch(toasts);
    } catch (err) {
      console.warn("[NotificationsPoller] Ошибка опроса:", err);
    } finally {
      this._isTicking = false;
    }
  }

  // ... (методы _refreshStores, _handleForceReload, _showReloadModal без изменений) ...

  _loadLastId() {
    try {
      const v = parseInt(localStorage.getItem(STORAGE_KEY) || "0", 10);
      return isNaN(v) ? 0 : v;
    } catch (e) {
      return 0;
    }
  }

  _saveLastId(id) {
    try {
      localStorage.setItem(STORAGE_KEY, String(id));
    } catch (e) {}
  }

 _loadVersions() {
    try {
      const raw = localStorage.getItem(SYNC.VERSIONS_STORAGE_KEY);
      if (!raw) return { staff: 0, dicts: 0, addresses: 0, open_tickets: 0 };
      const parsed = JSON.parse(raw);
      return parsed && typeof parsed === "object" 
        ? { staff: 0, dicts: 0, addresses: 0, open_tickets: 0, ...parsed } 
        : { staff: 0, dicts: 0, addresses: 0, open_tickets: 0 };
    } catch (e) {
      return { staff: 0, dicts: 0, addresses: 0, open_tickets: 0 };
    }
  }

  _saveVersions(versions) {
    try {
      localStorage.setItem(SYNC.VERSIONS_STORAGE_KEY, JSON.stringify(versions));
    } catch (e) {}
  }
    async _refreshStores(outdatedArray) {
   /*  if (!outdatedArray || !outdatedArray.length) return;
    
    // Примерная логика: если в outdated есть 'open_tickets', стучимся в Main.js
    if (outdatedArray.includes("open_tickets")) {
        window.dispatchEvent(new CustomEvent("sync:fetch_open_tickets"));
    }
    if (outdatedArray.includes("addresses")) {
        window.dispatchEvent(new CustomEvent("sync:fetch_addresses"));
    } */
  }
}