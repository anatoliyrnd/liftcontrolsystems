/**
 * Утилиты для работы с датами.
 * Согласно API_PROTOCOL.md v4.0, все даты на сервере — это Unix timestamp (секунды).
 * Формат отображения в UI: dd.mm.yyyy@hh:mm (без пробелов).
 */

/** Возвращает текущий Unix timestamp (в секундах) */
export function nowTs() {
    return Math.floor(Date.now() / 1000);
}

/** Переводит объект Date в Unix timestamp (секунды) */
export function toTs(date) {
    if (!(date instanceof Date) || isNaN(date.getTime())) return null;
    return Math.floor(date.getTime() / 1000);
}

/**
 * Возвращает timestamp для дефолтного срока ремонта: 17:00 текущего дня.
 * Если сейчас уже больше 17:00, возвращает 17:00 завтрашнего дня
 * (чтобы валидация "не менее 30 минут" не срабатывала на прошлом).
 */
/**
 * Возвращает timestamp для дефолтного срока ремонта: 17:00.
 * Если текущее время >= 16:00 (или до 17:00 осталось меньше 25 минут),
 * возвращает 17:00 следующего дня, чтобы избежать ошибок валидации.
 */
export function getDefaultRepairTs() {
    const now = new Date();
    const target = new Date(now);
    target.setHours(17, 0, 0, 0);

    // Учитываем 25-минутный буфер (MIN_AHEAD_MS)
    const minTime = now.getTime() + (25 * 60 * 1000);

    // Если сейчас 16:00 или позже, ИЛИ если до 17:00 осталось меньше 25 минут
    if (now.getHours() >= 16 || target.getTime() < minTime) {
        target.setDate(target.getDate() + 1);
    }

    return toTs(target);
}

/**
 * Форматирует Unix timestamp (секунды) в строку 'dd.mm.yyyy@hh:mm'.
 * Если передан null/пустота — возвращает '—'.
 */
/**
 * Форматирует дату (Unix timestamp или старую строку) в 'dd.mm.yyyy@hh:mm'.
 * Устойчива к переходному периоду, когда бэкенд еще не переведен.
 */
export function formatTs(ts) {
    if (!ts || ts === '—') return '—';

    // Используем универсальный парсер, который понимает и числа, и строки
    const parsed = parseAnyDate(ts);
    if (!parsed) return '—';

    const pad = (n) => String(n).padStart(2, '0');
    return `${pad(parsed.getDate())}.${pad(parsed.getMonth() + 1)}.${parsed.getFullYear()}@${pad(parsed.getHours())}:${pad(parsed.getMinutes())}`;
}

/**
 * Универсальный парсер дат.
 * Принимает: Unix timestamp (число), ISO-строку, старые форматы (DD/MM/YYYY HH:MM, DD.MM.YYYY@HH:MM).
 * Возвращает объект Date или null.
 */
export function parseAnyDate(value) {
    if (value === null || value === undefined || value === '—') return null;

    // Если это уже timestamp (число)
    if (typeof value === 'number' || (typeof value === 'string' && /^\d+$/.test(value))) {
        return new Date(Number(value) * 1000);
    }

    // Если это объект Date
    if (value instanceof Date) return value;

    // Если это строка (DD/MM/YYYY HH:MM или DD.MM.YYYY@HH:MM)
    if (typeof value === 'string') {
        // Заменяем @ на пробел для единообразия
        const normalized = value.replace('@', ' ');
        const match = normalized.match(/(\d{2})[./](\d{2})[./](\d{4})\s+(\d{2}):(\d{2})/);
        if (match) {
            const [_, day, month, year, hours, minutes] = match;
            return new Date(year, month - 1, day, hours, minutes);
        }
    }

    return null;
}