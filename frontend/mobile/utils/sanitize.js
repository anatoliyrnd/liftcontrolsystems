/**
 * Утилиты безопасной вставки пользовательских данных в HTML.
 * Все поля с сервера (address, details, solution, user, body) ДОЛЖНЫ
 * проходить через escapeHtml перед innerHTML.
 *
 * safeUrl используется отдельно — для значений атрибутов src/href.
 */

const HTML_ESCAPES = {
  "&": "&amp;",
  "<": "&lt;",
  ">": "&gt;",
  '"': "&quot;",
  "'": "&#39;",
};

export function escapeHtml(value) {
  if (value === null || value === undefined) return "";
  return String(value).replace(/[&<>"']/g, (ch) => HTML_ESCAPES[ch]);
}

/**
 * Проверка URL перед вставкой в src/href.
 * Разрешаем: https: (внешние), blob:/data: (локальные превью).
 * Возвращает нормализованный href или null.
 */
export function safeUrl(rawUrl) {
  if (!rawUrl || typeof rawUrl !== "string") return null;
  try {
    const url = new URL(rawUrl, window.location.origin);
    if (url.protocol === "https:" && url.host) return url.href;
    if (url.protocol === "blob:" || url.protocol === "data:") return url.href;
    return null;
  } catch (e) {
    return null;
  }
}
