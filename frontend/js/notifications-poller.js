import { notify } from "./components/notify.js";
import { logHistoryAction } from "./history-logger.js";
import { authStore } from "./auth-store.js";
import { API, BUSINESS } from "./config.js";
import { withIdbWriteLock } from "./utils/idb-write-lock.js";

const STORAGE_KEY = API.NOTIFICATIONS_STORAGE_KEY;
const POLL_INTERVAL_MS = API.NOTIFICATIONS_POLL_MS;
const TYPE_MAP = BUSINESS.EVENT_TOAST_TYPE;

// 2.22: applied-версии отдельно от seen. Отправляем applied — то, что
// клиент реально применил; отметка ставится в обработчике после записи.
const APPLIED_STORAGE_KEY = "syncAppliedVersions";

// 2.23: три неудачи слоя → cooldown 10 минут, остальные слои работают.
const LAYER_FAILURES_STORAGE_KEY = "syncLayerFailures";
const LAYER_FAIL_LIMIT = 3;
const LAYER_COOLDOWN_MS = 10 * 60 * 1000;

// §11.3: два ключа версий, не tickets.
const LAYERS = [
  "open_tickets",
  "closed_tickets",
  "staff",
  "dicts",
  "addresses",
];

const LAYER_EVENT = {
  open_tickets: "sync:fetch_open_tickets",
  closed_tickets: "sync:fetch_closed_tickets",
  staff: "sync:fetch_staff",
  dicts: "sync:fetch_dicts",
  addresses: "sync:fetch_addresses",
};

function emptyVersions() {
  const o = {};
  for (const l of LAYERS) o[l] = 0;
  return o;
}

export class NotificationsPoller {
  constructor(api) {
    this.api = api;
    this.intervalId = null;
    this.isRunning = false;
    this._isTicking = false;

    this._onVisibilityChange = this._onVisibilityChange.bind(this);
    this._onApplied = this._onApplied.bind(this);
    this._onApplyFailed = this._onApplyFailed.bind(this);
    this._onAppliedReset = this._onAppliedReset.bind(this);
  }

  start() {
    if (this.isRunning) return;
    this.isRunning = true;

    window.addEventListener("sync:applied", this._onApplied);
    window.addEventListener("sync:apply_failed", this._onApplyFailed);
    window.addEventListener("sync:applied_reset", this._onAppliedReset);

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
    window.removeEventListener("sync:applied", this._onApplied);
    window.removeEventListener("sync:apply_failed", this._onApplyFailed);
    window.removeEventListener("sync:applied_reset", this._onAppliedReset);
    document.removeEventListener("visibilitychange", this._onVisibilityChange);
  }

  _onVisibilityChange() {
    if (!this.isRunning) return;
    if (document.visibilityState === "visible") this._tick();
  }

  /** 2.22: применяем версию только после успешной записи в обработчике. */
  _onApplied(e) {
    const { layer, version } = e.detail || {};
    if (!LAYERS.includes(layer)) return;
    if (version == null) return;

    const applied = this._loadApplied();
    if (Number(version) > (applied[layer] || 0)) {
      applied[layer] = Number(version);
      this._saveApplied(applied);
    }
    this._resetLayerFailure(layer);
  }

  _onApplyFailed(e) {
    const { layer } = e.detail || {};
    if (!LAYERS.includes(layer)) return;
    this._markLayerFailure(layer);
  }

  /** 2.27: после успешного синка сбрасываем applied — тик подтянет свежее. */
  _onAppliedReset(e) {
    const { layers } = e.detail || {};
    const list = Array.isArray(layers) ? layers : LAYERS;
    const applied = this._loadApplied();
    let changed = false;
    for (const l of list) {
      if (LAYERS.includes(l)) {
        applied[l] = 0;
        changed = true;
      }
    }
    if (!changed) return;
    this._saveApplied(applied);
    if (this.isRunning) this._tick();
  }

  async _tick() {
    if (this._isTicking) return;
    if (!navigator.onLine) return;
    if (!authStore.hasAccess()) return;

    this._isTicking = true;
    try {
      const sinceId = this._loadLastId();
      const applied = this._loadApplied();

      const response = await this.api.post(
        { data: "notifications", since_id: sinceId, versions: applied },
        "",
      );

      if (!response || typeof response !== "object") return;
      if (response._authLost === true) return;

      // --- Версии: seen vs applied (2.22, 2.23, 2.24) ---
      if (response.versions && typeof response.versions === "object") {
        const seen = emptyVersions();
        const sv = response.versions;

        // §11.3: бэкенд сейчас отдаёт единственный ключ tickets — трактуем
        // его как open_tickets до появления двух ключей.
        seen.open_tickets = Number(sv.open_tickets ?? sv.tickets ?? 0);
        seen.closed_tickets = Number(sv.closed_tickets ?? 0);
        seen.staff = Number(sv.staff ?? 0);
        seen.dicts = Number(sv.dicts ?? 0);
        seen.addresses = Number(sv.addresses ?? 0);

        for (const layer of LAYERS) {
          if (seen[layer] <= (applied[layer] || 0)) continue;
          // 2.23: слой в cooldown — пропускаем, остальные слои работают.
          if (this._isLayerCoolingDown(layer)) continue;

          // 2.24: убран guard !isSyncing. Применение версии не должно
          // ждать окончания outbox-синка: это разные плоскости.
          window.dispatchEvent(
            new CustomEvent(LAYER_EVENT[layer], {
              detail: { version: seen[layer] },
            }),
          );
        }
      }

      // --- Notifications ---
      const events = Array.isArray(response.notifications)
        ? response.notifications
        : [];

      await withIdbWriteLock(async () => {
        const newLastId = parseInt(response.last_id, 10);
        if (!isNaN(newLastId) && newLastId > sinceId) {
          this._saveLastId(newLastId);
        }
      });

      if (events.length === 0) return;

      const myId = authStore.getUser()?.id;
      const filtered = events.filter((ev) => ev.actor_id !== myId);

      const toasts = filtered.map((ev) => ({
        id: "ntf_" + ev.id,
        type: TYPE_MAP[ev.event_type] || "info",
        text: ev.text,
        ticketId: ev.ticket_id || null,
        once: false,
        sound: !!ev.sound,
        timeout: typeof ev.timeout === "number" ? ev.timeout : undefined,
      }));

      filtered.forEach((ev) => {
        if (ev.text) logHistoryAction(ev.text);
      });

      if (toasts.length > 0) notify.batch(toasts);
    } catch (err) {
      console.warn("[NotificationsPoller] Ошибка опроса:", err);
    } finally {
      this._isTicking = false;
    }
  }

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

  // --- applied-версии ---

  _loadApplied() {
    try {
      const raw = localStorage.getItem(APPLIED_STORAGE_KEY);
      if (!raw) return emptyVersions();
      const parsed = JSON.parse(raw);
      return parsed && typeof parsed === "object"
        ? { ...emptyVersions(), ...parsed }
        : emptyVersions();
    } catch (e) {
      return emptyVersions();
    }
  }

  _saveApplied(applied) {
    try {
      localStorage.setItem(APPLIED_STORAGE_KEY, JSON.stringify(applied));
    } catch (e) {}
  }

  // --- 2.23: неудачи по слоям ---

  _loadLayerFailures() {
    try {
      const raw = localStorage.getItem(LAYER_FAILURES_STORAGE_KEY);
      return raw ? JSON.parse(raw) : {};
    } catch (e) {
      return {};
    }
  }

  _saveLayerFailures(data) {
    try {
      localStorage.setItem(LAYER_FAILURES_STORAGE_KEY, JSON.stringify(data));
    } catch (e) {}
  }

  _markLayerFailure(layer) {
    const data = this._loadLayerFailures();
    const entry = data[layer] || { count: 0, until: 0 };
    entry.count = (entry.count || 0) + 1;

    if (entry.count >= LAYER_FAIL_LIMIT) {
      entry.until = Date.now() + LAYER_COOLDOWN_MS;
      entry.count = 0;
      console.warn(
        `[NotificationsPoller] Слой ${layer} в cooldown на 10 минут после ${LAYER_FAIL_LIMIT} неудач.`,
      );
      logHistoryAction(
        `Синхронизация справочника «${layer}» приостановлена на 10 минут.`,
      );
      notify.warning(
        `Справочник «${layer}» не обновляется: 3 неудачи подряд. Повтор через 10 минут.`,
        { once: true },
      );
    }

    data[layer] = entry;
    this._saveLayerFailures(data);
  }

  _resetLayerFailure(layer) {
    const data = this._loadLayerFailures();
    if (data[layer]) {
      delete data[layer];
      this._saveLayerFailures(data);
    }
  }

  _isLayerCoolingDown(layer) {
    const data = this._loadLayerFailures();
    const entry = data[layer];
    if (!entry) return false;
    if (entry.until && Date.now() < entry.until) return true;
    if (entry.until && Date.now() >= entry.until) {
      delete data[layer];
      this._saveLayerFailures(data);
    }
    return false;
  }
}