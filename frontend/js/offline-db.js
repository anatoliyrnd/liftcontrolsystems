import { openDB } from "./vendor/idb.js";

/**
 * IndexedDB SPA — версия 2 (офлайн-синхронизация по API_PROTOCOL.md v4.2).
 *
 * Ключевое решение: outbox — ГЛОБАЛЬНЫЙ на устройстве. Команды
 * синхронизируются ЛЮБЫМ залогиненным пользователем. Авторство
 * сохраняется в offline_author_id / offline_author_name и попадает
 * в payload при сборке пачки (см. batch-builder.js: applyAuthorMarker).
 *
 * Изменения от v1:
 *   - outbox: keyPath 'uuid' → 'command_uuid'; новая схема команд
 *     (command_type, ticket_id, offline_uuid, payload, status,
 *      retry_count, next_retry_at, last_error,
 *      offline_author_id, offline_author_name).
 *   - Индексы outbox: status, created_at, ticket_id, offline_uuid,
 *     offline_author_id.
 *   - При upgrade v1→v2 старый outbox УДАЛЯЕТСЯ (согласовано: п.9).
 *   - tickets_cache, address_flat, config — без изменений.
 *
 * Shim-методы (addToOutbox, getOutboxBatch, getAllFromOutbox,
 * deleteFromOutbox) — для совместимости до Фаз 1–3.
 * После Фаз 1–3 shim удаляется.
 */

const DB_NAME = "LiftCallsDB";
const DB_VERSION = 2;

function createOutboxStore(db) {
  const store = db.createObjectStore("outbox", { keyPath: "command_uuid" });
  store.createIndex("status", "status");
  store.createIndex("created_at", "created_at");
  store.createIndex("ticket_id", "ticket_id");
  store.createIndex("offline_uuid", "offline_uuid");
  store.createIndex("offline_author_id", "offline_author_id");
  return store;
}

class OfflineDB {
  constructor() {
    this.dbPromise = openDB(DB_NAME, DB_VERSION, {
      upgrade(db, oldVersion) {
        // v0 → v1
        if (oldVersion < 1) {
          if (!db.objectStoreNames.contains("config")) {
            db.createObjectStore("config", { keyPath: "key" });
          }
          if (!db.objectStoreNames.contains("address_flat")) {
            const store = db.createObjectStore("address_flat", {
              keyPath: "id",
            });
            store.createIndex("city_id", "city_id");
          }
          if (!db.objectStoreNames.contains("tickets_cache")) {
            db.createObjectStore("tickets_cache", { keyPath: "id" });
          }
        }

        // v1 → v2: пересоздаём outbox под новую схему.
        // Старый формат (callNewOffline) не мигрируем — чистим (п.9).
        if (oldVersion < 2) {
          if (db.objectStoreNames.contains("outbox")) {
            db.deleteObjectStore("outbox");
          }
          createOutboxStore(db);
        }
      },
    });
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

  async saveAddresses(flatAddresses) {
    const db = await this.dbPromise;
    const tx = db.transaction("address_flat", "readwrite");
    const store = tx.objectStore("address_flat");
    store.clear();

    const CHUNK_SIZE = 2000;
    for (let i = 0; i < flatAddresses.length; i += CHUNK_SIZE) {
      const chunk = flatAddresses.slice(i, i + CHUNK_SIZE);
      await Promise.all(chunk.map((addr) => store.put(addr)));
    }
    await tx.done;
  }

  async getCities() {
    const db = await this.dbPromise;
    const all = await db.getAll("address_flat");
    const citiesMap = new Map();
    for (const item of all) {
      if (!citiesMap.has(item.city_id)) {
        citiesMap.set(item.city_id, { id: item.city_id, name: item.city_name });
      }
    }
    return Array.from(citiesMap.values()).sort((a, b) =>
      a.name.localeCompare(b.name),
    );
  }

  async searchAddresses(cityId, query) {
    const db = await this.dbPromise;
    const tx = db.transaction("address_flat", "readonly");
    const index = tx.objectStore("address_flat").index("city_id");

    const q = query.toLowerCase().trim();
    const tokens = q ? q.split(" ").filter((t) => t.length > 0) : [];
    const results = [];

    let cursor = await index.openCursor(IDBKeyRange.only(cityId));
    while (cursor) {
      const item = cursor.value;
      if (tokens.length === 0) {
        results.push(item);
      } else {
        const words = item.search_string.split(" ");
        const isMatch = tokens.every((token) =>
          words.some((word) => word.startsWith(token)),
        );
        if (isMatch) results.push(item);
      }
      if (results.length >= 50) break;
      cursor = await cursor.continue();
    }
    await tx.done;
    return results;
  }

  // =========================================================================
  // Outbox — НОВЫЙ API (Фазы 1–3)
  // =========================================================================

  /**
   * Положить команду в outbox.
   * @param {Object} cmd
   * @param {string} cmd.command_uuid
   * @param {string} cmd.command_type      'CreateTicket'|'EditTicket'|'CloseTicket'|'AddComment'|'AcceptTicket'
   * @param {number|null} cmd.ticket_id
   * @param {string|null} cmd.offline_uuid
   * @param {Object} cmd.payload
   * @param {number} [cmd.created_at]      unix ts (секунды)
   * @param {number|null} [cmd.offline_author_id]
   * @param {string|null} [cmd.offline_author_name]
   */
  async addOutboxCommand(cmd) {
    const db = await this.dbPromise;
    const record = {
      command_uuid: cmd.command_uuid,
      command_type: cmd.command_type,
      ticket_id: cmd.ticket_id ?? null,
      offline_uuid: cmd.offline_uuid ?? null,
      payload: cmd.payload || {},
      created_at: cmd.created_at || Math.floor(Date.now() / 1000),
      retry_count: cmd.retry_count ?? 0,
      next_retry_at: cmd.next_retry_at ?? 0,
      last_error: cmd.last_error ?? null,
      status: cmd.status || "pending",
      offline_author_id: cmd.offline_author_id ?? null,
      offline_author_name: cmd.offline_author_name ?? null,
    };
    await db.put("outbox", record);
    return record;
  }

  /**
   * ВСЕ команды любого статуса, любого автора.
   * Используется: sync-manager (для сборки пачки — фильтр по status='pending'
   * внутри), queue-controller (список), tickets-controller (бейджи).
   * НЕ фильтрует по offline_author_id — это осознанное решение v1.
   */
  async getAllPending() {
    const db = await this.dbPromise;
    return db.getAll("outbox");
  }

  /**
   * Только pending, FIFO (created_at asc), любые авторы.
   * Используется batch-builder'ом.
   */
  async getPendingBatch(limit = 20) {
    const db = await this.dbPromise;
    const tx = db.transaction("outbox", "readonly");
    const index = tx.objectStore("outbox").index("status");
    const batch = [];
    let cursor = await index.openCursor(IDBKeyRange.only("pending"));
    while (cursor && batch.length < limit) {
      batch.push(cursor.value);
      cursor = await cursor.continue();
    }
    await tx.done;
    // Сортируем по created_at для стабильного FIFO
    batch.sort((a, b) => a.created_at - b.created_at);
    return batch;
  }

  /**
   * Pending-команды, привязанные к заявке (любые авторы).
   * Используется tickets-controller / details-controller для бейджей «⏳».
   */
  async getPendingByTicket(ticketId) {
    const db = await this.dbPromise;
    const tx = db.transaction("outbox", "readonly");
    const index = tx.objectStore("outbox").index("ticket_id");
    const list = await index.getAll(IDBKeyRange.only(ticketId));
    await tx.done;
    return list.filter((c) => c.status === "pending");
  }

  /**
   * Pending-команды конкретного автора.
   * Используется ТОЛЬКО для UI-фильтра «Только мои» в экране очереди.
   * НЕ используется для синхронизации.
   */
  async getPendingByAuthor(authorId) {
    const db = await this.dbPromise;
    const tx = db.transaction("outbox", "readonly");
    const index = tx.objectStore("outbox").index("offline_author_id");
    const list = await index.getAll(IDBKeyRange.only(authorId));
    await tx.done;
    return list.filter((c) => c.status === "pending");
  }

  /** Обновить поля команды. */
  async updateOutboxCommand(commandUuid, patch) {
    const db = await this.dbPromise;
    const existing = await db.get("outbox", commandUuid);
    if (!existing) return null;
    const merged = { ...existing, ...patch, command_uuid: commandUuid };
    await db.put("outbox", merged);
    return merged;
  }

  /** Удалить команды по command_uuid[]. */
  async deleteOutboxCommands(uuids) {
    if (!uuids || uuids.length === 0) return;
    const db = await this.dbPromise;
    const tx = db.transaction("outbox", "readwrite");
    for (const id of uuids) tx.objectStore("outbox").delete(id);
    await tx.done;
  }

  /** Количество pending (любые авторы). */
  async getOutboxCount() {
    const db = await this.dbPromise;
    return db.countFromIndex("outbox", "status", "pending");
  }

  /** Количество failed (любые авторы). */
  async getFailedCount() {
    const db = await this.dbPromise;
    return db.countFromIndex("outbox", "status", "failed");
  }
  /**
   * Количество pending-команд с заданным command_type.
   * Используется в create-controller: лимит офлайн-заявок
   * (OFFLINE.MAX_OFFLINE_TICKETS) должен считать только CreateTicket,
   * а не все pending (Edit/Comment/Close к офлайн- или серверным
   * заявкам — это не «офлайн-заявки»).
   *
   * Реализация через курсор по индексу status: O(n) по pending,
   * но n редко >50 (иначе лимит уже сработал бы). Отдельный
   * составной индекс [status, command_type] не нужен.
   */
  async countByType(type) {
    const db = await this.dbPromise;
    const tx = db.transaction("outbox", "readonly");
    const index = tx.objectStore("outbox").index("status");
    let count = 0;
    let cursor = await index.openCursor(IDBKeyRange.only("pending"));
    while (cursor) {
      if (cursor.value.command_type === type) count++;
      cursor = await cursor.continue();
    }
    await tx.done;
    return count;
  }
  async clearOutbox() {
    const db = await this.dbPromise;
    await db.clear("outbox");
  }

  // =========================================================================
  // Outbox — SHIM (старый API, до Фаз 1–3)
  // =========================================================================

  /**
   * @deprecated create-controller.js до Фазы 3.
   * Принимает старый формат, мапит в новый.
   */
  async addToOutbox(oldCmd) {
    return this.addOutboxCommand({
      command_uuid:
        oldCmd.uuid ||
        "cmd_" + Date.now() + "_" + Math.random().toString(36).slice(2, 10),
      command_type: "CreateTicket",
      ticket_id: null,
      offline_uuid: oldCmd.offline_uuid || null,
      payload: oldCmd.payload || {},
      created_at: oldCmd.created_at || Math.floor(Date.now() / 1000),
      offline_author_id: oldCmd.offline_author_id ?? null,
      offline_author_name: oldCmd.offline_author_name ?? null,
    });
  }

  /**
   * @deprecated sync-manager.js до Фазы 2.
   * Отдаёт pending в СТАРОМ формате. Всех авторов.
   */
  async getOutboxBatch(limit = 10) {
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

  /**
   * @deprecated tickets-controller.js / details-controller.js до Фазы 3.
   * Отдаёт ТОЛЬКО CreateTicket — для UI «офлайн-заявок». Всех авторов.
   */
  async getAllFromOutbox() {
    const all = await this.getAllPending();
    return all
      .filter(
        (c) => c.command_type === "CreateTicket" && c.status === "pending",
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

  /** @deprecated sync-manager.js до Фазы 2. */
  async deleteFromOutbox(uuids) {
    return this.deleteOutboxCommands(uuids);
  }

  // =========================================================================
  // Кэш заявок (без изменений)
  // =========================================================================

  async saveTickets(type, tickets) {
    const db = await this.dbPromise;
    const tx = db.transaction("tickets_cache", "readwrite");
    const store = tx.objectStore("tickets_cache");

    let cursor = await store.openCursor();
    while (cursor) {
      if (cursor.value._type === type) {
        cursor.delete().catch(() => {});
      }
      cursor = await cursor.continue();
    }

    for (const t of tickets) {
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
