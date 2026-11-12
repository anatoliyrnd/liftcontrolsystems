/**
 * Нормализация полей тикета. Мутирует объект и возвращает его же —
 * details-controller рассчитывает на это (_refreshTicketAfterSave
 * вызывает без присваивания).
 *
 * Семантика нуля зафиксирована явно (п. 1.22):
 *   staff_id*      0 / "" / null → null   («не назначен»)
 *   repair_time    0 / "" / null → null   («срок не задан»)
 *   notify_status  0 — валидное «не уведомлён», сохраняется
 *   notify_status2/3  пустой слот остаётся null (протокол §17: int|null),
 *                     непустой нечисловой мусор → 0
 *
 * Дополнительно — переходная нормализация идентификаторов (§4 ТЗ):
 * объект из списка несёт только id, карточка с сервера — call_id.
 * Здесь они сводятся к одному значению независимо от источника.
 */

const DATE_FIELDS = [
  "date",
  "repair_time",
  "close_date",
  "notify_date",
  "notify_date2",
  "notify_date3",
];

function toSeconds(value) {
  const n = Number(value);
  if (!Number.isFinite(n) || n <= 0) return null;
  return n > 9999999999 ? Math.floor(n / 1000) : n;
}

export function normalizeTicketFields(ticket) {
  if (!ticket || typeof ticket !== "object") return ticket;

  const toIdOrNull = (v) => {
    if (v == null || v === "") return null;
    const n = Number(v);
    return Number.isFinite(n) && n !== 0 ? n : null;
  };

  // Первый слот: пустое значение = «не уведомлён» (0).
  const toStatus = (v) => {
    const n = Number(v);
    return Number.isFinite(n) ? n : 0;
  };

  // Слоты 2 и 3: пустое значение = слот не занят (null).
  const toOptionalStatus = (v) => {
    if (v == null || v === "") return null;
    const n = Number(v);
    return Number.isFinite(n) ? n : 0;
  };

  // --- Идентификаторы (переходная мера, снять после id на сервере) ---
  if (!ticket.isOffline) {
    const fallback = ticket.call_id ?? ticket.call_number ?? ticket.id ?? null;
    if (ticket.id == null || ticket.id === "") ticket.id = fallback;
    if (ticket.call_id == null || ticket.call_id === "")
      ticket.call_id = ticket.id;
    if (ticket.call_number == null || ticket.call_number === "")
      ticket.call_number = ticket.id == null ? "" : String(ticket.id);
  }

  // --- Ответственные ---
  ticket.staff_id = toIdOrNull(ticket.staff_id);
  ticket.staff_id2 = toIdOrNull(ticket.staff_id2);
  ticket.staff_id3 = toIdOrNull(ticket.staff_id3);

  // --- Статусы уведомления ---
  ticket.notify_status = ticket.staff_id
    ? toStatus(ticket.notify_status)
    : toOptionalStatus(ticket.notify_status);
  ticket.notify_status2 = ticket.staff_id2
    ? toStatus(ticket.notify_status2)
    : toOptionalStatus(ticket.notify_status2);
  ticket.notify_status3 = ticket.staff_id3
    ? toStatus(ticket.notify_status3)
    : toOptionalStatus(ticket.notify_status3);

  // --- Срок ремонта ---
  ticket.repair_time = toIdOrNull(ticket.repair_time);

  // --- Даты: секунды, миллисекунды outbox приводим ---
  for (const key of DATE_FIELDS) {
    if (key === "repair_time") continue;
    if (ticket[key] == null || ticket[key] === "") continue;
    ticket[key] = toSeconds(ticket[key]);
  }

  // --- Адрес: единое поле для карточки и журнала ---
  if (!ticket.fullAddress && ticket.address)
    ticket.fullAddress = ticket.address;
  if (!ticket.address && ticket.fullAddress)
    ticket.address = ticket.fullAddress;

  return ticket;
}
