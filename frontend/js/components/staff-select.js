/**
 * Компонент выбора механика с поиском.
 * Совмещает input поиска и выпадающий список отфильтрованных сотрудников.
 *
 * Использование:
 *   const picker = createStaffSelect({
 *       list: staffStore.list,
 *       excludeIds: [1, 5],       // кого не показывать (заняты в других слотах)
 *       selectedId: 3,            // предвыбранный
 *       placeholder: 'Начните вводить имя...',
 *       onSelect: (staff) => { ... }  // staff = {id, name} или null
 *   });
 *   container.appendChild(picker.element);
 *   const id = picker.getValue();
 *
 * @param {Object} opts
 * @param {Array<{id, name}>} opts.list
 * @param {Array<number|string>} [opts.excludeIds]
 * @param {number|string|null} [opts.selectedId]
 * @param {string} [opts.placeholder]
 * @param {(staff: {id,name}|null) => void} [opts.onSelect]
 */
export function createStaffSelect(opts = {}) {
    const {
        list = [],
        excludeIds = [],
        selectedId = null,
        placeholder = '— выберите механика —',
        onSelect = () => {}
    } = opts;

    const wrap = document.createElement('div');
    wrap.className = 'staff-select-wrap';
    wrap.style.cssText = 'position: relative; width: 100%;';

    const input = document.createElement('input');
    input.type = 'text';
    input.className = 'search-input editable-field';
    input.placeholder = placeholder;
    input.autocomplete = 'off';
    input.style.cssText = 'width: 100%; font-size: 13px; padding: 6px 8px;';

    const dropdown = document.createElement('div');
    dropdown.className = 'staff-select-dropdown';
    dropdown.style.cssText = 'display: none; position: absolute; top: 100%; left: 0; right: 0; z-index: 100; max-height: 200px; overflow-y: auto; border: 1px solid var(--border-color); border-radius: 6px; background: var(--bg-secondary); box-shadow: 0 4px 10px rgba(0,0,0,0.15); margin-top: 2px;';

    wrap.appendChild(input);
    wrap.appendChild(dropdown);

    let currentId = selectedId;
    const excludedSet = new Set(excludeIds.map(String));

    function filteredItems(query) {
        const q = String(query || '').trim().toLowerCase();
        return list.filter(s => {
            if (excludedSet.has(String(s.id))) return false;
            if (!q) return true;
            return String(s.name).toLowerCase().includes(q);
        });
    }

    function renderDropdown(query) {
        dropdown.innerHTML = '';
        const items = filteredItems(query);

        if (items.length === 0) {
            const empty = document.createElement('div');
            empty.style.cssText = 'padding: 8px 10px; font-size: 12px; color: var(--text-secondary); font-style: italic;';
            empty.textContent = 'Ничего не найдено';
            dropdown.appendChild(empty);
            return;
        }

        items.forEach(staff => {
            const item = document.createElement('div');
            item.className = 'staff-select-item';
            item.dataset.id = staff.id;
            item.style.cssText = 'padding: 8px 10px; font-size: 13px; cursor: pointer; border-bottom: 1px solid var(--border-color);';
            if (String(staff.id) === String(currentId)) {
                item.style.background = 'var(--table-row-hover)';
                item.style.fontWeight = '600';
            }
            item.textContent = staff.name;
            item.onmouseenter = () => { item.style.background = 'var(--table-row-hover)'; };
            item.onmouseleave = () => {
                if (String(staff.id) !== String(currentId)) item.style.background = '';
            };
            item.onclick = () => {
                currentId = staff.id;
                input.value = staff.name;
                closeDropdown();
                onSelect({ id: staff.id, name: staff.name });
            };
            dropdown.appendChild(item);
        });
    }

    function openDropdown() {
        renderDropdown(input.value);
        dropdown.style.display = 'block';
    }

    function closeDropdown() {
        dropdown.style.display = 'none';
    }

    // Предвыбор
    if (currentId != null) {
        const found = list.find(s => String(s.id) === String(currentId));
        if (found) input.value = found.name;
    }

    input.addEventListener('focus', openDropdown);
    // При потере фокуса — если выбор был, вернуть имя в поле.
    // Если пользователь стёр текст — восстановим имя сохранённого выбора.
    input.addEventListener('blur', () => {
        setTimeout(() => {
            if (currentId != null) {
                const selectedStaff = list.find(s => String(s.id) === String(currentId));
                if (selectedStaff) {
                    input.value = selectedStaff.name;
                }
            }
        }, 150); // даём клику по опции сработать раньше, чем вернём имя
    });
    input.addEventListener('input', () => {
        const typed = input.value.trim();

        if (currentId != null) {
            // Ищем механика, чьё имя соответствует введённому тексту
            const selectedStaff = list.find(s => String(s.id) === String(currentId));
            const selectedName = selectedStaff ? selectedStaff.name : '';

            // Сбрасываем выбор только если:
            //  а) поле пустое, ИЛИ
            //  б) введённый текст не совпадает с именем выбранного механика
            //     (без учёта лишних пробелов)
            const typedMatchesSelected = typed !== '' &&
                typed.toLowerCase() === selectedName.toLowerCase();

            if (!typedMatchesSelected) {
                currentId = null;
                onSelect(null);
            }
        }

        openDropdown();
    });

    // Закрытие по клику вне
    function onDocClick(e) {
        if (!wrap.contains(e.target)) closeDropdown();
    }
    document.addEventListener('click', onDocClick);

    return {
        element: wrap,
        getValue: () => currentId,
        setValue: (id) => {
            currentId = id;
            const found = list.find(s => String(s.id) === String(id));
            input.value = found ? found.name : '';
        },
        isValid: () => currentId != null,
        reset: () => {
            currentId = null;
            input.value = '';
            closeDropdown();
        },
        destroy: () => {
            document.removeEventListener('click', onDocClick);
        },
        focus: () => input.focus()
    };
}