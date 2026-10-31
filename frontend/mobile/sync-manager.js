import { offlineDB } from "./offline-db.js";
import { api } from "./api.js";

export class SyncManager {
  constructor() {
    this.isSyncing = false;
    this.retryTimer = null;
    this.retryCount = 0;
    this.retryDelays = [60, 180, 600]; // 1 мин, 3 мин, 10 мин (в секундах)

    // Слушаем появление сети
    window.addEventListener("online", () => {
      this.updateNetworkStatus("online");
      this.startSync();
    });
    window.addEventListener("offline", () => {
      this.updateNetworkStatus("offline");
    });
  }

  // Обновление плашки "Онлайн/Офлайн" в шапке
  updateNetworkStatus(status) {
    const el = document.getElementById("networkStatus");
    if (!el) return;
    const text = el.querySelector(".text");
    if (!text) return;

    el.className = "network-status " + status;

    if (status === "online") text.textContent = "Онлайн";
    else if (status === "offline") text.textContent = "Нет сети";
    else if (status === "sync") text.textContent = "Синхр...";
    else if (status === "error") text.textContent = "Ошибка синх.";
  }

  // Вызывается при старте приложения или по кнопке "Синхронизировать"
  async startSync() {
    if (this.isSyncing) return;

    // Если сети нет, даже не начинаем синхронизацию
    if (!navigator.onLine) {
      this.updateNetworkStatus("offline");
      return;
    }

    this.isSyncing = true;
    this.updateNetworkStatus("sync");

    try {
      // 1. Сначала пытаемся отправить накопленную очередь
      await this._processQueue();

      // 2. Затем скачиваем свежие списки с сервера
      await this._pullData();

      // Проверяем, не отвалилась ли сеть прямо во время запросов
      if (navigator.onLine) {
        this.updateNetworkStatus("online");
        this.retryCount = 0; // Сбрасываем счетчик ошибок при успехе
      } else {
        this.updateNetworkStatus("offline");
      }
    } catch (error) {
      console.error("[SyncManager] Ошибка синхронизации:", error);

      // Если ошибка сети — ставим "Нет сети" и планируем ретрай
      if (error.message === "network_error" || !navigator.onLine) {
        this.updateNetworkStatus("offline");
        this._scheduleRetry();
      } else {
        this.updateNetworkStatus("error");
      }
    } finally {
      this.isSyncing = false;
    }
  }

  async sendActionDirectly(action) {
    let attempts = 0;
    this.updateNetworkStatus("sync");

    while (attempts < 3) {
      try {
        const res = await api.post(action.payload);

        // Если это сетевая ошибка или таймаут — пробуем еще раз
        if (
          res &&
          res.status === "error" &&
          (res.code === "network_error" || res.code === "aborted")
        ) {
          throw new Error("network_error");
        }

        // Если сервер ответил — связь есть
        if (res) {
          this.updateNetworkStatus("online");
          return res;
        }
      } catch (e) {
        attempts++;
        if (attempts < 3) await new Promise((r) => setTimeout(r, 2000));
      }
    }

    // Если 3 попытки провалились — сохраняем в офлайн-очередь
    console.warn("[SyncManager] Сохраняем в очередь:", action);
    try {
      await offlineDB.addToQueue(action);
      console.log("[SyncManager] ✅ Успешно сохранено в IndexedDB");
    } catch (dbError) {
      console.error("[SyncManager] ❌ ОШИБКА СОХРАНЕНИЯ В БАЗУ:", dbError);
    }

    this.updateNetworkStatus("offline");
    return { status: "offline_saved" };
  }

  // Проход по очереди и отправка пачками
  async _processQueue() {
    const queue = await offlineDB.getQueue();
    console.log(`[SyncManager] Найдено в очереди: ${queue.length}`);
    if (queue.length === 0) return;

    const sentUuids = [];
    for (const action of queue) {
      try {
        console.log(`[SyncManager] Отправка действия: ${action.uuid}`);
        const res = await api.post(action.payload);

        // ЖЕЛЕЗОБЕТОННАЯ ПРОВЕРКА: если сеть отвалилась, бросаем исключение
        // (чтобы не удалить заявку из очереди впустую)
        if (res && res.status === "error" && res.code === "network_error") {
          throw new Error("network_error");
        }

        // Сервер ответил — удаляем из очереди
        sentUuids.push(action.uuid);
      } catch (e) {
        console.error("[SyncManager] Ошибка действия:", e);
        // Прерываем цикл, оставляя неотправленные в очереди
        throw new Error("network_error");
      }
    }

    if (sentUuids.length > 0) {
      await offlineDB.removeFromQueue(sentUuids);
      console.log(`[SyncManager] Удалено из очереди: ${sentUuids.length}`);
    }

    // Если в очереди что-то осталось — запускаем таймер ретрая
    const remaining = await offlineDB.getQueue();
    if (remaining.length > 0) {
      this._scheduleRetry();
    }
  }

  // Запуск таймера 1-3-10 минут
  _scheduleRetry() {
    if (this.retryTimer) clearTimeout(this.retryTimer);

    if (this.retryCount >= this.retryDelays.length) {
      this.updateNetworkStatus("error"); // Все попытки исчерпаны
      return;
    }

    const delay = this.retryDelays[this.retryCount] * 1000;
    console.log(`[SyncManager] Следующая попытка через ${delay / 1000} сек.`);

    this.retryTimer = setTimeout(() => {
      this.retryCount++;
      this.startSync();
    }, delay);
  }

  // Скачивание свежих данных с сервера
  async _pullData() {
    const [ticketsResult, tasksResult] = await Promise.allSettled([
      api.post({ data: "open" }),
      api.post({ data: "tasks" }),
    ]);

    // Если хотя бы один запрос упал по сети (а не просто вернул логическую ошибку),
    // выбрасываем исключение, чтобы startSync знал, что мы офлайн
    if (
      (ticketsResult.status === "fulfilled" &&
        ticketsResult.value?.code === "network_error") ||
      (tasksResult.status === "fulfilled" &&
        tasksResult.value?.code === "network_error") ||
      ticketsResult.status === "rejected" ||
      tasksResult.status === "rejected"
    ) {
      throw new Error("network_error");
    }

    if (
      ticketsResult.status === "fulfilled" &&
      Array.isArray(ticketsResult.value)
    ) {
      await offlineDB.saveList("tickets", ticketsResult.value);
    }

    if (
      tasksResult.status === "fulfilled" &&
      Array.isArray(tasksResult.value)
    ) {
      await offlineDB.saveList("tasks", tasksResult.value);
    }
  }
}

export const syncManager = new SyncManager();
