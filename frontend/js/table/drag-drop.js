import { tableSettings } from './settings.js';
import { rebuildTableHeaders } from './header-render.js';

/**
 * Инициализация событий Drag-and-Drop с поддержкой Firefox и динамических CSS-колонок
 */
export function setupDragAndDrop(th, tableElement, onSortCallback, onRefreshCache) {

    // 1. НАЧАЛО ПЕРЕТАСКИВАНИЯ МЫШЬЮ
    th.addEventListener('dragstart', (e) => {
        const draggedColumnID = th.getAttribute('data-id');
        e.dataTransfer.effectAllowed = 'move';
        e.dataTransfer.setData('text/plain', draggedColumnID); // Фикс Firefox + передача ID

        // Обернули в setTimeout, чтобы "призрак" под курсором не стал прозрачным,
        // но сама колонка в таблице получила z-index: 9999 и opacity из style.css
        setTimeout(() => {
            th.classList.add('dragging-active');
        }, 0);
    });

    // 2. ДВИЖЕНИЕ КОЛОНКИ НАД ДРУГИМИ ЭЛЕМЕНТАМИ (dragover)
    th.addEventListener('dragover', (e) => {
        e.preventDefault();
        e.dataTransfer.dropEffect = 'move'; // Явно указываем тип операции
    });

    // 3. КОНЕЦ ПЕРЕТАСКИВАНИЯ (Отмена или завершение переноса)
    th.addEventListener('dragend', (e) => {
        e.preventDefault();

        // Гарантированно удаляем класс активности Stacking Context
        th.classList.remove('dragging-active');

        // Очищаем маркеры подсветки краев у всех остальных колонок таблицы
        tableElement.querySelectorAll('th').forEach(el => {
            el.classList.remove('drag-over-left', 'drag-over-right');
        });
    });

    // 4. ФИЗИЧЕСКИЙ СБРОС (Drop) КОЛОНКИ НА НОВОЕ МЕСТО
    th.addEventListener('drop', (e) => {
        e.preventDefault();
        const targetColumnID = th.getAttribute('data-id');
        const draggedColumnID = e.dataTransfer.getData('text/plain'); // Читаем сохраненный ID из буфера

        if (!targetColumnID || !draggedColumnID || draggedColumnID === targetColumnID) return;

        const draggedIdx = tableSettings.columns.findIndex(c => c.id === draggedColumnID);
        const targetIdx = tableSettings.columns.findIndex(c => c.id === targetColumnID);

        if (draggedIdx === -1 || targetIdx === -1) return;
        if (!tableSettings.columns[draggedIdx].movable || !tableSettings.columns[targetIdx].movable) return;

        // Перестраиваем порядок колонок внутри конфигурационного массива в ОЗУ
        // Удаляем перетаскиваемую колонку из её старого места
        const [removed] = tableSettings.columns.splice(draggedIdx, 1);

        // ИСПРАВЛЕНО: Корректируем индекс вставки, если перемещение шло слева направо (вправо)
        const adjustedTarget = draggedIdx < targetIdx ? targetIdx - 1 : targetIdx;

        // Вставляем элемент строго на выверенную позицию
        tableSettings.columns.splice(adjustedTarget, 0, removed);
        // Сохраняем свежий сквозной порядок полей в памяти браузера
        localStorage.setItem('tableColumnOrder', tableSettings.columns.map(c => c.id).join(','));

        // Перерисовываем заголовки шапки таблицы (TH) заново
        rebuildTableHeaders(tableElement, onSortCallback, onRefreshCache);

        // СИНХРОНИЗАЦИЯ СТРОК TD: Перестраиваем порядок ячеек физически в DOM дереве
        const rows = tableElement.querySelectorAll('tbody tr');
        rows.forEach(row => {
            const fragment = document.createDocumentFragment();

            tableSettings.columns.forEach(col => {
                const td = row.querySelector(`td[data-col-id="${col.id}"]`);
                if (td) {
                    // Все ячейки (включая скрытые) переносятся во фрагмент "как есть".
                    // Скрытием управляет CSS-правило таблицы [data-mode="open"] в style.css
                    fragment.appendChild(td);
                }
            });

            // Навешиваем упорядоченный фрагмент ячеек обратно в строку tr
            row.appendChild(fragment);
        });

        // Запускаем триггер обновления кэша полнотекстового поиска
        if (onRefreshCache) onRefreshCache();
    });
}
