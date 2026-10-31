import { dictStore } from '../dict-store.js';

/**
 * Обёртка над <select> для справочников department / request / group.
 * Наполняется из dictStore, поддерживает placeholder, обязательность,
 * режим «только для чтения» (disabled).
 */
export function createDictSelect(opts = {}) {
    const {
        key,
        placeholder = '— не выбрано —',
        initialValue = null,
        required = true,
        onChange = () => {}
    } = opts;

    if (!['department', 'request', 'group'].includes(key)) {
        throw new Error('dict-select: неверный ключ справочника: ' + key);
    }

    const select = document.createElement('select');
    select.className = 'search-input editable-field';
    select.style.cssText = 'width: 100%; font-size: 13px; padding: 6px 8px; cursor: pointer;';

    let currentValue = initialValue != null ? String(initialValue) : '';
    let isDisabled = false;

    function fill() {
        select.innerHTML = '';

        const placeholderOpt = document.createElement('option');
        placeholderOpt.value = '';
        placeholderOpt.textContent = placeholder;
        select.appendChild(placeholderOpt);

        (dictStore[key] || []).forEach(item => {
            const opt = document.createElement('option');
            opt.value = item.id;
            opt.textContent = item.name;
            if (String(item.id) === currentValue) opt.selected = true;
            select.appendChild(opt);
        });

        select.value = currentValue;
    }

    fill();

    function isValid() {
        if (!required) return true;
        return select.value !== '';
    }

    function emit() {
        onChange(select.value || null, isValid());
    }

    select.onchange = () => {
        currentValue = select.value;
        emit();
    };

    return {
        element: select,

        getValue: () => select.value || null,

        // ИСПРАВЛЕНО: Добавлен emit() для уведомления родителя
        setValue: (v) => {
            currentValue = v != null ? String(v) : '';
            fill();
            emit();
        },

        isValid,

        isDisabled: () => isDisabled,

        setDisabled: (disabled) => {
            isDisabled = !!disabled;
            select.disabled = isDisabled;
            select.style.opacity = isDisabled ? '0.6' : '1';
            select.style.cursor = isDisabled ? 'not-allowed' : 'pointer';
        },

        reset: () => {
            currentValue = initialValue != null ? String(initialValue) : '';
            fill();
            emit();
        },

        destroy: () => {
            select.onchange = null;
        }
    };
}