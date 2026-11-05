/**
 * Сетевой слой карточки заявки.
 *
 * Контракты:
 *   fetchById     → { ok: boolean, data: object|null, errorType: 'not_found'|'network'|null }
 *   saveEdit      → сырой ответ api.post
 *   saveClose     → сырой ответ api.post
 *   addNote       → сырой ответ api.post
 */
import { offlineDB } from "../offline-db.js";
export const ticketRepository = {
  async fetchById(api, ticketId) {
    // #6: offline_ → читаем только из offlineDB, без запроса на сервер
    // (API_syncCommands.md v5.2 §12.2).
    if (typeof ticketId === "string" && ticketId.startsWith("offline_")) {
      try {
        const found = await offlineDB.findPendingCreateByOfflineUuid(ticketId);
        if (!found) {
          // CreateTicket уже синхронизирован и удалён из outbox —
          // для UI это not_found (пользователь обновит журнал).
          return { ok: false, data: null, errorType: "not_found" };
        }
        const p = found.payload || {};
        const offlineTicket = {
          ...p,
          id: found.offline_uuid,
          isOffline: true,
          // type нужен контроллеру до применения overlay #8
          type: p.solution ? "close" : "open",
          // opened_at (после #2) точнее, чем created_at outbox-записи
          date: p.opened_at ?? found.created_at,
        };
        return {
          ok: true,
          data: offlineTicket,
          errorType: null,
          offline: true,
        };
      } catch (err) {
        console.error("[TicketRepo] Offline fetch error:", err);
        return { ok: false, data: null, errorType: "network" };
      }
    }
    try {
      const resp = await api.post(
        { data: "ticket", call_id: ticketId },
        "Загрузка карточки №" + ticketId + "...",
        "details-read",
      );

      // Отмена по abortTag (при уходе со страницы) — молча выходим.
      // Ошибкой это не считаем, mount отсечёт результат по isStale().
      if (!resp || resp.code === "aborted") {
        return { ok: false, data: null, errorType: "aborted" };
      }

      if (resp.status === "error") {
        console.warn(
          "[TicketRepo] Ошибка загрузки заявки:",
          resp.code,
          resp.message,
        );
        return { ok: false, data: null, errorType: "network" };
      }

      if (resp.status !== "ok") {
        return { ok: false, data: null, errorType: "network" };
      }

      const ticket = resp.data;
      if (!ticket) {
        return { ok: false, data: null, errorType: "not_found" };
      }

      // Унифицируем type (сервер может вернуть call_status 0/1)
      if (!ticket.type) {
        const isClosed = Number(ticket.call_status) === 1;
        ticket.type = isClosed ? "close" : "open";
      }

      return { ok: true, data: ticket, errorType: null };
    } catch (err) {
      console.error("[TicketRepo] Ошибка сети:", err);
      return { ok: false, data: null, errorType: "network" };
    }
  },

  /**
   * Сохранение изменений (назначение ответственных, отдел, время).
   */
  async saveEdit(api, ticketId, patch) {
    return api.post(
      { action: "calledit", call_id: ticketId, ...patch },
      "",
      "details-write",
    );
  },

  /**
   * Закрытие заявки.
   */
  async saveClose(api, ticketId, solution, userId) {
    return api.post(
      { action: "callClose", call_id: ticketId, solution, user_id: userId },
      "",
      "details-write",
    );
  },

  /**
   * Добавление комментария (с фото или без).
   */
  async addNote(api, ticketId, text, photoBase64 = null) {
    const payload = {
      action: "callnote",
      call_id: ticketId,
      note: text,
    };
    if (photoBase64) payload.photo_base64 = photoBase64;

    return api.post(payload, "", "details-write");
  },
};
