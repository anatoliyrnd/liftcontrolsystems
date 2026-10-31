import { openDB } from "./vendor/idb.js";

class OfflineDB {
  constructor() {
    // ПОДНЯЛИ ВЕРСИЮ ДО 2
    this.dbPromise = openDB("LiftMechanicDB", 2, {
      upgrade(db, oldVersion, newVersion, transaction) {
        if (!db.objectStoreNames.contains("config")) {
          db.createObjectStore("config", { keyPath: "key" });
        }
        if (!db.objectStoreNames.contains("tickets_cache")) {
          db.createObjectStore("tickets_cache", { keyPath: "id" });
        }
        if (!db.objectStoreNames.contains("tasks_cache")) {
          db.createObjectStore("tasks_cache", { keyPath: "id" });
        }
        if (!db.objectStoreNames.contains("sync_queue")) {
          db.createObjectStore("sync_queue", { keyPath: "uuid" });
        } else {
          // Если база уже была, пересоздаем хранилище с правильным ключом
          db.deleteObjectStore("sync_queue");
          db.createObjectStore("sync_queue", { keyPath: "uuid" });
        }
      },
    });
  }

  // --- НАСТРОЙКИ ---
  async setConfig(key, value) {
    const db = await this.dbPromise;
    await db.put("config", { key, value });
  }

  async getConfig(key) {
    const db = await this.dbPromise;
    const res = await db.get("config", key);
    return res ? res.value : null;
  }

  // --- СПИСКИ ЗАЯВОК И ЗАДАЧ ---
  async saveList(type, items) {
    const db = await this.dbPromise;
    const storeName = type === "tasks" ? "tasks_cache" : "tickets_cache";
    const tx = db.transaction(storeName, "readwrite");
    const store = tx.objectStore(storeName);

    await store.clear();
    for (const item of items) {
      await store.put(item);
    }
    await tx.done;
  }

  async getList(type) {
    const db = await this.dbPromise;
    const storeName = type === "tasks" ? "tasks_cache" : "tickets_cache";
    return await db.getAll(storeName);
  }

  // --- ОЧЕРЕДЬ ДЕЙСТВИЙ (SYNC QUEUE) ---
  async addToQueue(action) {
    const db = await this.dbPromise;
    if (!action.uuid) {
      action.uuid =
        "act_" + Date.now() + "_" + Math.random().toString(36).substr(2, 5);
    }
    action.timestamp = Math.floor(Date.now() / 1000);
    await db.put("sync_queue", action);
  }

  async getQueue() {
    const db = await this.dbPromise;
    return await db.getAll("sync_queue");
  }

  async removeFromQueue(uuids) {
    const db = await this.dbPromise;
    const tx = db.transaction("sync_queue", "readwrite");
    const store = tx.objectStore("sync_queue");

    // Ждем завершения всех запросов на удаление
    await Promise.all(uuids.map((id) => store.delete(id)));

    await tx.done;
  }
  async clearQueue() {
    const db = await this.dbPromise;
    await db.clear("sync_queue");
  }

  // --- ТОЧЕЧНЫЕ ОБНОВЛЕНИЯ ---
  async updateTicket(id, patch) {
    const db = await this.dbPromise;
    const tx = db.transaction("tickets_cache", "readwrite");
    const store = tx.objectStore("tickets_cache");

    // Получаем текущую заявку
    const target = await store.get(Number(id)); // или String(id) в зависимости от типа ключа
    if (target) {
      // Объединяем старые данные с новыми
      await store.put({ ...target, ...patch });
    }
    await tx.done;
    return !!target;
  }

  async removeTicket(id) {
    const db = await this.dbPromise;
    await db.delete("tickets_cache", Number(id)); // Или String(id)
  }

  // --- ПОЛНАЯ ОЧИСТКА ---
  async clearAll() {
    const db = await this.dbPromise;
    await db.clear("tickets_cache");
    await db.clear("tasks_cache");
    await db.clear("sync_queue");
    await db.clear("config");
  }
}

export const offlineDB = new OfflineDB();
