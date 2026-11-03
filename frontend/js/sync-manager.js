/**
 * Менеджер офлайн-синхронизации.
 *
 * Отправляет пачки команд через POST /calls/syncCommands (action: syncCommands).
 * Протокол: API_syncCommands.md v4.2, OFFLINE_PROTOCOL.md v3.0.
 *
 * Ключевые особенности:
 *   - Синхронизирует outbox ЦЕЛИКОМ, независимо от автора команды.
 *     Если синхронизирует не автор — в payload добавляется префикс-маркер
 *     (см. batch-builder.applyAuthorMarker).
 *   - Мультитаб: Web Locks (utils/sync-lock.js) сериализует вызовы между вкладками.
 *   - Идемпотентность: pendingBatchId хранится в offlineDB.config.
 *     При network error retry идёт с тем же batch_id — сервер вернёт кэш.
 *   - Partial Success: success/ignored/archived удаляются из outbox;
 *     failed — retry с экспоненциальным backoff (30→480s, MAX_RETRIES=5);
 *     duplicate_detected — модалка через onDuplicateDetected (b),
 *     при подтверждении повтор с force_create: true.
 *   - AUTH_LOST: прерывает текущий запрос через api.abortTag('sync'),
 *     команды остаются pending, после логина синхронизация продолжится.
 *   - Триггеры: online, triggerSync (кнопка), открытие SPA (startSync извне),
 *     polling 60s (visible + есть pending), после успешной пачки.
 */

import { offlineDB } from "./offline-db.js";
import { authStore } from "./auth-store.js";
import { outboxQueue } from "./outbox-queue.js";
import { buildBatch, buildCommand } from "./sync/batch-builder.js";
import { MAX_RETRIES, getNextRetryAt } from "./sync/backoff.js";
import { generateBatchId } from "./utils/uuid.js";
import { withSyncLock } from "./utils/sync-lock.js";
import { notify } from "./components/notify.js";
import { logHistoryAction } from "./history-logger.js";
import { ApiService } from "./api-service.js";

const POLL_INTERVAL_MS = 60_000;
const NETWORK_RETRY_COOLDOWN_MS = 30_000;
const AUTH_RETRY_COOLDOWN_MS = 30_000;
const PENDING_BATCH_ID_KEY = "pendingBatchId";
const PENDING_BATCH_UUIDS_KEY = "pendingBatchUuids";

export class SyncManager {
  /**
   * @param {ApiService} api
   * @param {Object} router
   * @param {(openTickets: Array) => void} onOpenTicketsUpdated
   * @param {Object} [opts]
   * @param {(cmd, existingTickets) => Promise<boolean>} [opts.onDuplicateDetected]
   *   Модалка duplicate_detected. Возвращает true = создать дубликат (force_create),
   *   false = отменить. По умолчанию — false (без модалки, для тестов).
   */
  constructor(api, router, onOpenTicketsUpdated, opts = {}) {
    this.api = api;
    this.router = router;
    this.onOpenTicketsUpdated = onOpenTicketsUpdated;
    this.onDuplicateDetected =
      typeof opts.onDuplicateDetected === "function"
        ? opts.onDuplicateDetected
        : () => Promise.resolve(false);

    this.isSyncing = false;
    this._cooldownUntil = 0;
    this._stopRequested = false;
    this._pollIntervalId = null;
    this._successCount = 0;
    this._archivedCount = 0;

    this._lifecycleAbort = new AbortController();
    this._bindTriggers();

    // Совместимость: tickets-controller._updateSyncButton() читает
    // window.syncManagerInstance.isSyncing и ._cooldownUntil
    if (typeof window !== "undefined") {
      window.syncManagerInstance = this;
    }
  }

  // =========================================================================
  // Триггеры
  // =========================================================================

  _bindTriggers() {
    const signal = this._lifecycleAbort.signal;

    window.addEventListener("online", () => this.startSync(), { signal });

    window.addEventListener("triggerSync", () => this.startSync(), { signal });

    window.addEventListener(
      ApiService.AUTH_LOST_EVENT,
      () => {
        this._stopRequested = true;
        this._cooldownUntil = Date.now() + AUTH_RETRY_COOLDOWN_MS;
        try {
          this.api.abortTag("sync");
        } catch (e) {
          /* ignore */
        }
      },
      { signal },
    );

    document.addEventListener(
      "visibilitychange",
      () => {
        if (document.visibilityState === "visible") this._pollOnce();
      },
      { signal },
    );

    this._pollIntervalId = setInterval(
      () => this._pollOnce(),
      POLL_INTERVAL_MS,
    );
  }

  async _pollOnce() {
    if (this.isSyncing) return;
    if (document.visibilityState !== "visible") return;
    if (!authStore.hasAccess()) return;
    if (Date.now() < this._cooldownUntil) return;

    const pending = await offlineDB.getOutboxCount();
    if (pending > 0) this.startSync();
  }

  // =========================================================================
  // Публичный запуск
  // =========================================================================

  async startSync() {
    if (this.isSyncing) return;
    if (!authStore.hasAccess()) return;

    if (Date.now() < this._cooldownUntil) {
      const waitMins = Math.ceil((this._cooldownUntil - Date.now()) / 60000);
      notify.warning(
        `Синхронизация заблокирована. Попробуйте через ${waitMins} мин.`,
      );
      return;
    }

    const pending = await offlineDB.getOutboxCount();
    if (pending === 0) return;

    this._stopRequested = false;
    this._successCount = 0;
    this._archivedCount = 0;
    this.isSyncing = true;
    this._emitStateChanged();

    const btn = document.getElementById("refreshBtn");
    if (btn) btn.classList.add("is-syncing");

    try {
      await withSyncLock(async () => {
        await this._syncLoop();
      });
    } catch (err) {
      console.error("[SyncManager] Ошибка синхронизации:", err);
      logHistoryAction(
        "Сбой синхронизации: " + (err.message || "неизвестная ошибка"),
      );
    } finally {
      this.isSyncing = false;
      if (btn) btn.classList.remove("is-syncing");
      this._emitStateChanged();
    }
  }

  // =========================================================================
  // Основной цикл
  // =========================================================================

  async _syncLoop() {
    this._hadSyncWork = false;
    while (!this._stopRequested) {
      if (!authStore.hasAccess()) break;

      const pending = await offlineDB.getPendingBatch(50);
      if (pending.length === 0) break;

      const currentUser = authStore.getUser();
      const commands = buildBatch(pending, currentUser);
      if (commands.length === 0) break; // все в backoff

      const batchId = await this._getOrCreateBatchId(commands);

      try {
        const response = await this.api.post(
          { action: "syncCommands", batch_id: batchId, commands },
          `Синхронизация (${commands.length} команд)...`,
          "sync",
        );

        // Порядок важен: offline (сеть упала / таймаут / сервер вернул не-JSON)
        // обрабатываем как retryable-ошибку — ставим cooldown, чтобы не бомбить
        // сервер. Ручной abort (AUTH_LOST через abortTag, отмена по кнопке) —
        // это сигнал остановки, а не ошибка: break без cooldown, команды
        // остаются pending для следующей сессии.
        //
        // Признаки:
        //   network_error + offline: true           — fetch reject (сеть упала)
        //   invalid_response + offline: true         — Content-Type не JSON
        //   aborted + reason: 'timeout' + offline    — Q8 таймаут
        //   aborted + reason: 'manual'  (без offline) — ручной abort
        if (
          response &&
          (response.code === "network_error" || response.offline)
        ) {
          this._cooldownUntil = Date.now() + NETWORK_RETRY_COOLDOWN_MS;
          logHistoryAction("Сеть недоступна. Повтор через 30 сек.");
          break;
        }

        if (response && response.code === "aborted") {
          // AUTH_LOST или ручная отмена — команды остаются pending.
          break;
        }
        if (response && response.status === "error") {
          // Ошибка верхнего уровня
          if (response.code === "rate_limited") {
            const waitSec =
              response.retryAfterSec || response.retry_after || 60;
            this._cooldownUntil = Date.now() + waitSec * 1000;
            await this._clearBatchId();
            logHistoryAction(`Rate-limit: повтор через ${waitSec}s`);
            notify.syncError({ reason: "rate_limited", retryAfter: waitSec });
            break;
          }

          // invalid_input / etc — пометить как failed (retry не поможет)
          await this._markBatchFailed(commands, response.code || "batch_error");
          await this._clearBatchId();
          logHistoryAction(
            `Синхронизация отклонена: ${response.message || response.code}`,
          );
          break;
        }

        // Успех или частичный успех
        await this._processResults(response.data, commands, pending);
        await this._clearBatchId();

        // 💡 Обновляем UI после КАЖДОЙ пачки (индикатор, очередь, таблица)
        this._emitStateChanged();

        const remaining = await offlineDB.getOutboxCount();
        if (remaining === 0) break;
        // иначе — продолжаем цикл (следующая пачка)
      } catch (err) {
        console.error("[SyncManager] Batch send error:", err);
        await this._markBatchFailed(commands, "send_exception");
        await this._clearBatchId();
        break;
      }
    }

    // Финал: если outbox пуст — обновить открытые и уведомить
    const remaining = await offlineDB.getOutboxCount();
    if (remaining === 0) {
      if (this._hadSyncWork) {
        logHistoryAction("Все офлайн-действия синхронизированы.");
        if (this._successCount > 0) {
          notify.syncSuccess({ success: this._successCount });
        }
        await this._refreshOpenTickets();
      }
    }
  }

  // =========================================================================
  // Обработка результатов
  // =========================================================================

  async _processResults(data, batchCommands, outboxRecords) {
    if (!data || !Array.isArray(data.results)) return;
    this._hadSyncWork = true;
    const toRemove = [];
    const toRetry = [];
    const toDuplicate = [];

    let archivedInThisBatch = 0;

    for (const result of data.results) {
      const record = outboxRecords.find(
        (r) => r.command_uuid === result.command_uuid,
      );
      if (!record) continue;

      switch (result.status) {
        case "success":
          toRemove.push(result.command_uuid);
          this._successCount += 1;
          break;

        case "ignored":
          toRemove.push(result.command_uuid);
          break;

        case "archived":
          toRemove.push(result.command_uuid);
          archivedInThisBatch += 1;
          this._archivedCount += 1;
          notify.syncPartial({
            archived: 1,
            message: this._buildArchivedMessage(result),
          });
          logHistoryAction(
            `Команда ${result.command_uuid} архивирована: ${result.reason}`,
          );
          break;

        case "failed":
          toRetry.push({ record, reason: result.reason || "server_error" });
          break;

        case "duplicate_detected":
          toDuplicate.push({ record, result });
          break;
      }
    }

    if (toRemove.length > 0) {
      await offlineDB.deleteOutboxCommands(toRemove);
    }

    for (const { record, reason } of toRetry) {
      await this._scheduleRetryOne(record, reason);
    }

    // Модалки — последовательно (обычно 0–1 на пачку)
    for (const { record, result } of toDuplicate) {
      await this._handleDuplicate(record, result);
    }

    // created_tickets → проставить ticket_id зависимым командам
    await this._applyCreatedTickets(data.created_tickets);
  }

  async _handleDuplicate(record, result) {
    const existingTickets = result.existing_tickets || [];

    let confirmed = false;
    try {
      confirmed = await this.onDuplicateDetected(record, existingTickets);
    } catch (e) {
      console.error("[SyncManager] onDuplicateDetected error:", e);
      confirmed = false;
    }

    if (!confirmed) {
      await offlineDB.deleteOutboxCommands([record.command_uuid]);
      logHistoryAction(`Создание дубликата отменено: ${record.command_uuid}`);
      this._emitStateChanged();
      return;
    }

    // Повтор с force_create: true — отдельный запрос, новый batch_id

    // Повтор с force_create: true — отдельный запрос, новый batch_id
    const currentUser = authStore.getUser();
    const forceCmd = buildCommand(record, currentUser, { forceCreate: true });
    const newBatchId = generateBatchId();

    try {
      const response = await this.api.post(
        { action: "syncCommands", batch_id: newBatchId, commands: [forceCmd] },
        "Создание дубликата...",
        "sync",
      );

      if (response && response.status === "ok") {
        const forceResult = response.data?.results?.[0];
        if (
          forceResult?.status === "success" ||
          forceResult?.status === "ignored"
        ) {
          await offlineDB.deleteOutboxCommands([record.command_uuid]);
          await this._applyCreatedTickets(response.data.created_tickets);
          notify.success("Заявка создана.");
          this._emitStateChanged();
          return;
        }
      }
      // Не удалось — retry с backoff
      await this._scheduleRetryOne(record, "force_create_failed");
    } catch (e) {
      console.error("[SyncManager] force_create error:", e);
      await this._scheduleRetryOne(record, "force_create_exception");
    }
  }

  async _scheduleRetryOne(record, reason) {
    const nextRetryCount = (record.retry_count || 0) + 1;
    if (nextRetryCount > MAX_RETRIES) {
      await outboxQueue.markFailed(record.command_uuid, "retry_exhausted");
      notify.syncError({ reason: "retry_exhausted" });
      logHistoryAction(
        `Команда ${record.command_uuid}: retry_exhausted. ` +
          `Действие не синхронизировано после ${MAX_RETRIES} попыток.`,
      );
    } else {
      const nextRetryAt = getNextRetryAt(nextRetryCount);
      await offlineDB.updateOutboxCommand(record.command_uuid, {
        retry_count: nextRetryCount,
        next_retry_at: nextRetryAt,
        last_error: String(reason || "unknown"),
        status: "pending",
      });
    }
  }

  async _markBatchFailed(commands, reason) {
    for (const cmd of commands) {
      await outboxQueue.markFailed(cmd.command_uuid, reason);
    }
  }

  async _applyCreatedTickets(createdTickets) {
    if (!createdTickets || typeof createdTickets !== "object") return;
    const all = await offlineDB.getAllPending();
    for (const cmd of all) {
      if (
        cmd.ticket_id === null &&
        cmd.offline_uuid &&
        createdTickets[cmd.offline_uuid]
      ) {
        await offlineDB.updateOutboxCommand(cmd.command_uuid, {
          ticket_id: createdTickets[cmd.offline_uuid],
        });
      }
    }
  }

  _buildArchivedMessage(result) {
    const map = {
      no_rights: "нет прав на действие",
      ticket_already_closed: "заявка уже закрыта",
      ticket_not_found: "заявка не найдена",
      contract_terminated: "договор расторгнут",
      photo_limit_exceeded: "лимит фото превышен",
      validation_error: "ошибка валидации",
    };
    const reason = map[result.reason] || result.reason || "причина неизвестна";
    return `Действие отброшено: ${reason}`;
  }

  // =========================================================================
  // Идемпотентность batch_id
  // =========================================================================

  async _getOrCreateBatchId(commands) {
    const uuids = commands
      .map((c) => c.command_uuid)
      .sort()
      .join(",");
    const storedBatch = await offlineDB.getConfig(PENDING_BATCH_ID_KEY);
    const storedUuids = await offlineDB.getConfig(PENDING_BATCH_UUIDS_KEY);

    // Если состав пачки не изменился — переиспользуем batch_id
    if (storedBatch && storedUuids === uuids) return storedBatch;

    const newBatchId = generateBatchId();
    await offlineDB.setConfig(PENDING_BATCH_ID_KEY, newBatchId);
    await offlineDB.setConfig(PENDING_BATCH_UUIDS_KEY, uuids);
    return newBatchId;
  }

  async _clearBatchId() {
    await offlineDB.setConfig(PENDING_BATCH_ID_KEY, null);
    await offlineDB.setConfig(PENDING_BATCH_UUIDS_KEY, null);
  }

  // =========================================================================
  // Прочее
  // =========================================================================

  async _refreshOpenTickets() {
    if (!this.onOpenTicketsUpdated) return;
    try {
      const openData = await this.api.post({ data: "open" }, null, "sync");
      if (Array.isArray(openData)) {
        await offlineDB.saveTickets("open", openData);
        this.onOpenTicketsUpdated(openData);
      }
    } catch (e) {
      console.warn(
        "[SyncManager] Не удалось обновить open после синхронизации:",
        e,
      );
    }
  }

  _emitStateChanged() {
    window.dispatchEvent(new Event("refreshSyncState"));
  }

  destroy() {
    this._lifecycleAbort?.abort();
    this._lifecycleAbort = null;
    if (this._pollIntervalId) {
      clearInterval(this._pollIntervalId);
      this._pollIntervalId = null;
    }
    if (typeof window !== "undefined" && window.syncManagerInstance === this) {
      window.syncManagerInstance = null;
    }
  }
}
