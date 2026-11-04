/**
 * Рендер блока «История» карточки заявки.
 *
 * На этом шаге (1.3) здесь только formatFullHistory — чистая функция
 * разбора HTML из поля full_history. На Шаге 4 сюда же переедет
 * renderHistoryView(...), поэтому файл назван history-view.js,
 * а не format-full-history.js — один переезд вместо двух.
 */
import { formatTs } from "../utils/date-utils.js";
import { escapeHtml } from "../utils/escape-html.js";

/**
 * Рендер full_history как plain text (вариант C из Q13).
 *
 * Блочные теги → \n ДО парсинга, потом textContent → escapeHtml.
 * DOMParser в detached document безопасен: скрипты не выполняются,
 * onerror не срабатывает. escapeHtml обязателен, потому что
 * textContent вернёт `&lt;script&gt;` как `<script>` — без escape
 * это снова стало бы тегом при вставке через innerHTML.
 *
 * Память: doc — локальная переменная, после textContent уходит
 * в GC. Узлы парсера не удерживаются в замыканиях.
 *
 * @param {string|null|undefined} rawHtml
 * @returns {string} безопасная для innerHTML строка
 */
export function formatFullHistory(rawHtml) {
  if (!rawHtml) return "";

  const withBreaks = String(rawHtml)
    .replace(/<br\s*\/?>/gi, "\n")
    .replace(/<\/(p|div|li|tr|h[1-6]|blockquote|td|th)>/gi, "\n");

  const doc = new DOMParser().parseFromString(withBreaks, "text/html");
  let text = doc.body.textContent || "";

  // Заменяем только 10-значные числа в диапазоне реальных дат
  // (2001-09-09 … 2033-05-18). Иначе телефоны/артикулы 10 цифр
  // превращаются в «даты».
  text = text.replace(/\b(\d{10})\b/g, (match) => {
    const ts = Number(match);
    if (ts < 1_000_000_000 || ts >= 2_000_000_000) return match;
    return formatTs(match);
  });
  text = text.replace(/\n{3,}/g, "\n\n").trim();

  return escapeHtml(text);
}
