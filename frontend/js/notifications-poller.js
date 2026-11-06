/**
 * Поллер серверных событий и синхронизации справочников.
 * Раз в 120 секунд:
 *   - Запрашивает эндпоинт `notifications` — события + версии справочников.
 *   - Показывает тосты и пишет события в блок «История».
 *   - Если сервер отметил справочники устаревшими (outdated) — догружает их.
 *   - Если пришёл force_reload — показывает модалку «Требуется обновление».
 *
 * Защита от длительной работы вкладки (24+ часа):
 *   - visibilitychange listener — внеочередной тик при возврате на вкладку
 *     (браузеры throttle'ят setInterval в фоне до 1 раза в минуту).
 *   - Проверка authStore.hasAccess() — не делаем запросы с истекшей сессией.
 *   - Проверка response._authLost — делегируем редирект глобальному обработчику
 *     в main.js (который слушает ApiService.AUTH_LOST_EVENT).
 */
import { notify } from "./components/notify.js";
import { logHistoryAction } from "./history-logger.js";
import { staffStore } from "./staff-store.js";
import { dictStore } from "./dict-store.js";
import { authStore } from "./auth-store.js";
import { API, BUSINESS, SYNC } from "./config.js";
import { escapeHtml } from "./utils/escape-html.js";
import { withIdbWriteLock } from "./utils/idb-write-lock.js";
import { syncTimestamps } from "./utils/sync-timestamps.js";
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
    // Флаг «тик в процессе». Без него setInterval(120s) плодит висящие
    // промисы при нестабильной сети: каждый тик делает await api.post
    // (до 15s) + await withIdbWriteLock (ждёт SyncManager). За 3 минуты
    // в очереди лока может накопиться 2–3 «висяка».
    this._isTicking = false;

    // Привязываем контекст для visibility listener'а
    this._onVisibilityChange = this._onVisibilityChange.bind(this);
  }

  start() {
    if (this.isRunning) return;
    this.isRunning = true;

    // Мгновенный тик при старте
    this._tick();

    // Интервал работает ВСЕГДА (даже в фоне)
    this.intervalId = setInterval(() => this._tick(), POLL_INTERVAL_MS);

    // При возврате на вкладку — внеочередной тик
    // (браузер мог «задушить» фоновые таймеры до 1 раза в минуту)
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
      // Браузер мог «задушить» фоновые таймеры.
      // При возврате делаем тик немедленно, чтобы пользователь
      // сразу увидел актуальные данные.
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
      const versions = this._loadVersions();

      // Запрос к серверу (без отправки timestamps)
      const response = await this.api.post(
        { data: "notifications", since_id: sinceId, versions },
        "",
      );

      if (!response || typeof response !== "object") return;
      if (response._authLost === true) return;

      // ✅ ОБРАБОТКА ДЕЛЬТА-СИНХРОНИЗАЦИИ (сравниваем метки)
      if (response.timestamps) {
        const serverTs = response.timestamps;
        const localTs = syncTimestamps.getAll();
        const newTs = {};
        let shouldFetchOpen = false;
        let shouldFetchClosed = false;

        // Открытые заявки (комментарии внутри них)
        if (
          serverTs.open_tickets > (localTs.open_tickets || 0) ||
          serverTs.comments > (localTs.comments || 0)
        ) {
          shouldFetchOpen = true;
          if (serverTs.open_tickets) newTs.open_tickets = serverTs.open_tickets;
          if (serverTs.comments) newTs.comments = serverTs.comments;
        }

        // Закрытые заявки
        if (serverTs.closed_tickets > (localTs.closed_tickets || 0)) {
          shouldFetchClosed = true;
          newTs.closed_tickets = serverTs.closed_tickets;
        }

        // Адреса
        if (serverTs.addresses > (localTs.addresses || 0)) {
          newTs.addresses = serverTs.addresses;
          window.dispatchEvent(new CustomEvent("sync:fetch_addresses"));
        }

        // Сохраняем новые метки
        if (Object.keys(newTs).length > 0) {
          syncTimestamps.setMany(newTs);
        }

        // Кидаем события, чтобы контроллеры обновились
        if (!window.syncManagerInstance?.isSyncing) {
          if (shouldFetchOpen)
            window.dispatchEvent(new CustomEvent("sync:fetch_open_tickets"));
          if (shouldFetchClosed)
            window.dispatchEvent(new CustomEvent("sync:fetch_closed_tickets"));
        }

        if (
          window.location.hash.startsWith("#/ticket/") &&
          (shouldFetchOpen || shouldFetchClosed)
        ) {
          window.dispatchEvent(new CustomEvent("sync:refresh_current_ticket"));
        }
      }

      // Обработка событий и справочников (как было)
      const events = Array.isArray(response.notifications)
        ? response.notifications
        : [];
      await withIdbWriteLock(async () => {
        const newLastId = parseInt(response.last_id, 10);
        if (!isNaN(newLastId) && newLastId > sinceId)
          this._saveLastId(newLastId);
        if (response.versions) this._saveVersions(response.versions);
        if (Array.isArray(response.outdated) && response.outdated.length > 0)
          await this._refreshStores(response.outdated);
      });

      if (response.force_reload === true)
        this._handleForceReload(response.reason);
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

  // ========================================================================
  // Синхронизация справочников
  // ========================================================================

  /**
   * Догрузить store'ы, которые сервер отметил устаревшими.
   * Поддерживаемые ключи: 'staff', 'dicts'.
   * Ключ 'addresses' пока не обрабатывается — реестр адресов в SPA не загружен.
   * @param {string[]} keys
   */
  async _refreshStores(keys) {
    for (const key of keys) {
      try {
        if (key === "staff") {
          const resp = await this.api.post({ data: "staff_list" }, "");
          if (resp && Array.isArray(resp.staff_list)) {
            staffStore.setList(resp.staff_list);
          }
        } else if (key === "dicts") {
          const resp = await this.api.post({ data: "dicts" }, "");
          if (resp) {
            if (resp.department) dictStore.set("department", resp.department);
            if (resp.request) dictStore.set("request", resp.request);
            if (resp.group) dictStore.set("group", resp.group);
          }
        }
        // Ключ 'addresses' — осознанно игнорируется
      } catch (err) {
        console.warn(
          "[NotificationsPoller] Не удалось обновить store:",
          key,
          err,
        );
      }
    }
  }

  // ========================================================================
  // Force reload
  // ========================================================================

  _handleForceReload(reason) {
    // Уже показали — ждём решения пользователя
    if (this._reloadModalShown) return;

    // Пользователь отложил — уважаем его выбор 15 минут
    const snoozedUntil = parseInt(
      localStorage.getItem(RELOAD_PENDING_KEY) || "0",
      10,
    );
    if (snoozedUntil && Date.now() < snoozedUntil) return;

    this._reloadModalShown = true;
    this._showReloadModal(reason || "Обновление данных на сервере");
  }

  _showReloadModal(reason) {
    const overlay = document.createElement("div");
    overlay.style.cssText =
      "position: fixed; inset: 0; background: rgba(0,0,0,0.5); z-index: 99999; display: flex; align-items: center; justify-content: center; padding: 20px;";

    const box = document.createElement("div");
    box.style.cssText =
      "background: var(--bg-secondary); border: 2px solid var(--border-color); border-radius: 12px; padding: 24px; max-width: 420px; width: 100%; box-shadow: var(--shadow);";

    // reason приходит из ответа сервера (response.reason при force_reload).
    // Сервер контролируемый, но: force_reload может отдавать любой action,
    // а escapeHtml стоит ~0 нс — вставляем превентивно.
    box.innerHTML = `
      <h2 style="margin: 0 0 12px; font-size: 1.2rem; color: var(--text-primary);">Требуется обновление</h2>
      <p style="margin: 0 0 6px; color: var(--text-secondary); font-size: 14px;">${escapeHtml(reason)}</p>
      <p style="margin: 0 0 18px; color: var(--text-secondary); font-size: 13px;">Нажмите «Обновить сейчас» — это займёт 1–2 секунды. Все открытые формы будут закрыты.</p>
      <div style="display: flex; gap: 10px; justify-content: flex-end;">
        <button id="reloadLaterBtn" style="padding: 8px 16px; border-radius: 6px; border: 2px solid var(--border-color); background: var(--bg-primary); color: var(--text-primary); cursor: pointer; font-size: 13px; font-weight: 600;">Позже (15 мин)</button>
        <button id="reloadNowBtn" style="padding: 8px 16px; border-radius: 6px; border: none; background: var(--accent); color: var(--mark-text); cursor: pointer; font-size: 13px; font-weight: 700;">Обновить сейчас</button>
      </div>
    `;

    overlay.appendChild(box);
    document.body.appendChild(overlay);

    const close = () => {
      overlay.remove();
      this._reloadModalShown = false;
    };

    document.getElementById("reloadNowBtn").onclick = () => {
      try {
        localStorage.removeItem(RELOAD_PENDING_KEY);
      } catch (e) {}
      window.location.reload();
    };

    document.getElementById("reloadLaterBtn").onclick = () => {
      try {
        localStorage.setItem(
          RELOAD_PENDING_KEY,
          String(Date.now() + RELOAD_SNOOZE_MS),
        );
      } catch (e) {}
      logHistoryAction("Обновление отложено на 15 минут.");
      close();
    };
  }

  // ========================================================================
  // localStorage-обёртки
  // ========================================================================

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
      if (!raw) return { staff: 0, dicts: 0 };
      const parsed = JSON.parse(raw);
      return parsed && typeof parsed === "object"
        ? parsed
        : { staff: 0, dicts: 0 };
    } catch (e) {
      return { staff: 0, dicts: 0 };
    }
  }

  _saveVersions(versions) {
    try {
      localStorage.setItem(SYNC.VERSIONS_STORAGE_KEY, JSON.stringify(versions));
    } catch (e) {}
  }
}
