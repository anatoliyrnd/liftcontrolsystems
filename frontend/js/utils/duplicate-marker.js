/**
 * Пометка о подтверждённом дубликате.
 *
 * Сервер пишет аудит в lift_history (API_PROTOCOL §7.3), но full_history
 * в карточке показывается только администратору — диспетчер и механик
 * пометку не увидят. Поэтому дубликат отмечается комментарием к НОВОЙ
 * заявке: виден всем, имеет автора и дату, не засоряет описание проблемы.
 *
 * Один источник текста для двух путей: онлайн-форма (callnote) и
 * подтверждение из очереди (payload.comments создаваемой заявки).
 */
import { formatTs, nowTs } from "./date-utils.js";

export const OFFLINE_COMMENTS_HEADER = "⏳ [Офлайн-комментарии]";

/** Номера из duplicate_detected → «№35732, №35740». */
export function formatDuplicateNumbers(existingTickets) {
  const list = Array.isArray(existingTickets) ? existingTickets : [];
  const numbers = list
    .map((t) => t?.ticket_id ?? t?.call_id ?? t?.id ?? null)
    .filter((n) => n != null && n !== "")
    .map((n) => String(n));
  const unique = [...new Set(numbers)];
  return unique.length ? "№" + unique.join(", №") : "номер не определён";
}

/** Текст комментария-пометки. Заведомо длиннее минимума callnote (6). */
export function buildDuplicateNoteText(existingTickets) {
  return (
    `⚠️ Возможный дубликат к заявке ${formatDuplicateNumbers(existingTickets)}. ` +
    `Создание подтверждено диспетчером вручную.`
  );
}

/** Строка в формате payload.comments (API_syncCommands §9.2). */
export function buildDuplicateCommentLine(existingTickets, authorName) {
  const dateStr = formatTs(nowTs()).replace("@", " ");
  return `[${authorName || "Сотрудник"}, ${dateStr}]: ${buildDuplicateNoteText(existingTickets)}`;
}

/** Дописывание строки в payload.comments, заголовок — при первом комментарии. */
export function appendOfflineComment(comments, line) {
  return comments
    ? comments + "\n" + line
    : `${OFFLINE_COMMENTS_HEADER}\n${line}`;
}
