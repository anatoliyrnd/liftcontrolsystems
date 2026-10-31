/**
 * Глобальное хранилище справочников отдел / запрос / группа.
 * Заполняется один раз при инициализации SPA из ответа config.
 *
 * На вход идёт ассоциативный объект { "22": "1.Электромеханики", ... }.
 * Внутри храним массив [{ id: "22", name: "1.Электромеханики" }, ...] —
 * чтобы сохранять порядок и удобно итерировать.
 */
export const dictStore = {
    department: [],
    request: [],
    group: [],

    /**
     * Сохранить справочник. Принимает как объект {id:name}, так и массив.
     * @param {'department'|'request'|'group'} key
     * @param {Object|Array} raw
     */
    set(key, raw) {
        if (!['department', 'request', 'group'].includes(key)) return;
        this[key] = this._normalize(raw);
    },

    /** Внутренний нормализатор. */
    _normalize(raw) {
        if (!raw) return [];
        if (Array.isArray(raw)) {
            return raw
                .filter(item => item && item.id !== undefined && item.name)
                .map(item => ({ id: String(item.id), name: String(item.name) }));
        }
        if (typeof raw === 'object') {
            return Object.entries(raw).map(([id, name]) => ({
                id: String(id),
                name: String(name)
            }));
        }
        return [];
    },

    /** Найти имя по id. */
    getName(key, id) {
        if (!this[key]) return null;
        const found = this[key].find(item => item.id === String(id));
        return found ? found.name : null;
    },

    /**
     * Наполнить <select> опциями из справочника.
     * @param {HTMLSelectElement} selectEl
     * @param {'department'|'request'|'group'} key
     * @param {string} placeholder
     * @param {string|number|null} selectedId
     */
    fillSelect(selectEl, key, placeholder = '— не выбрано —', selectedId = null) {
        if (!selectEl) return;
        selectEl.innerHTML = '';

        const placeholderOpt = document.createElement('option');
        placeholderOpt.value = '';
        placeholderOpt.textContent = placeholder;
        selectEl.appendChild(placeholderOpt);

        (this[key] || []).forEach(item => {
            const opt = document.createElement('option');
            opt.value = item.id;
            opt.textContent = item.name;
            if (selectedId !== null && String(item.id) === String(selectedId)) {
                opt.selected = true;
            }
            selectEl.appendChild(opt);
        });
    }
};