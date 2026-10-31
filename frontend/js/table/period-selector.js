const PERIODS = [
    { value: '1', text: '24 часа' },
    { value: '2', text: '2 дня' },
    { value: '3', text: '3 дня' },
    { value: '7', text: '7 дней' }
];

/**
 * Рендерит выпадающий селектор периода для закрытых заявок.
 * @param {HTMLElement} container — контейнер для инжекта (periodSelectorContainer)
 * @param {string} selectedDays — сохранённое значение ('1', '2', '3', '7')
 * @param {(value: string) => void} onChange — колбэк при смене периода
 */
export function renderPeriodSelector(container, selectedDays, onChange) {
    if (!container) return;
    container.innerHTML = '';

    const select = document.createElement('select');
    select.className = 'search-input';
    select.style.cssText = 'padding: 0.75rem; font-size: 0.9rem; border-radius: 8px; background-color: var(--bg-secondary); border: 2px solid var(--border-color); color: var(--text-primary); cursor: pointer; max-width: 140px;';

    PERIODS.forEach(p => {
        const opt = document.createElement('option');
        opt.value = p.value;
        opt.textContent = p.text;
        if (p.value === selectedDays) opt.selected = true;
        select.appendChild(opt);
    });

    select.addEventListener('change', e => onChange(e.target.value));
    container.appendChild(select);
}