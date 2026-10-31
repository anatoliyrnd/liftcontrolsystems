import { tableSettings, getFreezeLeftOffset, HIDDEN_IN_MODE } from './settings.js';
import { setupResizableColumn } from './resizer.js';

/**
 * Рендерит заголовки таблицы (TH) с поддержкой липкой фиксации № и Адреса
 * Автоматически инжектирует динамический CSS для скрытия колонок на основе HIDDEN_IN_MODE
 */
export function rebuildTableHeaders(tableElement, onSortCallback, onRefreshCache) {
    let thead = tableElement.querySelector('thead');
    if (!thead) thead = tableElement.createTHead();

    thead.innerHTML = '';
    const trHead = document.createElement('tr');
    thead.appendChild(trHead);

    // Оставляем возможность менять ширину только для двух колонок (или можно убрать вообще)
    const resizableColumns = ['address', 'details'];
    const freezeLeftOffset = getFreezeLeftOffset();

    // СИНХРОНИЗАЦИЯ: Автоматическая генерация динамических CSS правил скрытия
    _syncDynamicHiddenStyles();

    tableSettings.columns.forEach((col, index) => {
        if (col.hidden || col.visible === false) return;//Пропускаем скрытые колонки, чтобы шапка совпадала с телом
        const th = document.createElement('th');
        th.textContent = col.name;
        th.setAttribute('data-id', col.id);
        th.setAttribute('data-index', index);
        th.setAttribute('data-type', col.dataType);

        // Применяем ширину
        const finalWidth = col.width || `${col.minWidth}px`;
        th.style.width = finalWidth;
        th.style.minWidth = `${col.minWidth}px`;
        th.style.maxWidth = finalWidth;

        // Липкая фиксация для Адреса по горизонтали
        if (col.id === 'address') {
            th.style.left = `${freezeLeftOffset}px`;
            th.classList.add('sticky-freeze-border');
        }

        // Обработчик сортировки
        if (col.sortable) {
            th.classList.add('sortable');
            th.addEventListener('click', () => onSortCallback(th, col.id, col.dataType));
        }

        // РЕСАЙЗЕР (изменение ширины колонки мышкой)
        if (resizableColumns.includes(col.id)) {
            const resizer = document.createElement('div');
            resizer.className = 'resizer';
            th.appendChild(resizer);
            setupResizableColumn(th, resizer);
        }

        trHead.appendChild(th);
    });
}

/**
 * Внутренний синглтон-метод генерации CSS правил скрытия на лету
 */
function _syncDynamicHiddenStyles() {
    let styleTag = document.getElementById('dynamicTableHiddenStyles');

    if (!styleTag) {
        styleTag = document.createElement('style');
        styleTag.id = 'dynamicTableHiddenStyles';
        document.head.appendChild(styleTag);
    }

    let cssRules = '';

    Object.keys(HIDDEN_IN_MODE).forEach(mode => {
        const hiddenIds = HIDDEN_IN_MODE[mode];
        if (Array.isArray(hiddenIds) && hiddenIds.length > 0) {
            hiddenIds.forEach(id => {
                cssRules += `
                    table[data-mode="${mode}"] th[data-id="${id}"],
                    table[data-mode="${mode}"] td[data-col-id="${id}"] {
                        display: none !important;
                        width: 0 !important;
                        min-width: 0 !important;
                        max-width: 0 !important;
                        padding: 0 !important;
                        margin: 0 !important;
                        border: none !important;
                    }
                `;
            });
        }
    });

    styleTag.textContent = cssRules;
}