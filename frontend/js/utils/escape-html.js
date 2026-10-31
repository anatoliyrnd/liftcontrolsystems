/**
 * Экранирование HTML-спецсимволов для безопасной вставки в innerHTML.
 * Null/undefined превращаются в пустую строку.
 *
 * @param {*} value — любое значение (приводится к строке)
 * @returns {string}
 */
export function escapeHtml(value) {
    if (value === null || value === undefined) return '';
    return String(value).replace(/[&<>"']/g, ch => ({
        '&': '&amp;',
        '<': '&lt;',
        '>': '&gt;',
        '"': '&quot;',
        "'": '&#39;'
    }[ch]));
}