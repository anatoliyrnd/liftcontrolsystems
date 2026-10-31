import { tableSettings } from './settings.js';

/**
 * Логика изменения ширины колонок мышью с учётом minWidth.
 * Корректно завершает ресайз, если mouseup произошёл за пределами окна
 * (через window.blur) или если пользователь ушёл на другую вкладку.
 */
export function setupResizableColumn(th, resizer) {
    let startX, startWidth;
    let cachedCells = null;
    let cachedAddressCells = null;
    const colId = th.getAttribute('data-id');

    const colConfig = tableSettings.columns.find(c => c.id === colId);
    const minAllowedWidth = colConfig ? colConfig.minWidth : 90;

    function onMouseMove(e) {
        const width = startWidth + (e.clientX - startX);

        if (width >= minAllowedWidth) {
            const widthPx = `${width}px`;

            th.style.width = widthPx;
            th.style.maxWidth = widthPx;

           // Кэш заполняется в mousedown — querySelectorAll больше не на каждом кадре.
const cells = cachedCells || th.closest('table')?.querySelectorAll(`tbody td[data-col-id="${colId}"]`);
if (cells) {
    cells.forEach(td => {
        td.style.width = widthPx;
        td.style.maxWidth = widthPx;
    });
}

if (colId === 'id') {
    const addrCells = cachedAddressCells
        || th.closest('table')?.querySelectorAll(`th[data-id="address"], td[data-col-id="address"]`);
    if (addrCells) {
        addrCells.forEach(el => { el.style.left = widthPx; });
    }
}
            if (colConfig) colConfig.width = widthPx;
        }
    }

    function onMouseUp() {
        // Защита от повторного вызова (mouseup + blur одновременно)
        if (!resizer.classList.contains('resizing')) return;

        const currentWidths = JSON.parse(localStorage.getItem('tableColumnWidths') || '{}');
        if (colConfig && colConfig.width) {
            currentWidths[colId] = colConfig.width;
            localStorage.setItem('tableColumnWidths', JSON.stringify(currentWidths));
        }

        if (colConfig && colConfig.movable) {
            th.setAttribute('draggable', 'true');
        }

       resizer.classList.remove('resizing');
document.removeEventListener('mousemove', onMouseMove);
document.removeEventListener('mouseup', onMouseUp);
window.removeEventListener('blur', onMouseUp);
document.removeEventListener('visibilitychange', onVisibilityChange);

// Освобождаем NodeList
cachedCells = null;
cachedAddressCells = null;
    }

    function onVisibilityChange() {
        // Если вкладка ушла в фон во время ресайза — принудительно завершаем
        if (document.visibilityState === 'hidden') onMouseUp();
    }

    resizer.addEventListener('mousedown', (e) => {
        e.stopPropagation();
        e.preventDefault();

        th.setAttribute('draggable', 'false');
        resizer.classList.add('resizing');

        startX = e.clientX;
        startWidth = th.offsetWidth;

      // ОДИН раз на drag собираем NodeList — дальше onMouseMove только читает.
const table = th.closest('table');
if (table) {
    cachedCells = table.querySelectorAll(`tbody td[data-col-id="${colId}"]`);
    cachedAddressCells = (colId === 'id')
        ? table.querySelectorAll(`th[data-id="address"], td[data-col-id="address"]`)
        : null;
}

document.addEventListener('mousemove', onMouseMove);
document.addEventListener('mouseup', onMouseUp);
window.addEventListener('blur', onMouseUp);
document.addEventListener('visibilitychange', onVisibilityChange);
    });
}