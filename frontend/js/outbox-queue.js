/**
 * Единый фасад постановки офлайн-команд в outbox.
 *
 * Все контроллеры (create / details) работают ТОЛЬКО через этот модуль.
 * Прямой offlineDB.addOutboxCommand() — запрещён, кроме как изнутри здесь.
 *
 * Схема записи (см. offline-db.js v2):
 *   command_uuid, command_type, ticket_id, offline_uuid,
 *   payload, created_at, retry_count, next_retry_at, last_error,
 *   status, offline_author_id, offline_author_name
 *
 * Авторство (offline_author_id / offline_author_name) фиксируется
 * в момент enqueue. Если команду потом синхронизирует другой пользователь
 * — batch-builder добавит префикс-маркер в payload (см. applyAuthorMarker).
 */

import { offlineDB } from "./offline-db.js";
import { authStore } from "./auth-store.js";
import { generateCommandUuid, generateOfflineUuid } from "./utils/uuid.js";

function nowTs() {
  return Math.floor(Date.now() / 1000);
}

function currentAuthor() {
  const user = authStore.getUser();
  return {
    id: user?.id ?? null,
    name: user?.name ?? null,
  };
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

// #3–#5: общий хелпер поиска pending-CreateTicket для offline-заявки
async function requirePendingCreate(offlineUuid) {
  const cmd = await offlineDB.findPendingCreateByOfflineUuid(offlineUuid);
  if (!cmd) {
    // CreateTicket уже ушёл на сервер — offline_-id в UI устарел.
    // Бросаем, чтобы вызывающий (details-controller) показал ошибку,
    // а не создал невалидный EditTicket/Comment/Close с ticket_id="offline_...".
    throw new Error(
      `CreateTicket not found in outbox for offline ticket ${offlineUuid}`,
    );
  }
  return cmd;
}

const OFFLINE_COMMENT_HEADER = "⏳ [Офлайн-комментарии]";

// Формат из §7.2: [Автор, ДД.ММ.ГГГГ ЧЧ:ММ]: текст
function formatRuDateTime(ts) {
  const d = new Date(ts * 1000);
  const dd = String(d.getDate()).padStart(2, "0");
  const mm = String(d.getMonth() + 1).padStart(2, "0");
  const yyyy = d.getFullYear();
  const hh = String(d.getHours()).padStart(2, "0");
  const min = String(d.getMinutes()).padStart(2, "0");
  return `${dd}.${mm}.${yyyy} ${hh}:${min}`;
}

export const outboxQueue = {
  // #2
  async enqueueCreate(payload) {
    const offlineUuid = generateOfflineUuid();
    const cmd = baseCommand(
      "CreateTicket",
      {
        ...payload,
        opened_at: nowTs(),
      },
      {
        ticket_id: null,
        offline_uuid: offlineUuid,
      },
    );
    return offlineDB.addOutboxCommand(cmd);
  },

  // #3
  async enqueueEdit(ticketId, patch, opts = {}) {
    if (typeof ticketId === "string" && ticketId.startsWith("offline_")) {
      const createCmd = await requirePendingCreate(ticketId);
      const merged = { ...createCmd.payload };

      // details — append-only (сервер склеит через \n\n)
      if (typeof patch.details === "string" && patch.details.trim() !== "") {
        const prev = merged.details || "";
        merged.details = prev
          ? `${prev}\n\n${patch.details.trim()}`
          : patch.details.trim();
      }
      // остальные поля patch уже отфильтрованы _saveEditOffline
      if (patch.staff_id != null) merged.staff_id = patch.staff_id;
      if (patch.notify_status != null)
        merged.notify_status = patch.notify_status;
      if (patch.repair_time != null) merged.repair_time = patch.repair_time;

      return offlineDB.updateOutboxCommand(createCmd.command_uuid, {
        payload: merged,
      });
    }

    const payload = {};
    if (typeof patch.details === "string" && patch.details.trim() !== "") {
      payload.details = patch.details.trim();
    }
    if (patch.staff_id != null) payload.staff_id = patch.staff_id;
    if (patch.notify_status != null)
      payload.notify_status = patch.notify_status;
    if (patch.repair_time != null) payload.repair_time = patch.repair_time;

    const cmd = baseCommand("EditTicket", payload, {
      ticket_id: ticketId ?? null,
      offline_uuid: opts.offline_uuid ?? null,
    });
    return offlineDB.addOutboxCommand(cmd);
  },

  // #4
  async enqueueComment(ticketId, text, opts = {}) {
    if (typeof ticketId === "string" && ticketId.startsWith("offline_")) {
      const createCmd = await requirePendingCreate(ticketId);
      const author = currentAuthor();
      const ts = nowTs();
      const cleanText = String(text || "")
        .trim()
        .replace(/\s+/g, " ");
      const line = `[${author.name || "Автор"}, ${formatRuDateTime(ts)}]: ${cleanText}`;

      const prev = createCmd.payload.comments || "";
      const comments = prev
        ? `${prev}\n${line}`
        : `${OFFLINE_COMMENT_HEADER}\n${line}`;

      return offlineDB.updateOutboxCommand(createCmd.command_uuid, {
        payload: { ...createCmd.payload, comments },
      });
    }

    const cmd = baseCommand(
      "AddComment",
      {
        text: String(text || "").trim(),
        created_at: nowTs(),
      },
      {
        ticket_id: ticketId ?? null,
        offline_uuid: opts.offline_uuid ?? null,
      },
    );
    return offlineDB.addOutboxCommand(cmd);
  },

  // #5
  async enqueueClose(ticketId, solution, opts = {}) {
    if (typeof ticketId === "string" && ticketId.startsWith("offline_")) {
      const createCmd = await requirePendingCreate(ticketId);
      const author = currentAuthor();
      const merged = {
        ...createCmd.payload,
        solution: String(solution || "").trim(),
        closed_at: nowTs(),
        closed_by_name: author.name || null,
        closed_by_id: author.id ?? null,
      };
      return offlineDB.updateOutboxCommand(createCmd.command_uuid, {
        payload: merged,
      });
    }

    const cmd = baseCommand(
      "CloseTicket",
      {
        solution: String(solution || "").trim(),
        closed_at: nowTs(),
      },
      {
        ticket_id: ticketId ?? null,
        offline_uuid: opts.offline_uuid ?? null,
      },
    );
    return offlineDB.addOutboxCommand(cmd);
  },

  // =====================================================================
  // Чтение (обёртки над offline-db для единообразия)
  // =====================================================================

  /**
   * Все pending, FIFO. Любые авторы. Для batch-builder'а.
   */
  async getPendingBatch(limit = 20) {
    return offlineDB.getPendingBatch(limit);
  },

  /**
   * Pending по заявке — для бейджей «⏳» в таблице и карточке.
   * Возвращает массив команд (любые авторы).
   */
  async getPendingByTicket(ticketId) {
    return offlineDB.getPendingByTicket(ticketId);
  },

  /**
   * Pending по автору — только для UI-фильтра «Только мои» в очереди.
   */
  async getPendingByAuthor(authorId) {
    return offlineDB.getPendingByAuthor(authorId);
  },

  /**
   * Сводка по заявке: { hasEdit, hasClose, hasComment, hasCreate, count }
   * Удобно для рендера бейджей.
   */
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

  // =====================================================================
  // Управление
  // =====================================================================

  async remove(commandUuids) {
    return offlineDB.deleteOutboxCommands(commandUuids);
  },

  async markFailed(commandUuid, reason) {
    return offlineDB.updateOutboxCommand(commandUuid, {
      status: "failed",
      last_error: String(reason || "unknown"),
    });
  },

  async markRetry(commandUuid, reason, nextRetryAt) {
    const existing = await offlineDB.getPendingBatch(1);
    // читаем актуальный retry_count из store
    const all = await offlineDB.getAllPending();
    const record = all.find((c) => c.command_uuid === commandUuid);
    const retryCount = (record?.retry_count ?? 0) + 1;
    return offlineDB.updateOutboxCommand(commandUuid, {
      retry_count: retryCount,
      next_retry_at: nextRetryAt || 0,
      last_error: String(reason || "unknown"),
      status: "pending",
    });
  },

  async resetToPending(commandUuid) {
    return offlineDB.updateOutboxCommand(commandUuid, {
      status: "pending",
      next_retry_at: 0,
    });
  },

  async clear() {
    return offlineDB.clearOutbox();
  },

  async getCounts() {
    const [pending, failed] = await Promise.all([
      offlineDB.getOutboxCount(),
      offlineDB.getFailedCount(),
    ]);
    return { pending, failed };
  },
};
