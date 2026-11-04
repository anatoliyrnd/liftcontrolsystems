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

  if (ticket.staff_id != null && ticket.staff_id !== "")
    ticket.staff_id = Number(ticket.staff_id) || null;
  else ticket.staff_id = null;
  if (ticket.staff_id2 != null && ticket.staff_id2 !== "")
    ticket.staff_id2 = Number(ticket.staff_id2) || null;
  else ticket.staff_id2 = null;
  if (ticket.staff_id3 != null && ticket.staff_id3 !== "")
    ticket.staff_id3 = Number(ticket.staff_id3) || null;
  else ticket.staff_id3 = null;

  ticket.notify_status = Number(ticket.notify_status) || 0;
  ticket.notify_status2 = Number(ticket.notify_status2) || 0;
  ticket.notify_status3 = Number(ticket.notify_status3) || 0;

  ticket.repair_time =
    ticket.repair_time != null && ticket.repair_time !== ""
      ? Number(ticket.repair_time) || null
      : null;

  return ticket;
}
