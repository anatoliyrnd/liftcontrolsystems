import { offlineDB } from "./offline-db.js";
import { authStore } from "./auth-store.js";
import { generateCommandUuid, generateOfflineUuid } from "./utils/uuid.js";
import { formatTs } from "./utils/date-utils.js";

function nowTs() {
  return Math.floor(Date.now() / 1000);
}

function currentAuthor() {
  const user = authStore.getUser();
  if (!user) return { id: null, name: null };
  const name = user.surname
    ? `${user.surname} ${user.name || ""}`.trim()
    : user.name;
  return { id: user.id ?? null, name: name || null };
}

/** Очередь изменилась — шапка и флаг beforeunload должны пересчитаться. */
function notifyQueueChanged() {
  window.dispatchEvent(new Event("refreshSyncState"));
}

function baseCommand(type, payload, extra = {}) {
  const author = currentAuthor();
  return {
    command_uuid: generateCommandUuid(),
    command_type: type,
    ticket_id: extra.ticket_id ?? null,
    offline_uuid: extra.offline_uuid ?? null,
    payload,
    created_at: nowTs(),
    retry_count: 0,
    next_retry_at: 0,
    last_error: null,
    status: "pending",
    offline_author_id: author.id,
    offline_author_name: author.name,
  };
}

// --- Совместимость с idb-обёрткой и «голым» IDBDatabase ---
function asPromise(requestOrPromise) {
  if (requestOrPromise && typeof requestOrPromise.then === "function") {
    return requestOrPromise;
  }
  return new Promise((resolve, reject) => {
    requestOrPromise.onsuccess = () => resolve(requestOrPromise.result);
    requestOrPromise.onerror = () => reject(requestOrPromise.error);
  });
}

function transactionDone(tx) {
  if (tx.done && typeof tx.done.then === "function") return tx.done;
  return new Promise((resolve, reject) => {
    tx.oncomplete = () => resolve();
    tx.onerror = () => reject(tx.error);
    tx.onabort = () => reject(tx.error || new Error("Transaction aborted"));
  });
}

/**
 * Сворачивание правок офлайн-заявки в CreateTicket (Вариант А, §9.1).
 *
 * Чтение по индексу и запись — в ОДНОЙ readwrite-транзакции: два быстрых
 * комментария не перетирают друг друга. updateFn обязан быть синхронным,
 * иначе транзакция закроется до записи.
 *
 * Срок ремонта не сливается никогда — сервер назначает его сам (§4.1.1).
 * Возвращается ОБНОВЛЁННАЯ запись, а не исходная.
 */
async function mergeIntoOfflineCreate(offlineUuid, updateFn) {
  const db = await offlineDB.dbPromise;
  const tx = db.transaction("outbox", "readwrite");
  const done = transactionDone(tx);
  const store = tx.objectStore("outbox");

  let cmds;
  try {
    const index = store.index("offline_uuid");
    cmds = await asPromise(index.getAll(IDBKeyRange.only(offlineUuid)));
  } catch (e) {
    // Индекса нет (старая схема) — деградируем на полное чтение в той же tx.
    cmds = await asPromise(store.getAll());
    cmds = cmds.filter((c) => c.offline_uuid === offlineUuid);
  }

  const cmd = cmds.find(
    (c) => c.command_type === "CreateTicket" && c.status === "pending",
  );

  if (!cmd) {
    await done;
    return null;
  }

  const updatedPayload = { ...cmd.payload };
  // Страховка: срок не должен протечь в payload ни из старых записей.
  delete updatedPayload.repair_time;
  updateFn(updatedPayload);

  const updated = { ...cmd, payload: updatedPayload };
  await asPromise(store.put(updated));
  await done;
  return updated;
}

export const outboxQueue = {
  async enqueueCreate(payload) {
    const author = currentAuthor();
    const enriched = {
      ...payload,
      offline_author_id: payload.offline_author_id ?? author.id,
      offline_author_name: payload.offline_author_name ?? author.name,
      opened_at: payload.opened_at ?? nowTs(),
    };
    // Клиент офлайн срок не задаёт.
    delete enriched.repair_time;

    const cmd = baseCommand("CreateTicket", enriched, {
      ticket_id: null,
      offline_uuid: generateOfflineUuid(),
    });
    const result = await offlineDB.addOutboxCommand(cmd);
    notifyQueueChanged();
    return result;
  },

  async enqueueEdit(ticketId, patch, opts = {}) {
    const isOffline = String(ticketId).startsWith("offline_");
    const offlineUuid = isOffline ? ticketId : opts.offline_uuid;

    if (offlineUuid) {
      const merged = await mergeIntoOfflineCreate(offlineUuid, (payload) => {
        if (patch.details) {
          payload.details = (payload.details || "") + "\n\n" + patch.details;
        }
        if (patch.staff_id != null) payload.staff_id = patch.staff_id;
        if (patch.notify_status != null)
          payload.notify_status = patch.notify_status;
      });
      if (merged) {
        notifyQueueChanged();
        return merged;
      }
    }

    const payload = {};
    if (typeof patch.details === "string" && patch.details.trim() !== "") {
      payload.details = patch.details.trim();
    }
    if (patch.staff_id != null) payload.staff_id = patch.staff_id;
    if (patch.notify_status != null)
      payload.notify_status = patch.notify_status;

    const cmd = baseCommand("EditTicket", payload, {
      ticket_id: isOffline ? null : ticketId,
      offline_uuid: offlineUuid,
    });
    const result = await offlineDB.addOutboxCommand(cmd);
    notifyQueueChanged();
    return result;
  },

  async enqueueClose(ticketId, solution, opts = {}) {
    const isOffline = String(ticketId).startsWith("offline_");
    const offlineUuid = isOffline ? ticketId : opts.offline_uuid;
    const author = currentAuthor();
    const trimmed = String(solution || "").trim();

    if (offlineUuid) {
      const merged = await mergeIntoOfflineCreate(offlineUuid, (payload) => {
        payload.solution = trimmed;
        payload.closed_at = nowTs();
        payload.closed_by_name = author.name || "—";
        payload.closed_by_id = author.id;
      });
      if (merged) {
        notifyQueueChanged();
        return merged;
      }
    }

    const cmd = baseCommand(
      "CloseTicket",
      { solution: trimmed, closed_at: nowTs() },
      { ticket_id: isOffline ? null : ticketId, offline_uuid: offlineUuid },
    );
    const result = await offlineDB.addOutboxCommand(cmd);
    notifyQueueChanged();
    return result;
  },

  async enqueueComment(ticketId, text, opts = {}) {
    const isOffline = String(ticketId).startsWith("offline_");
    const offlineUuid = isOffline ? ticketId : opts.offline_uuid;
    const author = currentAuthor();
    const body = String(text || "").trim();

    if (offlineUuid) {
      const dateStr = formatTs(nowTs()).replace("@", " ");
      const line = `[${author.name || "Сотрудник"}, ${dateStr}]: ${body}`;
      const merged = await mergeIntoOfflineCreate(offlineUuid, (payload) => {
        payload.comments = payload.comments
          ? payload.comments + "\n" + line
          : `⏳ [Офлайн-комментарии]\n${line}`;
      });
      if (merged) {
        notifyQueueChanged();
        return merged;
      }
    }

    const cmd = baseCommand(
      "AddComment",
      { text: body, created_at: nowTs() },
      { ticket_id: isOffline ? null : ticketId, offline_uuid: offlineUuid },
    );
    const result = await offlineDB.addOutboxCommand(cmd);
    notifyQueueChanged();
    return result;
  },

  async getPendingBatch(limit = 20) {
    return offlineDB.getPendingBatch(limit);
  },

  async getPendingByTicket(ticketId) {
    return offlineDB.getPendingByTicket(ticketId);
  },

  async getPendingByAuthor(authorId) {
    return offlineDB.getPendingByAuthor(authorId);
  },

  async getTicketFlags(ticketId) {
    const cmds = await offlineDB.getPendingByTicket(ticketId);
    const flags = {
      hasCreate: false,
      hasEdit: false,
      hasClose: false,
      hasComment: false,
      count: cmds.length,
    };
    for (const c of cmds) {
      if (c.command_type === "CreateTicket") flags.hasCreate = true;
      if (c.command_type === "EditTicket") flags.hasEdit = true;
      if (c.command_type === "CloseTicket") flags.hasClose = true;
      if (c.command_type === "AddComment") flags.hasComment = true;
    }
    return flags;
  },

  async remove(commandUuids) {
    const result = await offlineDB.deleteOutboxCommands(commandUuids);
    notifyQueueChanged();
    return result;
  },

  async markFailed(commandUuid, reason) {
    const result = await offlineDB.updateOutboxCommand(commandUuid, {
      status: "failed",
      last_error: String(reason || "unknown"),
    });
    notifyQueueChanged();
    return result;
  },

  async markRetry(commandUuid, reason, nextRetryAt) {
    const all = await offlineDB.getAllPending();
    const record = all.find((c) => c.command_uuid === commandUuid);
    const retryCount = (record?.retry_count ?? 0) + 1;
    const result = await offlineDB.updateOutboxCommand(commandUuid, {
      retry_count: retryCount,
      next_retry_at: nextRetryAt || 0,
      last_error: String(reason || "unknown"),
      status: "pending",
    });
    notifyQueueChanged();
    return result;
  },

  async resetToPending(commandUuid) {
    const result = await offlineDB.updateOutboxCommand(commandUuid, {
      status: "pending",
      next_retry_at: 0,
    });
    notifyQueueChanged();
    return result;
  },

  async clear() {
    const result = await offlineDB.clearOutbox();
    notifyQueueChanged();
    return result;
  },

  async getCounts() {
    const [pending, failed] = await Promise.all([
      offlineDB.getOutboxCount(),
      offlineDB.getFailedCount(),
    ]);
    return { pending, failed };
  },
};
