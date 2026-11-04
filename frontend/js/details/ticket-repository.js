/**
 * Сетевой слой карточки заявки.
 *
 * Контракты:
 *   fetchById     → { ok: boolean, data: object|null, errorType: 'not_found'|'network'|null }
 *   saveEdit      → сырой ответ api.post
 *   saveClose     → сырой ответ api.post
 *   addNote       → сырой ответ api.post
 */

export const ticketRepository = {
  /**
   * Точечная загрузка заявки через { data: 'ticket', call_id }.
   *
   * @param {ApiService} api
   * @param {string|number} ticketId
   * @returns {Promise<{ok: boolean, data: object|null, errorType: string|null}>}
   */
  async fetchById(api, ticketId) {
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
