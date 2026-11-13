/**
 * Сетевой слой карточки заявки.
 *
 * fetchById → { ok, data, errorType: 'not_found'|'network'|'aborted'|null, offline? }
 * saveEdit / saveClose / addNote → сырой ответ api.post
 *
 * Переходная мера (§4 ТЗ): сервер в `ticket` отдаёт call_id + call_number без id,
 * а списки — только id. Нормализуем все три поля здесь, сразу после ответа,
 * чтобы карточка по прямой ссылке показывала номер и могла сохранять изменения.
 * Снять после добавления id на сервере.
 */

import { offlineDB } from "../offline-db.js";

/** Unix-метка в секундах. Миллисекунды outbox приводим к секундам. */
function toSeconds(value) {
  const n = Number(value);
  if (!Number.isFinite(n) || n <= 0) return null;
  return n > 9999999999 ? Math.floor(n / 1000) : n;
}

const DATE_FIELDS = [
  "date",
  "repair_time",
  "close_date",
  "closed_at",
  "opened_at",
  "notify_date",
  "notify_date2",
  "notify_date3",
];

function normalizeDates(ticket) {
  for (const key of DATE_FIELDS) {
    if (ticket[key] == null || ticket[key] === "") continue;
    const sec = toSeconds(ticket[key]);
    ticket[key] = sec == null ? null : sec;
  }
  return ticket;
}

/** id / call_id / call_number — одно значение, все три обязательны. */
function normalizeIdentity(ticket, requestedId) {
  if (!ticket || typeof ticket !== "object") return ticket;

  const fallback = ticket.call_id ?? ticket.call_number ?? requestedId ?? null;

  if (ticket.id == null || ticket.id === "") ticket.id = fallback;
  if (ticket.call_id == null || ticket.call_id === "")
    ticket.call_id = ticket.id;
  if (ticket.call_number == null || ticket.call_number === "")
    ticket.call_number = ticket.id == null ? "" : String(ticket.id);

  return ticket;
}

export const ticketRepository = {
  async fetchById(api, ticketId) {
    // offline_ → только offlineDB, без запроса на сервер.
    if (typeof ticketId === "string" && ticketId.startsWith("offline_")) {
      try {
        const found = await offlineDB.findPendingCreateByOfflineUuid(ticketId);
        if (!found) {
          // CreateTicket уже синхронизирован и удалён из outbox.
          return { ok: false, data: null, errorType: "not_found" };
        }

        const p = found.payload || {};
        const offlineTicket = normalizeDates({
          ...p,
          id: found.offline_uuid,
          call_id: null,
          call_number: found.offline_uuid,
          offline_uuid: found.offline_uuid,
          isOffline: true,
          // type нужен контроллеру до применения overlay.
          type: p.solution ? "close" : "open",
          // opened_at точнее, чем created_at outbox-записи.
          date: p.opened_at ?? found.created_at,
          fullAddress: p.fullAddress || p.address || "",
          address: p.fullAddress || p.address || "",
          creator_name: p.offline_author_name || null,
          // Срок офлайн не задаётся — сервер назначит при синхронизации.
          repair_time: null,
        });

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

     
      // Отмена по abortTag (уход со страницы) — не ошибка, экран не рисуем.
      if (resp && resp.code === "aborted" && resp.reason !== "timeout") {
        return { ok: false, data: null, errorType: "aborted" };
      }
      if (resp && resp._authLost) {
        return { ok: false, data: null, errorType: "aborted" };
      }
       // Таймаут и не-JSON — сетевая неопределённость, а не отмена:
      // экран ошибки с кнопкой повтора вместо пустой карточки.
      if (!resp || resp.offline === true) {
        return { ok: false, data: null, errorType: "network" };
      }

      const ticket = resp.data;
      if (!ticket) {
        return { ok: false, data: null, errorType: "not_found" };
      }

      normalizeIdentity(ticket, ticketId);
      normalizeDates(ticket);

      if (!ticket.type) {
        ticket.type = Number(ticket.call_status) === 1 ? "close" : "open";
      }
      if (!ticket.fullAddress && ticket.address)
        ticket.fullAddress = ticket.address;
      if (!ticket.address && ticket.fullAddress)
        ticket.address = ticket.fullAddress;

      return { ok: true, data: ticket, errorType: null };
    } catch (err) {
      console.error("[TicketRepo] Ошибка сети:", err);
      return { ok: false, data: null, errorType: "network" };
    }
  },

  async saveEdit(api, ticketId, patch) {
    return api.post(
      { action: "calledit", call_id: ticketId, ...patch },
      "",
      "details-write",
    );
  },

  async saveClose(api, ticketId, solution, userId) {
    return api.post(
      { action: "callClose", call_id: ticketId, solution, user_id: userId },
      "",
      "details-write",
    );
  },

  async addNote(api, ticketId, text, photoBase64 = null) {
    const payload = { action: "callnote", call_id: ticketId, note: text };
    if (photoBase64) payload.photo_base64 = photoBase64;
    return api.post(payload, "", "details-write");
  },
};
