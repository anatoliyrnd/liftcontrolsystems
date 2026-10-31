import { tableSettings, HIDDEN_IN_MODE } from './settings.js';

/** Колонки, по которым реально ищет полнотекстовый поиск */
export const ALLOWED_SEARCH_COLUMNS = ['id', 'address', 'staff'];

/**
 * Собирает слепок строк таблицы в памяти для моментального поиска.
 * Учитывает скрытые CSS-колонки (HIDDEN_IN_MODE) и конфиг col.hidden.
 * @param {HTMLTableElement} dataTable
 * @returns {Array<{element: HTMLTableRowElement, searchCells: Array, allCells: Array}>}
 */
export function buildRowsCache(dataTable) {
    const rowsCache = [];
    if (!dataTable) return rowsCache;

    const mode = dataTable.getAttribute('data-mode') || 'open';
    const hidden = HIDDEN_IN_MODE[mode] || [];

    dataTable.querySelectorAll('tbody tr').forEach(row => {
        const searchCells = [];
        const allCells = [];

        tableSettings.columns.forEach(col => {
            if (hidden.includes(col.id) || col.hidden) return;

            const td = row.querySelector(`td[data-col-id="${col.id}"]`);
            if (!td) return;

            allCells.push({ element: td, text: td.textContent });

            if (ALLOWED_SEARCH_COLUMNS.includes(col.id)) {
                searchCells.push({ element: td, text: td.textContent });
            }
        });

        rowsCache.push({ element: row, searchCells, allCells });
    });

    return rowsCache;
}

/**
 * Безопасная полнотекстовая фильтрация через текстовые ноды.
 * Защита от XSS и тяжёлого Reflow/Layout браузера.
 * @param {Array} rowsCache — результат buildRowsCache
 * @param {string} filter — поисковый запрос в нижнем регистре
 */
export function applyFilter(rowsCache, filter) {
    rowsCache.forEach(cacheItem => {
        const hasMatch = cacheItem.searchCells.some(
            item => item.text.toLowerCase().includes(filter)
        );
        cacheItem.element.style.display = (hasMatch || !filter) ? '' : 'none';

        // Сброс: возвращаем чистый текст без разметки
        cacheItem.allCells.forEach(item => {
            item.element.textContent = item.text;
        });

        if (!filter || !hasMatch) return;

        // Подсветка совпадений через DocumentFragment (без innerHTML)
        cacheItem.searchCells.forEach(item => {
            if (!item.text.toLowerCase().includes(filter)) return;

            const lower = item.text.toLowerCase();
            const frag = document.createDocumentFragment();
            let pos = 0, idx;

            while ((idx = lower.indexOf(filter, pos)) !== -1) {
                if (idx > pos) {
                    frag.appendChild(document.createTextNode(item.text.slice(pos, idx)));
                }
                const mark = document.createElement('mark');
                mark.textContent = item.text.slice(idx, idx + filter.length);
                frag.appendChild(mark);
                pos = idx + filter.length;
            }

            if (pos < item.text.length) {
                frag.appendChild(document.createTextNode(item.text.slice(pos)));
            }

            item.element.textContent = '';
            item.element.appendChild(frag);
        });
    });
}