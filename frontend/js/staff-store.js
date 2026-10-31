/**
 * Глобальное хранилище справочника электромехаников.
 * Заполняется один раз при инициализации SPA из ответа config.
 * Используется формами создания и редактирования заявки.
 */
export const staffStore = {
    list: [],

    /**
     * Сохранить список, полученный от сервера.
     * Валидация: массив объектов с полями id и name.
     */
    setList(arr) {
        if (!Array.isArray(arr)) {
            this.list = [];
            return;
        }
        this.list = arr
            .filter(s => s && s.id !== undefined && s.name)
            .map(s => ({
                id: s.id,
                name: String(s.name),
                phone: s.phone ? String(s.phone).trim() : null
            }));
    },

    /**
     * Получить механика по id (устойчиво к числу и строке).
     */
    getById(id) {
        return this.list.find(s => String(s.id) === String(id)) || null;
    },

    /**
     * Телефон механика по id. Если не задан — null.
     */
    getPhone(id) {
        const staff = this.getById(id);
        return staff && staff.phone ? staff.phone : null;
    },
    /**
     * Наполнить <select> опциями из справочника.
     * Добавляет первую опцию-плейсхолдер.
     * @param {HTMLSelectElement} selectEl
     * @param {string} placeholder — текст первой опции
     * @param {string|number|null} selectedId — что предвыбрать (опционально)
     */
    fillSelect(selectEl, placeholder = '— не назначен —', selectedId = null) {
        if (!selectEl) return;
        selectEl.innerHTML = '';

        const placeholderOpt = document.createElement('option');
        placeholderOpt.value = '';
        placeholderOpt.textContent = placeholder;
        selectEl.appendChild(placeholderOpt);

        this.list.forEach(staff => {
            const opt = document.createElement('option');
            opt.value = staff.id;
            opt.textContent = staff.name;
            if (selectedId !== null && String(staff.id) === String(selectedId)) {
                opt.selected = true;
            }
            selectEl.appendChild(opt);
        });
    }
};