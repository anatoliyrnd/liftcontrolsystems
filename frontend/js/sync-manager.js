/**
 * Менеджер офлайн-синхронизации. Поштучная отправка.
 * API_syncCommands.md v5.4, ТЗ фронтенда, волна 2.
 *
 * Удалено: buildBatch, накопление веса, лимит 20, блок «очередь не
 * уменьшилась», проверка полноты results, прогресс по терминальным
 * статусам, лимит итераций, _processResults, _applyCreatedTickets,
 * _refreshOpenTickets и колбэк onOpenTicketsUpdated.
 *
 * Порядок: строгий FIFO по индексу [status, created_at].
 * Блокировка: только failed с исчерпанным retry, только своей заявки.
 * Два счётчика: failedRuns (сеть, 3 → ручной режим) и retry_count команды.
 * Лок Web Locks берётся на команду, не на весь запуск.
 */

import { authStore } from "./auth-store.js";
import { offlineDB } from "./offline-db.js";
import { outboxQueue } from "./outbox-queue.js";
import { notify } from "./components/notify.js";
import { logHistoryAction } from "./history-logger.js";
import { buildCommand } from "./sync/batch-builder.js";
import { MAX_RETRIES, getNextRetryAt, isRetryExhausted } from "./sync/backoff.js";
import { generateBatchId } from "./utils/uuid.js";

const CMD_LOCK = "lift-sync-command";

const CFG_MANUAL = "sync_manual_mode";
const CFG_FAILED_RUNS = "sync_failed_runs";

const MAX_FAILED_RUNS = 3;

const DELAY_ONLINE = 5000;
const DELAY_START = 3000;
const DELAY_VISIBILITY = 2000;
const PERIODIC_INTERVAL = 60000;

const NO_RIGHTS_TEXT = {
  CloseTicket: "Недостаточно прав для этого действия. Заявка не закрыта.",
  CreateTicket: "Недостаточно прав для этого действия. Заявка не создана.",
  EditTicket: "Недостаточно прав для этого действия. Изменения не применены.",
  AddComment: "Недостаточно прав для этого действия. Комментарий не добавлен.",
};

const NETWORK_CODES = new Set([
  "network_error",
  "timeout",
  "aborted",
  "invalid_response",
  "rate_limited",
]);

function nowSec() {
  return Math.floor(Date.now() / 1000);
}

/** Ключ блокировки заявки: ticket_id ?? offline_uuid (§7.3). */
function lockKeyOf(cmd) {
  if (cmd.ticket_id != null && cmd.ticket_id !== "") return String(cmd.ticket_id);
  if (cmd.offline_uuid) return String(cmd.offline_uuid);
  return "cmd:" + cmd.command_uuid;
}

/**
 * Web Locks на одну команду. ifAvailable — если другая вкладка уже
 * держит лок, не ждём: она сама возьмёт старейшую eligible.
 * Без navigator.locks работаем без лока (однооконный режим).
 */
async function withCommandLock(fn) {
  if (!navigator.locks?.request) return fn();
  return navigator.locks.request(CMD_LOCK, { ifAvailable: true }, async (lock) => {
    if (!lock) return { skipped: true };
    return fn();
  });
}

export class SyncManager {
  /**
   * Совместимость вызова: (api, router, options) и устаревший
   * (api, router, onOpenTicketsUpdated, options). Колбэк игнорируется —
   * списки обновляются событиями, а не прямой передачей массива.
   */
  constructor(api, router, legacyCallbackOrOptions, maybeOptions) {
    this.api = api;
    this.router = router;

    const options =
      legacyCallbackOrOptions && typeof legacyCallbackOrOptions !== "function"
        ? legacyCallbackOrOptions
        : maybeOptions || {};

    // Модалка дубликата в фоне не открывается (§13.2).
    // Хэндл сохранён для экрана очереди — вызывается по клику.
    this._onDuplicateDetected = options.onDuplicateDetected || null;

    this._syncing = false;
    this._manualMode = false;
    this._failedRuns = 0;
    this._flagsLoaded = false;
    this._cooldownUntil = 0;
    this._notBefore = nowSec() + DELAY_START / 1000;

    this._progress = { done: 0, total: 0, active: false };

    this._onlineTimer = null;
    this._visibilityTimer = null;
    this._periodicTimer = null;
    this._startTimer = null;
    this._stopped = false;

    this._onOnline = this._onOnline.bind(this);
    this._onVisibility = this._onVisibility.bind(this);
    this._onTriggerSync = this._onTriggerSync.bind(this);

    this._bindTriggers();
  }

  // --- Публичное состояние ---

  get isSyncing() {
    return this._syncing;
  }

  get manualMode() {
    return this._manualMode;
  }

  get failedRuns() {
    return this._failedRuns;
  }

  getProgress() {
    return { ...this._progress };
  }

  // --- Триггеры (§8.1) ---

  _bindTriggers() {
    window.addEventListener("online", this._onOnline);
    document.addEventListener("visibilitychange", this._onVisibility);
    window.addEventListener("triggerSync", this._onTriggerSync);

    // Открытие SPA — 3 с. Более ранний вызов startSync() из main.js
    // будет отложен до этого момента, а не сожжёт попытку впустую.
    this._startTimer = setTimeout(() => {
      this._startTimer = null;
      this.startSync();
    }, DELAY_START);

    this._periodicTimer = setInterval(() => {
      if (document.visibilityState !== "visible") return;
      this.startSync();
    }, PERIODIC_INTERVAL);
  }

  _onOnline() {
    // navigator.onLine врёт раньше, чем связь реально работает:
    // DHCP, DNS, captive portal. Debounce 5 с, таймер не плодим.
    if (this._onlineTimer) clearTimeout(this._onlineTimer);
    this._onlineTimer = setTimeout(() => {
      this._onlineTimer = null;
      this.startSync();
    }, DELAY_ONLINE);
  }

  _onVisibility() {
    if (document.visibilityState !== "visible") return;
    if (this._visibilityTimer) clearTimeout(this._visibilityTimer);
    this._visibilityTimer = setTimeout(() => {
      this._visibilityTimer = null;
      this.startSync();
    }, DELAY_VISIBILITY);
  }

/**
   * Кнопка «Синхронизировать» (offline-banner, queue-controller).
   * Единственный триггер, который сбрасывает ручной режим (п. 2.10).
   * Программный вызов может opt-out: dispatchEvent(new CustomEvent(
   * "triggerSync", { detail: { manual: false } })).
   */
  _onTriggerSync(e) {
    if (e?.detail?.manual === false) {
      this.startSync();
      return;
    }
    this.syncNow();
  }

  /* async startSync(opts = {}) {
    if (this._stopped || this._syncing) return;
    if (!navigator.onLine || !authStore.hasAccess()) return;

    await this._loadFlags();

    const manual = opts.manual === true;
    if (!manual) {
      if (this._manualMode) return;
      const now = nowSec();
      if (now < this._cooldownUntil || now < this._notBefore) {
        const wait = Math.max(this._cooldownUntil, this._notBefore) - now;
        if (!this._startTimer) {
          this._startTimer = setTimeout(() => {
            this._startTimer = null;
            this.startSync();
          }, Math.max(wait, 1) * 1000);
        }
        return;
      }
    }

    let counts;
    try {
      counts = await offlineDB.getOutboxCounts();
    } catch (e) {
      console.warn("[SyncManager] Очередь недоступна:", e);
      return;
    }
    if (counts.pending === 0) {
      this._publishProgress(0, 0, false);
      window.dispatchEvent(new Event("refreshSyncState"));
      return;
    }

    this._syncing = true;

    let done = 0;
    let terminalSeen = false;
    let networkFailure = false;
    let serverReject = false;
    let authLost = false;
    let touchedTickets = false;

    try {
      const blockedKeys = await offlineDB.getBlockedKeys();

      while (!this._stopped) {
        if (!navigator.onLine) {
          networkFailure = true;
          break;
        }

        // Лок на команду: выбор и отправка внутри одного удержания,
        // иначе два таба возьмут одну и ту же старейшую запись.
        const outcome = await withCommandLock(async () => {
          const [cmd] = await offlineDB.getPendingBatch(1, { blockedKeys });
          if (!cmd) return { kind: "empty" };
          return this._sendOne(cmd, blockedKeys);
        });

        // Простой: лок занят, всё в backoff, все ключи заблокированы.
        // Не отказ запуска — счётчик не трогаем.
        if (!outcome || outcome.skipped || outcome.kind === "empty") break;

        if (outcome.kind === "auth") {
          authLost = true;
          break;
        }
        if (outcome.kind === "network") {
          networkFailure = true;
          if (outcome.retryAfter) {
            this._cooldownUntil = nowSec() + Number(outcome.retryAfter);
          }
          break;
        }
        if (outcome.kind === "blocked_run") {
          // Верхнеуровневый status:"error" — команда не выполнена (§10.2).
          serverReject = true;
          break;
        }

        if (done === 0) this._publishProgress(0, counts.pending, true);
        done++;
        this._publishProgress(done, counts.pending, true);

        if (outcome.terminal) terminalSeen = true;
        if (outcome.touchedTickets) touchedTickets = true;
      }
    } catch (e) {
      console.error("[SyncManager] Сбой запуска:", e);
      networkFailure = true;
    } finally {
      this._syncing = false;
      this._publishProgress(done, counts.pending, false);
    }

    if (!authLost) {
      if (terminalSeen) {
        // Любой success / ignored / archived сбрасывает счётчик (§8.2).
        if (this._failedRuns !== 0) {
          this._failedRuns = 0;
          await this._persistFlags();
        }
      } else if (networkFailure || serverReject) {
        // Только фактическая неудача. Серверные failed владеет
        // retry_count команды — здесь их не считаем.
        this._failedRuns += 1;
        if (this._failedRuns >= MAX_FAILED_RUNS && !this._manualMode) {
          this._manualMode = true;
          notify.warning(
            "Синхронизация приостановлена. Нажмите «Синхронизировать»",
            { timeout: 0, persistent: true, once: true },
          );
          logHistoryAction(
            "Синхронизация приостановлена: 3 запуска без успешных команд.",
          );
        }
        await this._persistFlags();
      } else if (done === 0) {
        // Ни одной отправки и ни одной ошибки — ждём backoff точным таймером.
        await this._scheduleBackoffWake();
      }
    }

    window.dispatchEvent(new Event("refreshSyncState"));

    if (touchedTickets) {
      // п. 2.27: списки перечитываются событием, а не переданным массивом.
      window.dispatchEvent(new Event("sync:fetch_open_tickets"));
      window.dispatchEvent(new Event("sync:fetch_closed_tickets"));
    }
  } */


  /** Кнопка «Синхронизировать»: сбрасывает ручной режим и счётчик. */
  async syncNow() {
    await this._loadFlags();
    if (this._manualMode || this._failedRuns > 0) {
      this._manualMode = false;
      this._failedRuns = 0;
      await this._persistFlags();
      logHistoryAction("Синхронизация возобновлена вручную.");
    }
    this._cooldownUntil = 0;
    this._notBefore = 0;
    return this.startSync({ manual: true });
  }

  stop() {
    this._stopped = true;
    window.removeEventListener("online", this._onOnline);
    document.removeEventListener("visibilitychange", this._onVisibility);
    window.removeEventListener("triggerSync", this._onTriggerSync);
    for (const key of ["_onlineTimer", "_visibilityTimer", "_startTimer"]) {
      if (this[key]) {
        clearTimeout(this[key]);
        this[key] = null;
      }
    }
    if (this._periodicTimer) {
      clearInterval(this._periodicTimer);
      this._periodicTimer = null;
    }
  }

  // --- Персистентные флаги (§8.3) ---

  async _loadFlags() {
    if (this._flagsLoaded) return;
    try {
      const [manual, runs] = await Promise.all([
        offlineDB.getConfig(CFG_MANUAL),
        offlineDB.getConfig(CFG_FAILED_RUNS),
      ]);
      this._manualMode = manual === true || manual === "true";
      this._failedRuns = Number(runs) || 0;
    } catch (e) {
      console.warn("[SyncManager] Флаги недоступны:", e);
    }
    this._flagsLoaded = true;
  }

  async _persistFlags() {
    try {
      await offlineDB.setConfig(CFG_MANUAL, this._manualMode);
      await offlineDB.setConfig(CFG_FAILED_RUNS, this._failedRuns);
    } catch (e) {
      console.warn("[SyncManager] Не удалось сохранить флаги:", e);
    }
  }

  // --- Прогресс (§13.4) ---

  _publishProgress(done, total, active) {
    this._progress = { done, total, active };
    window.dispatchEvent(
      new CustomEvent("sync:progress", { detail: { ...this._progress } }),
    );

    const btn = document.getElementById("syncIndicator");
    if (btn && active && total > 0) {
      btn.title = `Синхронизация: ${Math.min(done + 1, total)} из ${total}`;
    }
    const label = document.querySelector(".sync-indicator-progress");
    if (label) {
      label.textContent = active && total > 0 ? `${done} / ${total}` : "";
    }
  }

  // --- Запуск ---

  async startSync(opts = {}) {
    if (this._stopped || this._syncing) return;
    if (!navigator.onLine || !authStore.hasAccess()) return;

    await this._loadFlags();

    const manual = opts.manual === true;
    if (!manual) {
      if (this._manualMode) return;
      const now = nowSec();
      if (now < this._cooldownUntil || now < this._notBefore) {
        const wait = Math.max(this._cooldownUntil, this._notBefore) - now;
        if (!this._startTimer) {
          this._startTimer = setTimeout(() => {
            this._startTimer = null;
            this.startSync();
          }, Math.max(wait, 1) * 1000);
        }
        return;
      }
    }

    let counts;
    try {
      counts = await offlineDB.getOutboxCounts();
    } catch (e) {
      console.warn("[SyncManager] Очередь недоступна:", e);
      return;
    }
    if (counts.pending === 0) {
      this._publishProgress(0, 0, false);
      window.dispatchEvent(new Event("refreshSyncState"));
      return;
    }

    this._syncing = true;
    this._publishProgress(0, counts.pending, true);

    let terminalSeen = false;
    let networkFailure = false;
    let authLost = false;
    let touchedTickets = false;
    let done = 0;

    try {
      const blockedKeys = await offlineDB.getBlockedKeys();

      while (!this._stopped) {
        if (!navigator.onLine) {
          networkFailure = true;
          break;
        }

        // Лок на команду: выбор и отправка внутри одного удержания,
        // иначе два таба возьмут одну и ту же старейшую запись.
        const outcome = await withCommandLock(async () => {
          const [cmd] = await offlineDB.getPendingBatch(1, { blockedKeys });
          if (!cmd) return { kind: "empty" };
          return this._sendOne(cmd, blockedKeys);
        });

        if (!outcome || outcome.skipped || outcome.kind === "empty") break;

        if (outcome.kind === "auth") {
          authLost = true;
          break;
        }
        if (outcome.kind === "network") {
          networkFailure = true;
          if (outcome.retryAfter) {
            this._cooldownUntil = nowSec() + Number(outcome.retryAfter);
          }
          break;
        }
        if (outcome.kind === "blocked_run") break;

        done++;
        this._publishProgress(done, counts.pending, true);

        if (outcome.terminal) terminalSeen = true;
        if (outcome.touchedTickets) touchedTickets = true;
      }
    } catch (e) {
      console.error("[SyncManager] Сбой запуска:", e);
      networkFailure = true;
    } finally {
      this._syncing = false;
      this._publishProgress(done, counts.pending, false);
    }

    if (!authLost) {
      if (terminalSeen) {
        // Любой успех сбрасывает счётчик запусков (§8.2, п. 2.12).
        if (this._failedRuns !== 0) {
          this._failedRuns = 0;
          await this._persistFlags();
        }
      } else if (networkFailure || done === 0) {
        this._failedRuns += 1;
        if (this._failedRuns >= MAX_FAILED_RUNS && !this._manualMode) {
          this._manualMode = true;
          notify.warning(
            "Синхронизация приостановлена. Нажмите «Синхронизировать»",
            { timeout: 0, persistent: true, once: true },
          );
          logHistoryAction(
            "Синхронизация приостановлена: 3 запуска без успешных команд.",
          );
        }
        await this._persistFlags();
      }
    }

    window.dispatchEvent(new Event("refreshSyncState"));

    if (touchedTickets) {
  // 2.27: сбрасываем applied, чтобы следующий _tick подтянул свежие
  // версии. Без этого poller продолжит слать старые applied и получать
  // тот же outdated.
  window.dispatchEvent(
    new CustomEvent("sync:applied_reset", {
      detail: { layers: ["open_tickets", "closed_tickets"] },
    }),
  );
  // 2.27: один тик поллера сразу, а не через 120 сек.
  window.notificationsPollerInstance?._tick?.();
}
  }

  // --- Одна команда ---

  async _sendOne(cmd, blockedKeys) {
    const user = authStore.getUser();
    const batchId = await this._batchIdFor(cmd);
    const command = buildCommand(cmd, user, {
      forceCreate: cmd.confirmed === true,
    });

    let resp;
    try {
      resp = await this.api.post(
        { action: "syncCommands", batch_id: batchId, commands: [command] },
        null,
        "sync",
      );
    } catch (e) {
      console.warn("[SyncManager] Сеть недоступна:", e);
      return { kind: "network" };
    }

    if (!resp) return { kind: "network" };
    if (resp._authLost) return { kind: "auth" };
    if (resp.offline === true || NETWORK_CODES.has(resp.code)) {
      return { kind: "network", retryAfter: resp.retry_after };
    }

    // Ошибка верхнего уровня: команда не выполнена, остаётся pending (§10.2).
    if (resp.status === "error") {
      logHistoryAction(
        `Синхронизация отклонена: ${resp.message || resp.code || "ошибка сервера"}`,
      );
      return { kind: "blocked_run" };
    }
    if (resp.status !== "ok") return { kind: "blocked_run" };

    // Переходная мера: ответ может лежать плоско (§5).
    const data = resp.data || resp;
    const result = Array.isArray(data.results) ? data.results[0] : null;
    if (!result) return { kind: "blocked_run" };

    return this._applyResult(cmd, result, data, blockedKeys);
  }

  /**
   * batch_id deprecated (§11.2), но переиспользуется при повторе той же
   * команды. Состав всегда один — отслеживать нечего.
   */
  async _batchIdFor(cmd) {
    if (cmd.batch_id) return cmd.batch_id;
    const batchId = generateBatchId();
    try {
      await offlineDB.updateOutboxCommand(cmd.command_uuid, {
        batch_id: batchId,
      });
    } catch (e) {
      console.warn("[SyncManager] batch_id не сохранён:", e);
    }
    return batchId;
  }

 async _applyResult(cmd, result, data, blockedKeys) {
    const status = result.status;
    const reason = this._reasonOf(result);
    const message = result.message || "";
    const ticketRef = cmd.ticket_id ?? cmd.offline_uuid ?? "—";

    // --- success ---
    if (status === "success") {
      await outboxQueue.remove([cmd.command_uuid]);
      logHistoryAction(
        message || `Синхронизировано: ${cmd.command_type} №${ticketRef}`,
      );
      this._announceCreatedTicket(cmd, result, data);
      return { kind: "done", terminal: true, touchedTickets: true };
    }

    // --- ignored: идемпотентность, без уведомления ---
    if (status === "ignored") {
      await outboxQueue.remove([cmd.command_uuid]);
      this._announceCreatedTicket(cmd, result, data);
      return { kind: "done", terminal: true, touchedTickets: true };
    }

    // --- archived → rejected (п. 2.13) ---
    if (status === "archived") {
      await offlineDB.updateOutboxCommand(cmd.command_uuid, {
        status: "rejected",
        reason,
        last_error: message || reason,
        server_message: message,
      });

      if (reason === "no_rights") {
        // п. 2.21: текст по типу, persistent, номер — в историю.
        notify.error(
          NO_RIGHTS_TEXT[cmd.command_type] ||
            "Недостаточно прав для этого действия.",
          { timeout: 0, persistent: true },
        );
        logHistoryAction(
          `Отказ в правах: ${cmd.command_type}, заявка №${ticketRef}.`,
        );
        window.dispatchEvent(new Event("sync:fetch_dicts"));
      } else {
        notify.warning(
          `Действие отклонено сервером: ${message || reason}. Запись осталась в очереди.`,
          { once: true },
        );
        logHistoryAction(
          `Отклонено: ${cmd.command_type} №${ticketRef} — ${message || reason}`,
        );
      }
      return { kind: "done", terminal: true, touchedTickets: false };
    }

    // --- duplicate_detected → needs_confirmation (§13.2) ---
    if (status === "duplicate_detected") {
      const existing = result.existing_tickets || data.existing_tickets || [];
      await offlineDB.updateOutboxCommand(cmd.command_uuid, {
        status: "needs_confirmation",
        reason: "duplicate_detected",
        existing_tickets: existing,
        last_error: message || "На объект уже есть активная заявка",
      });

      // В фоне — уведомление со ссылкой, НЕ модалка. Локи свободны.
      notify.warning("Требуется подтверждение дубликата", {
        timeout: 0,
        persistent: true,
        actionText: "Открыть очередь",
        onAction: () => this.router?.navigate("#/queue"),
      });
      logHistoryAction(`Дубликат требует подтверждения: заявка №${ticketRef}.`);
      return { kind: "done", terminal: false, touchedTickets: false };
    }

    // --- failed: единственное, что инкрементирует retry_count ---
    if (status === "failed") {
      const retryCount = (Number(cmd.retry_count) || 0) + 1;

      if (isRetryExhausted(retryCount)) {
        await outboxQueue.markFailed(
          cmd.command_uuid,
          message || reason || "internal_error",
        );
        blockedKeys.add(lockKeyOf(cmd));
        logHistoryAction(
          `Ошибка синхронизации ${cmd.command_type} №${ticketRef}: попытки исчерпаны. Команды этой заявки ждут.`,
        );
        notify.error(
          `Не удалось синхронизировать действие по заявке №${ticketRef}. Повторите из очереди.`,
          { once: true },
        );
      } else {
        await offlineDB.updateOutboxCommand(cmd.command_uuid, {
          retry_count: retryCount,
          next_retry_at: getNextRetryAt(retryCount),
          last_error: message || reason || "internal_error",
          status: "pending",
        });
      }
      return { kind: "done", terminal: false, touchedTickets: false };
    }

    console.warn("[SyncManager] Неизвестный статус результата:", status);
    return { kind: "blocked_run" };
  }

  /**
   * Переходная мера (§4): reason может отсутствовать — разбираем message.
   * additionally: сервер отдаёт ticket_closed / not_found вместо
   * протокольных имён (§14) — нормализуем.
   */
  _reasonOf(result) {
    const raw =
      result.reason ||
      (typeof result.message === "string"
        ? result.message.split(":")[0].trim()
        : "") ||
      "";
    if (raw === "ticket_closed") return "ticket_already_closed";
    if (raw === "not_found") return "ticket_not_found";
    return raw;
  }

  /**
   * Прямое обновление одной записи вместо _applyCreatedTickets.
   * Созданная офлайн-заявка получает серверный номер в кэше журнала.
   */
 /*  async _linkCreatedTicket(cmd, result, data) {
    if (cmd.command_type !== "CreateTicket") return;

    const map = data.created_tickets || {};
    const serverId =
      result.server_id ??
      result.ticket_id ??
      map[cmd.offline_uuid] ??
      map[cmd.command_uuid] ??
      null;

    if (serverId == null || !cmd.offline_uuid) return;

    try {
      const cached = await offlineDB.getTickets("open");
      const idx = cached.findIndex(
        (t) => String(t.id) === String(cmd.offline_uuid),
      );
      if (idx < 0) return;
      const merged = {
        ...cached[idx],
        id: serverId,
        call_id: serverId,
        call_number: String(serverId),
        isOffline: false,
      };
      delete merged.offline_uuid;
      cached[idx] = merged;
      await offlineDB.saveTickets("open", cached);
    } catch (e) {
      console.warn("[SyncManager] Не удалось связать локальную заявку:", e);
    }
  } */

  // --- Для экрана очереди ---

  /**
   * Модалка дубликата — только по клику из очереди (§13.2).
   * Подтверждение живёт в поле записи confirmed, а не в payload:
   * force_create проставляет сборщик из opts (п. 3.2 протокола).
   */
  async confirmDuplicate(commandUuid) {
    const all = await offlineDB.getAllCommands();
    const cmd = all.find((c) => c.command_uuid === commandUuid);
    if (!cmd || cmd.status !== "needs_confirmation") return false;

    const show =
      this._onDuplicateDetected ||
      ((record, existing) =>
        import("./components/duplicate-ticket-modal.js").then((m) =>
          m.duplicateTicketModal.show(record, existing),
        ));

    const confirmed = await show(cmd, cmd.existing_tickets || []);
    if (!confirmed) return false;

    await offlineDB.updateOutboxCommand(commandUuid, {
      status: "pending",
      confirmed: true,
      next_retry_at: 0,
    });
    window.dispatchEvent(new Event("refreshSyncState"));
    this.syncNow();
    return true;
  }

  async cancelDuplicate(commandUuid) {
    await outboxQueue.remove([commandUuid]);
    window.dispatchEvent(new Event("refreshSyncState"));
  }

  async retryFailed(commandUuid) {
    await offlineDB.updateOutboxCommand(commandUuid, {
      status: "pending",
      retry_count: 0,
      next_retry_at: 0,
      last_error: null,
    });
    window.dispatchEvent(new Event("refreshSyncState"));
    this.syncNow();
  }
   /**
   * Точный будильник по ближайшему next_retry_at.
   * Без него backoff 30 с округляется периодическим тиком до 60 с.
   * Записи с уже наступившим сроком не учитываем: они заблокированы
   * ключом или их забрала другая вкладка — иначе получим горячий цикл.
   */
  async _scheduleBackoffWake() {
    if (this._stopped || this._manualMode || this._startTimer) return;

    let earliest = null;
    try {
      const all = await offlineDB.getAllCommands();
      const now = nowSec();
      for (const c of all) {
        if (c.status !== "pending") continue;
        const at = Number(c.next_retry_at) || 0;
        if (at <= now) continue;
        if (earliest == null || at < earliest) earliest = at;
      }
    } catch (e) {
      console.warn("[SyncManager] Backoff-сроки недоступны:", e);
      return;
    }

    if (earliest == null) return;
    const wait = Math.min(Math.max(earliest - nowSec(), 1), 120);
    this._startTimer = setTimeout(() => {
      this._startTimer = null;
      this.startSync();
    }, wait * 1000);
  }

  /**
   * Прямое обновление одной записи (п. 2.1) вместо _applyCreatedTickets.
   * Адресат — открытая карточка офлайн-заявки: после удаления команды
   * из outbox её offline_uuid больше не резолвится.
   * Кэш tickets_cache содержит только серверные строки — сканировать
   * его бессмысленно, журнал перечитывается по sync:fetch_open_tickets.
   */
  _announceCreatedTicket(cmd, result, data) {
    if (cmd.command_type !== "CreateTicket" || !cmd.offline_uuid) return;

    const map = data.created_tickets || {};
    const serverId =
      result.server_id ??
      result.ticket_id ??
      map[cmd.offline_uuid] ??
      map[cmd.command_uuid] ??
      null;

    if (serverId == null) {
      // §11.7: при ignored created_tickets не заполняется. Номер
      // появится в журнале после перечитывания; карточку не трогаем.
      console.warn(
        "[SyncManager] created_tickets пуст, связать локальную заявку нельзя:",
        cmd.offline_uuid,
      );
      return;
    }

    window.dispatchEvent(
      new CustomEvent("sync:ticket_created", {
        detail: { offline_uuid: cmd.offline_uuid, ticket_id: serverId },
      }),
    );
  }
}