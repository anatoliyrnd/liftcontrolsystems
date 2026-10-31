/**
 * Модуль всплывающих уведомлений (тостов) с поддержкой звука.
 *
 * Возможности:
 *  - 4 типа: success / error / warning / info
 *  - Стопка до 3 активных, остальные — в очереди
 *  - Приоритет: error/warning вытесняют success/info при переполнении
 *  - Схлопывание одинаковых: «×2» вместо дубликата
 *  - Прогресс-полоска внизу тоста
 *  - Автоматическое закрытие по таймауту (переопределяется из опций)
 *  - Закрытие: крестик + Escape + кнопка «Закрыть все» при 2+ активных
 *  - Ссылка «Открыть →» для событий с ticket_id
 *  - Звук (Web Audio API) с throttling 10 секунд и autoplay-unlock при первом клике
 *  - aria-live для screen reader
 *
 * API:
 *   import { notify, setRouter } from './components/notify.js';
 *   setRouter(router);
 *   notify.success('Готово');
 *   notify.error('Сбой', { timeout: 0, sound: true });
 *   notify.batch([...]);
 */

const CONFIG = {
    MAX_STACK: 3,
    TIMEOUT: {
        success: 3000,
        info:    4000,
        warning: 6000,
        error:   8000
    },
    ANIM_IN_MS:  150,
    ANIM_OUT_MS: 500,
    MAX_TEXT_LENGTH: 200,
    SOUND_THROTTLE_MS: 10000,
    DEBUG: false
};

const SESSION_SHOWN_KEY = 'notifyShownIds';

let container = null;
const stack = [];
const queue = [];
let escapeHandlerAttached = false;

let appRouter = null;
let audioCtx = null;
let lastSoundAt = 0;

// ============================================================================
// УТИЛИТЫ
// ============================================================================

function log(...args) {
    if (CONFIG.DEBUG) console.log('[notify]', ...args);
}

function ensureContainer() {
    if (container && document.body.contains(container)) return container;

    container = document.getElementById('toastContainer');
    if (!container) {
        container = document.createElement('div');
        container.id = 'toastContainer';
        container.setAttribute('aria-live', 'polite');
        document.body.appendChild(container);
        log('Контейнер создан динамически');
    }
    return container;
}

function normalizeText(text) {
    if (text == null) return '';
    let s = String(text).trim();
    s = s.replace(/[\r\n\t]+/g, ' ');
    s = s.replace(/\s{2,}/g, ' ');
    if (s.length > CONFIG.MAX_TEXT_LENGTH) {
        s = s.slice(0, CONFIG.MAX_TEXT_LENGTH - 3) + '...';
    }
    return s;
}

function isPriority(type) {
    return type === 'error' || type === 'warning';
}

function loadShownIds() {
    try {
        const raw = sessionStorage.getItem(SESSION_SHOWN_KEY);
        return raw ? new Set(JSON.parse(raw)) : new Set();
    } catch (e) {
        return new Set();
    }
}

function saveShownIds(set) {
    try {
        sessionStorage.setItem(SESSION_SHOWN_KEY, JSON.stringify([...set]));
    } catch (e) { /* игнорируем */ }
}

function ensureEscapeHandler() {
    if (escapeHandlerAttached) return;
    escapeHandlerAttached = true;
    document.addEventListener('keydown', (e) => {
        if (e.key === 'Escape' && stack.length > 0) {
            closeToast(stack[0]);
        }
    });
}

// ============================================================================
// ЗВУК (Web Audio API)
// ============================================================================

/**
 * «Разбудить» аудио-контекст. Вызывается при первом клике пользователя —
 * браузеры блокируют воспроизведение до первого user activation.
 */
function unlockAudio() {
    if (audioCtx) return;
    try {
        const Ctx = window.AudioContext || window.webkitAudioContext;
        if (!Ctx) return;
        audioCtx = new Ctx();
        log('AudioContext создан');
    } catch (e) {
        console.warn('[notify] Не удалось создать AudioContext:', e);
    }
}

function ensureAudioUnlockListener() {
    document.addEventListener('click', unlockAudio, { once: true });
    document.addEventListener('keydown', unlockAudio, { once: true });
    document.addEventListener('touchstart', unlockAudio, { once: true });
}

/**
 * Проиграть универсальный beep.
 * Throttling: не чаще одного раза в SOUND_THROTTLE_MS.
 */
function playSound() {
    const now = Date.now();
    if (now - lastSoundAt < CONFIG.SOUND_THROTTLE_MS) {
        log('Звук пропущен (throttle)');
        return;
    }
    lastSoundAt = now;

    if (!audioCtx) {
        // Ещё не разбудили — попробуем создать сейчас (сработает, если был user activation)
        unlockAudio();
    }
    if (!audioCtx) {
        log('Звук пропущен (audio не активирован)');
        return;
    }

    try {
        const osc = audioCtx.createOscillator();
        const gain = audioCtx.createGain();

        osc.type = 'sine';
        osc.frequency.setValueAtTime(880, audioCtx.currentTime);     // A5
        osc.frequency.setValueAtTime(1100, audioCtx.currentTime + 0.08); // C#6

        gain.gain.setValueAtTime(0.0001, audioCtx.currentTime);
        gain.gain.exponentialRampToValueAtTime(0.15, audioCtx.currentTime + 0.02);
        gain.gain.exponentialRampToValueAtTime(0.0001, audioCtx.currentTime + 0.25);

        osc.connect(gain);
        gain.connect(audioCtx.destination);
        osc.start();
        osc.stop(audioCtx.currentTime + 0.3);
    } catch (e) {
        console.warn('[notify] Ошибка воспроизведения звука:', e);
    }
}

// ============================================================================
// ПОИСК СУЩЕСТВУЮЩИХ / ЖЕРТВ
// ============================================================================

function findSame(type, text) {
    let found = stack.find(t => t.type === type && t.text === text);
    if (found) return found;
    return queue.find(t => t.type === type && t.text === text) || null;
}

function findVictimInStack() {
    for (let i = stack.length - 1; i >= 0; i--) {
        if (!isPriority(stack[i].type)) return stack[i];
    }
    return null;
}

// ============================================================================
// ОСНОВНАЯ ФУНКЦИЯ ПОКАЗА
// ============================================================================

function show(type, text, opts = {}) {
    const cleanText = normalizeText(text);
    if (!cleanText) {
        log('Пустой текст — тост не показан');
        return;
    }

    if (opts.once) {
        const key = opts.id || ('text:' + type + ':' + cleanText);
        const shown = loadShownIds();
        if (shown.has(key)) {
            log('Тост уже показан в этой сессии:', key);
            return;
        }
        shown.add(key);
        saveShownIds(shown);
    }

    const existing = findSame(type, cleanText);
    if (existing) {
        existing.count = (existing.count || 1) + 1;
        updateCountBadge(existing);
        log('Схлопнуто:', cleanText, '×' + existing.count);
        return;
    }

    const toastData = {
        id: 'toast_' + Date.now() + '_' + Math.random().toString(36).slice(2, 7),
        type,
        text: cleanText,
        ticketId: opts.ticketId || null,
        timeout: typeof opts.timeout === 'number' ? opts.timeout : CONFIG.TIMEOUT[type],
        persistent: !!opts.persistent || opts.timeout === 0,
        sound: !!opts.sound,
        count: 1,
        element: null,
        timerId: null,
        closing: false
    };

    ensureEscapeHandler();

    if (stack.length >= CONFIG.MAX_STACK) {
        if (isPriority(type)) {
            const victim = findVictimInStack();
            if (victim) {
                closeToast(victim);
                renderToast(toastData);
                return;
            }
        }
        queue.push(toastData);
        updateQueueIndicator();
        updateCloseAllButton();
        log('В очередь:', cleanText);
    } else {
        renderToast(toastData);
    }
}

// ============================================================================
// РЕНДЕР
// ============================================================================

function renderToast(data) {
    const box = ensureContainer();

    const el = document.createElement('div');
    el.className = 'toast toast-' + data.type;
    el.setAttribute('role', data.type === 'error' ? 'alert' : 'status');
    el.dataset.toastId = data.id;

    const textEl = document.createElement('div');
    textEl.className = 'toast-text';
    textEl.textContent = data.text;
    el.appendChild(textEl);

    const countEl = document.createElement('span');
    countEl.className = 'toast-count';
    countEl.style.display = 'none';
    el.appendChild(countEl);

    if (data.ticketId) {
        const link = document.createElement('a');
        link.className = 'toast-open-link';
        link.href = '#/ticket/' + data.ticketId;
        link.textContent = 'Открыть →';
        link.addEventListener('click', (e) => {
            e.stopPropagation();
            if (appRouter) appRouter.navigate('#/ticket/' + data.ticketId);
            closeToast(data);
        });
        el.appendChild(link);
    }

    const closeBtn = document.createElement('button');
    closeBtn.type = 'button';
    closeBtn.className = 'toast-close';
    closeBtn.setAttribute('aria-label', 'Закрыть уведомление');
    closeBtn.textContent = '×';
    closeBtn.addEventListener('click', (e) => {
        e.stopPropagation();
        closeToast(data);
    });
    el.appendChild(closeBtn);

    if (data.timeout > 0 && !data.persistent) {
        const progress = document.createElement('div');
        progress.className = 'toast-progress';
        progress.style.animationDuration = data.timeout + 'ms';
        el.appendChild(progress);
    }

    data.element = el;
    stack.unshift(data);
    box.insertBefore(el, box.firstChild);

    requestAnimationFrame(() => el.classList.add('toast-visible'));

    if (data.timeout > 0 && !data.persistent) {
        data.timerId = setTimeout(() => closeToast(data), data.timeout);
    }

    // Звук — только если сервер попросил
    if (data.sound) {
        playSound();
    }

    updateCloseAllButton();
    log('Показан:', data.type, data.text, data.sound ? '🔔' : '');
}

function updateCountBadge(data) {
    if (!data.element) return;
    const countEl = data.element.querySelector('.toast-count');
    if (!countEl) return;

    if (data.count > 1) {
        countEl.textContent = '×' + data.count;
        countEl.style.display = 'inline-block';
    } else {
        countEl.style.display = 'none';
    }
}

// ============================================================================
// ЗАКРЫТИЕ
// ============================================================================

function closeToast(data, silent = false) {
    if (!data || data.closing) return;
    data.closing = true;

    if (data.timerId) {
        clearTimeout(data.timerId);
        data.timerId = null;
    }

    const idx = stack.indexOf(data);
    if (idx !== -1) stack.splice(idx, 1);

    if (data.element) {
        const el = data.element;
        el.classList.remove('toast-visible');
        el.classList.add('toast-closing');
        el.style.pointerEvents = 'none';

        setTimeout(() => {
            el.remove();
            if (!silent) {
                moveQueue();
                updateCloseAllButton();
                updateQueueIndicator();
            }
        }, CONFIG.ANIM_OUT_MS);
    } else if (!silent) {
        moveQueue();
        updateCloseAllButton();
        updateQueueIndicator();
    }

    log('Закрыт:', data.type, data.text);
}

function moveQueue() {
    if (queue.length === 0) return;
    if (stack.length >= CONFIG.MAX_STACK) return;
    const next = queue.shift();
    renderToast(next);
}

function clear() {
    [...stack].forEach(t => closeToast(t, true));
    queue.length = 0;
    updateQueueIndicator();
    updateCloseAllButton();
    log('Все тосты закрыты');
}

// ============================================================================
// ИНДИКАТОРЫ
// ============================================================================

function updateQueueIndicator() {
    const box = ensureContainer();
    let indicator = box.querySelector('.toast-queue-indicator');

    if (queue.length === 0) {
        if (indicator) indicator.remove();
        return;
    }

    if (!indicator) {
        indicator = document.createElement('div');
        indicator.className = 'toast-queue-indicator';
        box.appendChild(indicator);
    }
    indicator.textContent = '+' + queue.length + ' в очереди';
}

function updateCloseAllButton() {
    const box = ensureContainer();
    let btn = box.querySelector('.toast-close-all');

    const shouldShow = stack.length >= 2;

    if (!shouldShow) {
        if (btn) btn.remove();
        return;
    }

    if (!btn) {
        btn = document.createElement('button');
        btn.type = 'button';
        btn.className = 'toast-close-all';
        btn.textContent = 'Закрыть все';
        btn.addEventListener('click', clear);
        box.appendChild(btn);
    }
}

// ============================================================================
// ПУБЛИЧНЫЙ API
// ============================================================================

/**
 * Передать модулю роутер — для навигации по ссылке «Открыть →».
 * Вызывается один раз в main.js.
 */
export function setRouter(router) {
    appRouter = router;
}

export const notify = {
    success: (text, opts) => show('success', text, opts),
    error:   (text, opts) => show('error',   text, opts),
    warning: (text, opts) => show('warning', text, opts),
    info:    (text, opts) => show('info',    text, opts),
    clear,
    batch
};

/**
 * Массовая загрузка уведомлений (обычно с сервера).
 * @param {Array<{id?, type, text, ticketId?, timeout?, once?, persistent?, sound?}>} list
 */
function batch(list) {
    if (!Array.isArray(list)) return;
    list.forEach(item => {
        if (!item || !item.type || !item.text) return;
        const fn = notify[item.type];
        if (typeof fn !== 'function') {
            log('Неизвестный тип уведомления:', item.type);
            return;
        }
        fn(item.text, {
            id: item.id,
            once: item.once,
            timeout: item.timeout,
            persistent: item.persistent,
            ticketId: item.ticketId,
            sound: item.sound
        });
    });
}

// ============================================================================
// АВТОИНИЦИАЛИЗАЦИЯ: пробуждение аудио при первом клике
// ============================================================================

ensureAudioUnlockListener();