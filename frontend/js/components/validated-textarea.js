/**
 * Универсальный textarea с валидацией длины и заглавных букв.
 *
 * Использование:
 *   const field = createValidatedTextarea({
 *       placeholder: 'Введите комментарий...',
 *       rows: 3,
 *       minLength: 1,
 *       voice: true,
 *       onChange: (value, isValid) => { ... }
 *   });
 *   container.appendChild(field.element);
 *   const text = field.getValue();
 *   field.reset();
 *   field.destroy();
 */
import { initVoiceTextarea } from './voiceInput.js';

export function createValidatedTextarea(opts = {}) {
    const {
        placeholder = '',
        rows = 3,
        minLength = 0,
        maxCapsInRow = 4,
        voice = false,
        onChange = () => {}
    } = opts;

    const capsRegex = new RegExp(`[А-ЯЁA-Z]{${maxCapsInRow + 1},}`);

    const wrap = document.createElement('div');
    wrap.style.cssText = 'display: flex; flex-direction: column; gap: 4px;';

    const row = document.createElement('div');
    row.style.cssText = 'display: flex; gap: 8px; align-items: flex-start;';

    const textarea = document.createElement('textarea');
    textarea.className = 'search-input editable-field';
    textarea.rows = rows;
    textarea.placeholder = placeholder;
    textarea.style.cssText = 'width: 100%; resize: vertical; font-family: inherit; flex: 1;';

    row.appendChild(textarea);

    const warn = document.createElement('div');
    warn.style.cssText = 'display: none; color: #ef4444; font-size: 12px;';

    wrap.appendChild(row);
    wrap.appendChild(warn);

    // Голосовой ввод — кнопка встанет в row справа от textarea
    if (voice) {
        initVoiceTextarea(textarea, { container: row });
    }

    // ========================================================================
    // Валидация
    // ========================================================================

    function validate() {
        const value = textarea.value.trim();
        const errors = [];

        if (value && capsRegex.test(value)) {
            errors.push(`Слишком много заглавных подряд (максимум ${maxCapsInRow})`);
        }
        if (minLength > 0 && value.length > 0 && value.length < minLength) {
            errors.push(`Минимум ${minLength} символов`);
        }

        const isValid = errors.length === 0;

        if (errors.length > 0) {
            warn.textContent = '⚠️ ' + errors.join('. ');
            warn.style.display = 'block';
            textarea.style.borderColor = '#ef4444';
        } else {
            warn.style.display = 'none';
            textarea.style.borderColor = '';
        }

        return isValid;
    }

    function handleInput() {
        const valid = validate();
        onChange(textarea.value.trim(), valid);
    }

    textarea.addEventListener('input', handleInput);

    // ========================================================================
    // Публичный API
    // ========================================================================

    return {
        element: wrap,
        getValue: () => textarea.value.trim(),
        setValue: (v) => {
            textarea.value = v;
            handleInput();
        },
        isValid: () => validate(),
        reset: () => {
            textarea.value = '';
            warn.style.display = 'none';
            textarea.style.borderColor = '';
        },
        destroy: () => {
            textarea.removeEventListener('input', handleInput);
        },
        focus: () => textarea.focus()
    };
}