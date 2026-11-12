/**
 * Нормализация числовых полей тикета.
 *
 * Мутирует переданный объект и возвращает его же — вызывающий код
 * (details-controller) рассчитывает на это:
 *   - mount:              this.ticket = normalizeTicketFields({...ticket});
 *   - _refreshTicketAfterSave: normalizeTicketFields(fresh) без присваивания.
 *
 * Причина: сервер возвращает staff_id / notify_status / repair_time
 * строками ("0", "5", ""), из-за чего проверки `!ticket.staff_id`
 * дают ложные результаты. Приводим к числу или null один раз —
 * в mount и после refresh.
 *
 * ВАЖНО (текущее поведение, не меняем на этом шаге):
 *   `Number(x) || null` превращает 0 в null. Для staff_id* это
 *   корректно (0 = «не назначен»), но для полей, где 0 — валидное
 *   значение, паттерн опасен. notify_status* уже обрабатываются
 *   отдельно (`Number(x) || 0`), repair_time — отдельной веткой.
 *   При выносе details-state (Шаг 3) пересмотрим это явно.
 *
 * @param {object|null} ticket
 * @returns {object|null}
 */
export function normalizeTicketFields(ticket) {
  if (!ticket) return ticket;

  const toIdOrNull = (v) => {
    if (v == null || v === "") return null;
    const n = Number(v);
    return Number.isFinite(n) && n !== 0 ? n : null;
  };
  const toStatus = (v) => {
    const n = Number(v);
    return Number.isFinite(n) ? n : 0;
  };

  ticket.staff_id = toIdOrNull(ticket.staff_id);
  ticket.staff_id2 = toIdOrNull(ticket.staff_id2);
  ticket.staff_id3 = toIdOrNull(ticket.staff_id3);

  ticket.notify_status = toStatus(ticket.notify_status);
  ticket.notify_status2 = toStatus(ticket.notify_status2);
  ticket.notify_status3 = toStatus(ticket.notify_status3);

  ticket.repair_time = toIdOrNull(ticket.repair_time);

  return ticket;
}
