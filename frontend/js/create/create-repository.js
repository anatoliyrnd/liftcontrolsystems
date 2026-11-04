import { offlineDB } from "../offline-db.js";
import { outboxQueue } from "../outbox-queue.js";
import { OFFLINE } from "../config.js";

export const createRepository = {
  async saveOnline(api, payload) {
    return api.post({ action: "callnew", ...payload }, "Запись инцидента...");
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
