import { tableSettings } from './settings.js';
import { parseAnyDate } from '../utils/date-utils.js';

export function sortRows(rows, columnId, isAscending) {
    const col = tableSettings.columns.find(c => c.id === columnId);
    const type = col ? col.dataType : 'string';

    rows.sort((rowA, rowB) => {
        const a = rowA.querySelector(`td[data-col-id="${columnId}"]`);
        const b = rowB.querySelector(`td[data-col-id="${columnId}"]`);
        const va = a ? a.textContent.trim() : '';
        const vb = b ? b.textContent.trim() : '';

        if (type === 'number') {
            const na = parseFloat(va || 0), nb = parseFloat(vb || 0);
            return isAscending ? na - nb : nb - na;
        }
        if (type === 'date') {
            // Теперь в ячейке лежит отформатированная строка, парсим её обратно в Date
            const da = parseAnyDate(va)?.getTime() || 0;
            const db = parseAnyDate(vb)?.getTime() || 0;
            return isAscending ? da - db : db - da;
        }
        return isAscending ? va.localeCompare(vb, 'ru') : vb.localeCompare(va, 'ru');
    });
}