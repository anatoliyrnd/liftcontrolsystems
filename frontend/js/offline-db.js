import { openDB } from "./vendor/idb.js";

/**
 * IndexedDB SPA — версия 3 (поштучная синхронизация, API_syncCommands.md v5.4).
 *
 * v2 → v3:
 *   - составной индекс [status, created_at] для строгого FIFO (п. 2.1);
 *   - индекс добавляется К СУЩЕСТВУЮЩЕМУ хранилищу, данные не удаляются;
 *   - нормализация старых записей (created_at в секундах, статус по умолчанию);
 *   - статусы needs_confirmation / rejected и отдельные счётчики (п. 2.14);
 *   - отбор с пропуском заблокированных ключей и backoff (п. 2.3, 2.7);
 *   - cleanupFailed чистит failed и rejected по возрасту статуса (п. 2.16).
 */

const DB_NAME = "LiftCallsDB";
const DB_VERSION = 3;

const OUTBOX = "outbox";
const FIFO_INDEX = "status_created_at";

export const OUTBOX_STATUS = {
  PENDING: "pending",
  NEEDS_CONFIRMATION: "needs_confirmation",
  FAILED: "failed",
  REJECTED: "rejected",
};

const ALL_STATUSES = Object.values(OUTBOX_STATUS);
const MAX_TS = Number.MAX_SAFE_INTEGER;

/** Unix-метка в секундах; миллисекунды старых записей приводим. */
function toSeconds(value, fallback) {
  const n = Number(value);
  if (!Number.isFinite(n) || n <= 0) return fallback;
  return n > 9999999999 ? Math.floor(n / 1000) : n;
}

function nowSec() {
  return Math.floor(Date.now() / 1000);
}

function statusRange(status, from = 0, to = MAX_TS) {
  return IDBKeyRange.bound([status, from], [status, to]);
}

/** Ключ блокировки заявки: ticket_id ?? offline_uuid (API_syncCommands §7.3). */
export function outboxLockKey(cmd) {
  if (!cmd) return null;
  if (cmd.ticket_id != null && cmd.ticket_id !== "")
    return String(cmd.ticket_id);
  if (cmd.offline_uuid) return String(cmd.offline_uuid);
  return "cmd:" + cmd.command_uuid;
}

/** ticket_id в индексе хранится числом; строковый ключ IDB не найдёт. */
function normalizeTicketKey(ticketId) {
  if (ticketId == null || ticketId === "") return null;
  const s = String(ticketId);
  if (s.startsWith("offline_")) return s;
  const n = Number(s);
  return Number.isFinite(n) ? n : s;
}

function createOutboxStore(db) {
  const store = db.createObjectStore(OUTBOX, { keyPath: "command_uuid" });
  store.createIndex(FIFO_INDEX, ["status", "created_at"]);
  store.createIndex("ticket_id", "ticket_id");
  store.createIndex("offline_uuid", "offline_uuid");
  store.createIndex("offline_author_id", "offline_author_id");
  return store;
}

function ensureOutboxIndexes(store) {
  if (!store.indexNames.contains(FIFO_INDEX))
    store.createIndex(FIFO_INDEX, ["status", "created_at"]);
  if (!store.indexNames.contains("ticket_id"))
    store.createIndex("ticket_id", "ticket_id");
  if (!store.indexNames.contains("offline_uuid"))
    store.createIndex("offline_uuid", "offline_uuid");
  if (!store.indexNames.contains("offline_author_id"))
    store.createIndex("offline_author_id", "offline_author_id");
}

/**
 * Нормализация существующих записей внутри upgrade-транзакции.
 * Без неё записи с undefined в status / created_at не попадают
 * в составной индекс и становятся невидимыми для FIFO и счётчиков.
 * Данные не удаляются — только приводятся к схеме.
 */
async function normalizeOutboxRecords(store) {
  let cursor = await store.openCursor();
  while (cursor) {
    const v = cursor.value;
    const status = ALL_STATUSES.includes(v.status)
      ? v.status
      : OUTBOX_STATUS.PENDING;
    const createdAt = toSeconds(v.created_at, nowSec());
    const ticketId = normalizeTicketKey(v.ticket_id);
    const nextRetryAt = Number.isFinite(Number(v.next_retry_at))
      ? Number(v.next_retry_at)
      : 0;
    const retryCount = Number.isFinite(Number(v.retry_count))
      ? Number(v.retry_count)
      : 0;

    const changed =
      status !== v.status ||
      createdAt !== v.created_at ||
      ticketId !== v.ticket_id ||
      nextRetryAt !== v.next_retry_at ||
      retryCount !== v.retry_count;

    if (changed) {
      await cursor.update({
        ...v,
        status,
        created_at: createdAt,
        ticket_id: ticketId,
        next_retry_at: nextRetryAt,
        retry_count: retryCount,
      });
    }
    cursor = await cursor.continue();
  }
}

class OfflineDB {
  constructor() {
    this._promise = null;
    this._db = null;
  }

  /** Совместимость с прежним API: offlineDB.dbPromise. */
  get dbPromise() {
    return this._open();
  }

   _open() {
    if (this._promise) return this._promise;

    // Локальный на попытку открытия: ready шлём только если реально
    // показывали предупреждение о блокировке.
    let wasBlocked = false;

    this._promise = openDB(DB_NAME, DB_VERSION, {
      upgrade: async (db, oldVersion, newVersion, tx) => {
        if (oldVersion < 1) {
          if (!db.objectStoreNames.contains("config"))
            db.createObjectStore("config", { keyPath: "key" });

          if (!db.objectStoreNames.contains("address_flat")) {
            const s = db.createObjectStore("address_flat", { keyPath: "id" });
            s.createIndex("city_id", "city_id");
          }

          if (!db.objectStoreNames.contains("tickets_cache"))
            db.createObjectStore("tickets_cache", { keyPath: "id" });
        }

        if (!db.objectStoreNames.contains(OUTBOX)) {
          createOutboxStore(db);
          return;
        }

        // Хранилище уже есть — только схема. Данные сохраняются.
        const store = tx.objectStore(OUTBOX);
        ensureOutboxIndexes(store);
        if (oldVersion < 3) await normalizeOutboxRecords(store);
      },

      blocked: () => {
        wasBlocked = true;
        console.warn("[OfflineDB] Обновление БД заблокировано другой вкладкой.");
        window.dispatchEvent(new CustomEvent("db:upgrade-blocked"));
      },

      blocking: () => {
        try {
          this._db?.close();
        } catch (e) {
          console.warn("[OfflineDB] close on blocking:", e);
        }
        this._db = null;
        this._promise = null;
        window.dispatchEvent(new CustomEvent("db:upgrade-required"));
      },

      terminated: () => {
        console.warn("[OfflineDB] Соединение с БД разорвано.");
        this._db = null;
        this._promise = null;
      },
    })
      .then((db) => {
        this._db = db;
        if (wasBlocked) {
          window.dispatchEvent(new CustomEvent("db:upgrade-ready"));
        }
        return db;
      })
      .catch((err) => {
        this._promise = null;
        console.error("[OfflineDB] Не удалось открыть БД:", err);
        throw err;
      });

    return this._promise;
  }

  // =========================================================================
  // Конфиг
  // =========================================================================

  async setConfig(key, value) {
    const db = await this.dbPromise;
    await db.put("config", { key, value });
  }

  async getConfig(key) {
    const db = await this.dbPromise;
    const res = await db.get("config", key);
    return res ? res.value : null;
  }

  // =========================================================================
  // Адреса
  // =========================================================================

  /**
   * 2.26: пустой ответ не должен затирать кэш.
   * clear() выполняется только когда новые данные уже на руках.
   */
  async saveAddresses(flatAddresses) {
    if (!Array.isArray(flatAddresses) || flatAddresses.length === 0) {
      console.warn("[OfflineDB] Пустой справочник адресов — кэш сохранён.");
      return 0;
    }

    const db = await this.dbPromise;
    const tx = db.transaction("address_flat", "readwrite");
    const store = tx.objectStore("address_flat");

    await store.clear();

    const CHUNK_SIZE = 2000;
    for (let i = 0; i < flatAddresses.length; i += CHUNK_SIZE) {
      const chunk = flatAddresses.slice(i, i + CHUNK_SIZE);
      await Promise.all(chunk.map((addr) => store.put(addr)));
    }
    await tx.done;
    return flatAddresses.length;
  }

  async getCities() {
    const db = await this.dbPromise;
    const all = await db.getAll("address_flat");
    const citiesMap = new Map();

    for (const item of all) {
      if (item.city_id == null) continue;
      if (!citiesMap.has(item.city_id)) {
        citiesMap.set(item.city_id, {
          id: item.city_id,
          name: item.city_name || `Город ${item.city_id}`,
        });
      }
    }

    return Array.from(citiesMap.values()).sort((a, b) =>
      String(a.name).localeCompare(String(b.name), "ru"),
    );
  }

  async searchAddresses(cityId, query) {
    const db = await this.dbPromise;
    const tx = db.transaction("address_flat", "readonly");
    const index = tx.objectStore("address_flat").index("city_id");

    const q = String(query || "").toLowerCase().trim();
    const tokens = q ? q.split(/\s+/).filter(Boolean) : [];
    const results = [];

    let cursor = await index.openCursor(IDBKeyRange.only(Number(cityId)));
    while (cursor) {
      const item = cursor.value;
      if (tokens.length === 0) {
        results.push(item);
      } else {
        const words = String(item.search_string || "").split(" ");
        if (tokens.every((t) => words.some((w) => w.startsWith(t))))
          results.push(item);
      }
      if (results.length >= 50) break;
      cursor = await cursor.continue();
    }

    await tx.done;
    return results;
  }

  // =========================================================================
  // Outbox
  // =========================================================================

  /**
   * Запись сохраняется целиком: reason / existing_tickets / force_create
   * нужны экрану очереди и модалке дубликата после перезагрузки.
   */
  async addOutboxCommand(cmd) {
    const db = await this.dbPromise;
    const ts = nowSec();

    const record = {
      ...cmd,
      command_uuid: cmd.command_uuid,
      command_type: cmd.command_type,
      ticket_id: normalizeTicketKey(cmd.ticket_id),
      offline_uuid: cmd.offline_uuid ?? null,
      payload: cmd.payload || {},
      created_at: toSeconds(cmd.created_at, ts),
      retry_count: Number(cmd.retry_count) || 0,
      next_retry_at: Number(cmd.next_retry_at) || 0,
      last_error: cmd.last_error ?? null,
      status: ALL_STATUSES.includes(cmd.status)
        ? cmd.status
        : OUTBOX_STATUS.PENDING,
      status_changed_at: cmd.status_changed_at ?? toSeconds(cmd.created_at, ts),
      offline_author_id: cmd.offline_author_id ?? null,
      offline_author_name: cmd.offline_author_name ?? null,
    };

    await db.put(OUTBOX, record);
    return record;
  }

  /** Все записи очереди, любые статусы. Для экрана очереди и служебных задач. */
  async getAllCommands() {
    const db = await this.dbPromise;
    return db.getAll(OUTBOX);
  }

  /** @deprecated имя сохранено ради совместимости — возвращает все статусы. */
  async getAllPending() {
    return this.getAllCommands();
  }

  /**
   * Строгий FIFO по индексу [status, created_at] (п. 2.2).
   *
   * Пропускаются:
   *   - записи с заблокированным ключом (failed с исчерпанным retry, п. 2.3);
   *   - записи в backoff (next_retry_at > now, п. 2.7).
   *
   * Пропуск по backoff блокирует и последующие команды ТОЙ ЖЕ заявки:
   * иначе комментарий B уйдёт раньше комментария A (§7.2).
   *
   * @param {number} limit
   * @param {{blockedKeys?: Set<string>, now?: number}} opts
   */
  async getPendingBatch(limit = 1, opts = {}) {
    const now = Number.isFinite(opts.now) ? opts.now : nowSec();
    const blocked = opts.blockedKeys instanceof Set ? opts.blockedKeys : null;
    const softBlocked = new Set();

    const db = await this.dbPromise;
    const tx = db.transaction(OUTBOX, "readonly");
    const index = tx.objectStore(OUTBOX).index(FIFO_INDEX);
    const batch = [];

    let cursor = await index.openCursor(statusRange(OUTBOX_STATUS.PENDING));
    while (cursor && batch.length < limit) {
      const cmd = cursor.value;
      const key = outboxLockKey(cmd);

      if (blocked?.has(key) || softBlocked.has(key)) {
        cursor = await cursor.continue();
        continue;
      }
      if (Number(cmd.next_retry_at) > now) {
        softBlocked.add(key);
        cursor = await cursor.continue();
        continue;
      }

      batch.push(cmd);
      cursor = await cursor.continue();
    }

    await tx.done;
    return batch;
  }

  /** Ключи заявок с failed (retry исчерпан) — блокируют только свою заявку. */
  async getBlockedKeys() {
    const db = await this.dbPromise;
    const failed = await db.getAllFromIndex(
      OUTBOX,
      FIFO_INDEX,
      statusRange(OUTBOX_STATUS.FAILED),
    );
    return new Set(failed.map(outboxLockKey).filter(Boolean));
  }

  async findPendingCreateByOfflineUuid(offlineUuid) {
    if (!offlineUuid) return null;
    const db = await this.dbPromise;
    const list = await db.getAllFromIndex(
      OUTBOX,
      "offline_uuid",
      IDBKeyRange.only(String(offlineUuid)),
    );
    return (
      list.find(
        (c) =>
          c.command_type === "CreateTicket" &&
          c.status === OUTBOX_STATUS.PENDING,
      ) || null
    );
  }

  /**
   * Зависимые команды серверной заявки.
   * Для offline_ их не существует — правки свёрнуты в CreateTicket (§9.1).
   */
  async getPendingByTicket(ticketId) {
    const key = normalizeTicketKey(ticketId);
    if (key == null || typeof key === "string") return [];

    const db = await this.dbPromise;
    const list = await db.getAllFromIndex(
      OUTBOX,
      "ticket_id",
      IDBKeyRange.only(key),
    );
    return list
      .filter((c) => c.status === OUTBOX_STATUS.PENDING)
      .sort((a, b) => a.created_at - b.created_at);
  }

  async getPendingByAuthor(authorId) {
    const id = Number(authorId);
    if (!Number.isFinite(id)) return [];

    const db = await this.dbPromise;
    const list = await db.getAllFromIndex(
      OUTBOX,
      "offline_author_id",
      IDBKeyRange.only(id),
    );
    return list.filter((c) => c.status === OUTBOX_STATUS.PENDING);
  }

  async updateOutboxCommand(commandUuid, patch) {
    const db = await this.dbPromise;
    const tx = db.transaction(OUTBOX, "readwrite");
    const store = tx.objectStore(OUTBOX);

    const existing = await store.get(commandUuid);
    if (!existing) {
      await tx.done;
      return null;
    }

    const next = { ...existing, ...patch, command_uuid: commandUuid };
    if (patch.ticket_id !== undefined)
      next.ticket_id = normalizeTicketKey(patch.ticket_id);
    if (patch.status && patch.status !== existing.status)
      next.status_changed_at = nowSec();

    await store.put(next);
    await tx.done;
    return next;
  }

  async deleteOutboxCommands(uuids) {
    if (!Array.isArray(uuids) || uuids.length === 0) return 0;
    const db = await this.dbPromise;
    const tx = db.transaction(OUTBOX, "readwrite");
    const store = tx.objectStore(OUTBOX);
    for (const id of uuids) store.delete(id);
    await tx.done;
    return uuids.length;
  }

  // --- Счётчики (п. 2.14) ---

  async _countStatus(status) {
    const db = await this.dbPromise;
    return db.countFromIndex(OUTBOX, FIFO_INDEX, statusRange(status));
  }

  /** Только pending — основной бейдж не должен висеть вечно жёлтым. */
  async getOutboxCount() {
    return this._countStatus(OUTBOX_STATUS.PENDING);
  }

  async getFailedCount() {
    return this._countStatus(OUTBOX_STATUS.FAILED);
  }

  async getNeedsConfirmationCount() {
    return this._countStatus(OUTBOX_STATUS.NEEDS_CONFIRMATION);
  }

  async getRejectedCount() {
    return this._countStatus(OUTBOX_STATUS.REJECTED);
  }

  /** Все четыре счётчика одной транзакцией — для индикатора и сводки. */
  async getOutboxCounts() {
    const db = await this.dbPromise;
    const tx = db.transaction(OUTBOX, "readonly");
    const index = tx.objectStore(OUTBOX).index(FIFO_INDEX);

    const [pending, needsConfirmation, failed, rejected] = await Promise.all(
      ALL_STATUSES.map((s) => index.count(statusRange(s))),
    );
    await tx.done;

    return {
      pending,
      needs_confirmation: needsConfirmation,
      failed,
      rejected,
      total: pending + needsConfirmation + failed + rejected,
    };
  }

  /** Четыре группы экрана очереди в порядке FIFO (п. 2.17). */
  async getOutboxGrouped() {
    const db = await this.dbPromise;
    const tx = db.transaction(OUTBOX, "readonly");
    const index = tx.objectStore(OUTBOX).index(FIFO_INDEX);

    const groups = {};
    for (const status of ALL_STATUSES) {
      groups[status] = await index.getAll(statusRange(status));
    }
    await tx.done;
    return groups;
  }

  async countByType(type) {
    const db = await this.dbPromise;
    const list = await db.getAllFromIndex(
      OUTBOX,
      FIFO_INDEX,
      statusRange(OUTBOX_STATUS.PENDING),
    );
    return list.filter((c) => c.command_type === type).length;
  }

  async clearOutbox() {
    const db = await this.dbPromise;
    await db.clear(OUTBOX);
  }

  /**
   * 2.16: failed и rejected старше maxAgeDays.
   * Возраст считается от смены статуса, а не от создания команды:
   * заявка недельной давности, отклонённая вчера, должна дожить до 7 дней.
   */
  async cleanupFailed(maxAgeDays = 7) {
    const cutoff = nowSec() - maxAgeDays * 24 * 60 * 60;
    const db = await this.dbPromise;
    const tx = db.transaction(OUTBOX, "readwrite");
    const index = tx.objectStore(OUTBOX).index(FIFO_INDEX);

    let removed = 0;
    for (const status of [OUTBOX_STATUS.FAILED, OUTBOX_STATUS.REJECTED]) {
      let cursor = await index.openCursor(statusRange(status));
      while (cursor) {
        const v = cursor.value;
        const stamp = toSeconds(v.status_changed_at, v.created_at);
        if (stamp < cutoff) {
          await cursor.delete();
          removed++;
        }
        cursor = await cursor.continue();
      }
    }

    await tx.done;
    return removed;
  }

  // =========================================================================
  // SHIM (старый API)
  // =========================================================================

  async addToOutbox(oldCmd) {
    return this.addOutboxCommand({
      command_uuid:
        oldCmd.uuid ||
        "cmd_" + Date.now() + "_" + Math.random().toString(36).slice(2, 10),
      command_type: "CreateTicket",
      ticket_id: null,
      offline_uuid: oldCmd.offline_uuid || null,
      payload: oldCmd.payload || {},
      created_at: oldCmd.created_at ?? nowSec(),
      offline_author_id: oldCmd.offline_author_id ?? null,
      offline_author_name: oldCmd.offline_author_name ?? null,
    });
  }

  async getOutboxBatch(limit = 1) {
    const cmds = await this.getPendingBatch(limit);
    return cmds.map((c) => ({
      uuid: c.command_uuid,
      offline_uuid: c.offline_uuid,
      offline_author_id: c.offline_author_id,
      offline_author_name: c.offline_author_name,
      payload: c.payload,
      created_at: c.created_at,
    }));
  }

  async getAllFromOutbox() {
    const all = await this.getAllCommands();
    return all
      .filter(
        (c) =>
          c.command_type === "CreateTicket" &&
          c.status === OUTBOX_STATUS.PENDING,
      )
      .map((c) => ({
        uuid: c.command_uuid,
        offline_uuid: c.offline_uuid,
        offline_author_id: c.offline_author_id,
        offline_author_name: c.offline_author_name,
        payload: c.payload,
        created_at: c.created_at,
      }));
  }

  async deleteFromOutbox(uuids) {
    return this.deleteOutboxCommands(uuids);
  }

  // =========================================================================
  // Кэш заявок
  // =========================================================================

  async saveTickets(type, tickets) {
    if (!Array.isArray(tickets)) return;
    const db = await this.dbPromise;
    const tx = db.transaction("tickets_cache", "readwrite");
    const store = tx.objectStore("tickets_cache");

    let cursor = await store.openCursor();
    while (cursor) {
      if (cursor.value._type === type) await cursor.delete();
      cursor = await cursor.continue();
    }

    for (const t of tickets) {
      if (t?.id == null) continue;
      store.put({ ...t, _type: type });
    }
    await tx.done;
  }

  async getTickets(type) {
    const db = await this.dbPromise;
    const tx = db.transaction("tickets_cache", "readonly");
    const store = tx.objectStore("tickets_cache");
    const results = [];

    let cursor = await store.openCursor();
    while (cursor) {
      if (cursor.value._type === type) results.push(cursor.value);
      cursor = await cursor.continue();
    }
    await tx.done;
    return results;
  }
}

export const offlineDB = new OfflineDB();