import { offlineDB } from "../offline-db.js";
import { outboxQueue } from "../outbox-queue.js";
import { OFFLINE } from "../config.js";

export const createRepository = {
  // 🔥 ДОБАВЛЕН 3-й аргумент options
  async saveOnline(api, payload, options = {}) {
    const body = { action: "callnew", ...payload };
    if (options.force_create) {
      body.force_create = true;
    }
    return api.post(body, "Запись инцидента...");
  },

  async saveOffline(payload) {
    const count = await offlineDB.countByType("CreateTicket");
    if (count >= OFFLINE.MAX_OFFLINE_TICKETS) {
      return { ok: false, error: "limit_reached" };
    }
    const cmd = await outboxQueue.enqueueCreate(payload);
    return { ok: true, offlineUuid: cmd.offline_uuid };
  },
};