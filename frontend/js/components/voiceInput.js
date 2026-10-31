// voiceInput.js
import { notify } from './notify.js';
/**
 * Web Speech API — нестандартное расширение DOM.
 * Поддерживается в Chrome, Edge, Яндекс.Браузере (частично),
 * отсутствует в Firefox и Safari без полифилов.
 */
// @ts-ignore
// voiceInput.js
import { UI } from '../config.js';

const SR = window.SpeechRecognition || window.webkitSpeechRecognition;

let activeRecognition = null;
let activeBtn = null;
let silenceTimer = null;
const SILENCE_MS = UI.VOICE_SILENCE_MS;
// Ключ и TTL для флага «Web Speech API не работает в этом браузере».
// Устанавливается при первой ошибке типа 'network' (Яндекс.Браузер, региональные блокировки).
const VOICE_DISABLED_KEY = 'voiceInputDisabledUntil';
const VOICE_DISABLED_TTL_MS = UI.VOICE_DISABLED_TTL_MS;
function isVoiceDisabled() {
    try {
        const until = parseInt(localStorage.getItem(VOICE_DISABLED_KEY) || '0', 10);
        return until > Date.now();
    } catch (e) {
        return false;
    }
}

function markVoiceDisabled() {
    try {
        localStorage.setItem(VOICE_DISABLED_KEY, String(Date.now() + VOICE_DISABLED_TTL_MS));
    } catch (e) {
        // Приватный режим / нет localStorage — игнорируем
    }
}
function createMicButton(textarea) {
    const btn = document.createElement('button');
    btn.type = 'button';
    btn.textContent = '🎤';
    btn.title = 'Голосовой ввод';
    btn.className = 'btn-voice-mic editable-field';

    btn.addEventListener('click', () => {
        if (btn.dataset.active === '1') {
            stopCurrentRecognition();
        } else {
            startRecognition(textarea, btn);
        }
    });
    return btn;
}

function stopCurrentRecognition() {
    if (silenceTimer) {
        clearTimeout(silenceTimer);
        silenceTimer = null;
    }
    if (activeRecognition) {
        activeRecognition.stop();
        activeRecognition = null;
    }
    if (activeBtn) {
        activeBtn.textContent = '🎤';
        activeBtn.dataset.active = '';
        activeBtn.classList.remove('active');
        activeBtn = null;
    }
}

function startRecognition(textarea, btn) {
    // Если где-то на странице уже включен микрофон — выключаем перед стартом нового
    stopCurrentRecognition();

    const recognition = new SR();
    recognition.lang = 'ru-RU';
    recognition.continuous = true;
    recognition.interimResults = true;

    // Фиксируем текст, который БЫЛ в поле до начала ввода
    const initialText = textarea.value;
    const startPos = textarea.selectionStart;
    const endPos = textarea.selectionEnd;

    const textBefore = initialText.slice(0, startPos);
    const textAfter = initialText.slice(endPos);

    // Сбрасывает таймер молчания. Вызывается на каждом результате распознавания.
    // Если 5 секунд не приходит ни одного onresult — считаем, что пользователь закончил.
    function resetSilenceTimer() {
        if (silenceTimer) clearTimeout(silenceTimer);
        silenceTimer = setTimeout(() => {
            // Автозавершение по тишине: останавливаем запись и добавляем пробел
            // в конец распознанного текста, чтобы следующая диктовка началась с новой фразы.
            if (activeRecognition === recognition) {
                // Дописываем пробел, если он ещё не стоит и текст не пустой
                if (textarea.value && !/\s$/.test(textarea.value)) {
                    textarea.value = textarea.value + ' ';
                    textarea.dispatchEvent(new Event('input', { bubbles: true }));
                }
                stopCurrentRecognition();
            }
        }, SILENCE_MS);
    }

    recognition.onresult = (e) => {
        let interimText = '';
        let finalText = '';

        // Проходим ВСЕГДА от 0, собирая актуальный слепок всей сессии.
        // Не полагаемся на e.resultIndex — на мобильных браузерах он может
        // сбрасываться или переиспользоваться, что приводит к дублированию
        // или затиранию ранее распознанного текста.
        for (let i = 0; i < e.results.length; i++) {
            if (e.results[i].isFinal) {
                finalText += e.results[i][0].transcript;
            } else {
                interimText += e.results[i][0].transcript;
            }
        }

        // Собираем текст: до курсора + всё финальное за сессию + промежуточное + после курсора
        textarea.value = textBefore + finalText + interimText + textAfter;

        // Курсор — в конец вставленного текста
        const nextCursorPos = startPos + finalText.length + interimText.length;
        textarea.setSelectionRange(nextCursorPos, nextCursorPos);

        // Триггерим событие, чтобы стейт SPA/валидаторы узнали об изменении поля
        textarea.dispatchEvent(new Event('input', { bubbles: true }));

        // Продлеваем окно тишины: пока идёт речь, таймер сбрасывается
        resetSilenceTimer();
    };

    recognition.onend = () => {
        if (activeRecognition === recognition) {
            stopCurrentRecognition();
        }
    };

    recognition.onerror = (e) => {
        // 'network' — системная недоступность речевого бэкенда
        // (Яндекс.Браузер, региональные блокировки Google Speech API).
        // Один раз поймали — больше кнопку не показываем 24 часа.
        if (e && e.error === 'network') {
            markVoiceDisabled();
            console.warn('[voiceInput] Web Speech API недоступен (network). Кнопка микрофона будет скрыта на 24 часа.');
            notify.warning(
                'Голосовой ввод недоступен (проблема с речевым сервисом)',
                { once: true, id: 'voice_network_error' }
            );
        }

        if (activeRecognition === recognition) {
            stopCurrentRecognition();
        }
    };

    btn.textContent = '⏹';
    btn.dataset.active = '1';
    btn.classList.add('active');

    activeRecognition = recognition;
    activeBtn = btn;

    recognition.start();

    // Запускаем отсчёт тишины сразу — если пользователь молчит с самого начала,
    // сессия закроется через 5 секунд
    resetSilenceTimer();
}

/**
 * Инициализирует голосовой ввод для конкретного textarea.
 * @param {HTMLTextAreaElement} textarea
 * @param {Object} [options]
 * @param {HTMLElement} [options.container] — куда вставить кнопку. По умолчанию — сразу после textarea.
 */
export function initVoiceTextarea(textarea, options = {}) {
    if (!textarea) return;

    if (!SR) {
        // Firefox / Safari — движок не поддерживается в принципе
        notify.warning(
            'Голосовой ввод недоступен в этом браузере',
            { once: true, id: 'voice_no_sr' }
        );
        return;
    }
    if (isVoiceDisabled()) {
        // Яндекс.Браузер или иная блокировка речевого сервиса
        notify.warning(
            'Голосовой ввод временно недоступен (проблема с речевым сервисом)',
            { once: true, id: 'voice_disabled' }
        );
        return;
    }
    if (textarea.dataset.voiceMic) return;
    textarea.dataset.voiceMic = '1';
    const btn = createMicButton(textarea);

    if (options.container) {
        options.container.appendChild(btn);
    } else {
        textarea.insertAdjacentElement('afterend', btn);
    }
}

/**
 * Сброс состояния при уничтожении компонентов SPA (предотвращает зависание микрофона)
 */
export function destroyVoiceInput() {
    stopCurrentRecognition();
}