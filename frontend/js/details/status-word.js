/**
 * Человекочитаемый статус уведомления ответственного.
 *
 * Используется:
 *   - details-controller (закрытые заявки: «• Иванов (по телефону)»);
 *   - staff-slots-view (Шаг 4, будет импортировать отсюда).
 *
 * NOTIFY_CHANNELS в config — единственный источник правды.
 * Функция чистая: код → строка, без сайд-эффектов.
 */
import { BUSINESS } from "../config.js";

const NOTIFY_CHANNELS = BUSINESS.NOTIFY_CHANNELS;

/**
 * @param {number|string|null|undefined} status — notify_status (0..7)
 * @returns {string} например "по телефону", "web онлайн", "не уведомлен"
 */
export function getStatusWord(status) {
  if (!status) return "не уведомлен";
  const ch = NOTIFY_CHANNELS[status];
  if (!ch) return "не уведомлен";
  return ch
    .replace(/[^\wа-яё\s]/gi, "")
    .trim()
    .toLowerCase();
}
