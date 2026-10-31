import { formatTs, parseAnyDate, toTs, nowTs, getDefaultRepairTs } from '../utils/date-utils.js';

// Твой буфер для исключения дребезга
const MIN_AHEAD_MS = 25 * 60 * 1000;

function pad(n) { return String(n).padStart(2, '0'); }

function formatDateInput(d) {
    return d.getFullYear() + '-' + pad(d.getMonth() + 1) + '-' + pad(d.getDate());
}

function formatTimeInput(d) {
    return pad(d.getHours()) + ':' + pad(d.getMinutes());
}

export function createRepairTimePicker(opts = {}) {
    const {
        initialValue = null,
        onChange = () => {},
        serverOffsetMs = 0
    } = opts;

    let currentValue = null;
    let _hasError = false;

    const initDate = parseAnyDate(initialValue);
    if (initDate) {
        currentValue = toTs(initDate);
    } else {
        currentValue = getDefaultRepairTs();
    }

    function now() {
        return new Date(Date.now() + serverOffsetMs);
    }

    function getMinAllowedTs() {
        return nowTs() + Math.floor(MIN_AHEAD_MS / 1000);
    }

    const wrap = document.createElement('div');
    wrap.style.cssText = 'display: flex; flex-direction: column; gap: 6px;';

    const display = document.createElement('div');
    display.className = 'editable-field';
    display.style.cssText = 'font-size: 13px; padding: 6px 10px; border-radius: 6px; border: 1px solid var(--border-color); background: var(--bg-primary); min-height: 32px; display: flex; align-items: center; font-weight: 600;';
    display.textContent = formatTs(currentValue);

    const select = document.createElement('select');
    select.className = 'search-input editable-field';
    select.style.cssText = 'font-size: 13px; padding: 6px 8px; cursor: pointer;';

    [
        { value: '',         text: '— выбрать срок —' },
        { value: '30min',    text: '30 минут' },
        { value: '1hour',    text: '1 час' },
        { value: 'endday',   text: 'До 17:00' },
        { value: 'custom',   text: 'Другая дата...' }
    ].forEach(o => {
        const opt = document.createElement('option');
        opt.value = o.value;
        opt.textContent = o.text;
        select.appendChild(opt);
    });

    const customWrap = document.createElement('div');
    customWrap.style.cssText = 'display: none; gap: 6px; align-items: center;';

    const dateInput = document.createElement('input');
    dateInput.type = 'date';
    dateInput.className = 'search-input editable-field';
    dateInput.style.cssText = 'font-size: 13px; padding: 6px 8px; flex: 1;';
    dateInput.min = formatDateInput(new Date(getMinAllowedTs() * 1000));

    const timeInput = document.createElement('input');
    timeInput.type = 'time';
    timeInput.className = 'search-input editable-field';
    timeInput.style.cssText = 'font-size: 13px; padding: 6px 8px; width: 120px;';
    timeInput.step = 1800;

    const initialMin = new Date(getMinAllowedTs() * 1000);
    dateInput.value = formatDateInput(initialMin);
    timeInput.value = formatTimeInput(initialMin);

    customWrap.appendChild(dateInput);
    customWrap.appendChild(timeInput);

    const warn = document.createElement('div');
    warn.style.cssText = 'display: none; color: #ef4444; font-size: 12px; margin-top: 2px;';

    function showError(message) {
        _hasError = true;
        warn.textContent = '⚠️ ' + message;
        warn.style.display = 'block';
    }

    function clearError() {
        _hasError = false;
        warn.style.display = 'none';
    }

    function isTsValid(ts) {
        if (!ts || isNaN(ts)) return false;
        return ts >= getMinAllowedTs();
    }

    function syncTimeMin() {
        const minTs = getMinAllowedTs();
        const minDateStr = formatDateInput(new Date(minTs * 1000));
        const selected = dateInput.value;

        if (selected === minDateStr) {
            const minTime = formatTimeInput(new Date(minTs * 1000));
            timeInput.min = minTime;
            if (timeInput.value && timeInput.value < minTime) {
                timeInput.value = minTime;
            }
        } else {
            timeInput.min = '00:00';
        }
    }

    function applyTs(ts) {
        if (!isTsValid(ts)) {
            showError('Выбранное время меньше допустимого (не менее 25 минут от текущего момента).');
            currentValue = getDefaultRepairTs();
            display.textContent = formatTs(currentValue);
            onChange(currentValue);
            return;
        }
        clearError();
        currentValue = ts;
        display.textContent = formatTs(currentValue);
        onChange(currentValue);
    }

    function applyPreset(preset) {
        if (!preset) return;
        const nTs = nowTs();
        let targetTs = null;

        if (preset === '30min') {
            targetTs = nTs + 30 * 60;
        } else if (preset === '1hour') {
            targetTs = nTs + 60 * 60;
        } else if (preset === 'endday') {
            // Теперь эта функция сама вернет "завтра", если время >= 16:00
            targetTs = getDefaultRepairTs();
        }

        if (targetTs) {
            applyTs(targetTs);
        }
    }

    function applyCustom() {
        syncTimeMin();
        const d = dateInput.value;
        const t = timeInput.value;
        if (!d || !t) return;

        const [y, m, day] = d.split('-').map(Number);
        const [hh, mm] = t.split(':').map(Number);
        const targetDate = new Date(y, m - 1, day, hh, mm, 0, 0);
        const targetTs = toTs(targetDate);

        applyTs(targetTs);
    }

    select.onchange = () => {
        if (select.value === 'custom') {
            customWrap.style.display = 'flex';
            syncTimeMin();
            applyCustom();
        } else {
            customWrap.style.display = 'none';
            clearError();
            applyPreset(select.value);
        }
    };

    dateInput.onchange = () => {
        syncTimeMin();
        applyCustom();
    };
    timeInput.onchange = applyCustom;

    wrap.appendChild(display);
    wrap.appendChild(select);
    wrap.appendChild(customWrap);
    wrap.appendChild(warn);

    return {
        element: wrap,
        getValue: () => currentValue,
        getTimestamp: () => currentValue,
        setValue: (val) => {
            const parsed = parseAnyDate(val);
            currentValue = parsed ? toTs(parsed) : getDefaultRepairTs();
            display.textContent = formatTs(currentValue);
            select.value = '';
            customWrap.style.display = 'none';
            clearError();
        },
        isValid: () => !_hasError,
        reset: () => {
            const initDate = parseAnyDate(initialValue);
            currentValue = initDate ? toTs(initDate) : getDefaultRepairTs();
            display.textContent = formatTs(currentValue);
            select.value = '';
            customWrap.style.display = 'none';
            clearError();

            const freshMin = new Date(getMinAllowedTs() * 1000);
            dateInput.value = formatDateInput(freshMin);
            timeInput.value = formatTimeInput(freshMin);
        },
        destroy: () => {
            select.onchange = null;
            dateInput.onchange = null;
            timeInput.onchange = null;
        }
    };
}