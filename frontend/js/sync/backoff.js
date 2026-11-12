/**
Backoff повторов команды (API_syncCommands.md v5.4 §8.2).
MAX_RETRIES 5 → 3, задержки 30 / 60 / 120 с.
Сетевые ошибки сюда не попадают — они не инкрементируют retry_count.
*/
export const MAX_RETRIES = 4;
const BACKOFF_SECONDS = [30, 60, 120];

/**
@param {number} retryCount — уже сделанные неудачные попытки (1..3)
@param {number} [now] — Unix-секунды
@returns {number} момент следующей попытки, Unix-секунды
*/
export function getNextRetryAt(retryCount, now = Math.floor(Date.now() / 1000)) {
const idx = Math.min(Math.max(Number(retryCount) || 1, 1), BACKOFF_SECONDS.length) - 1;
return now + BACKOFF_SECONDS[idx];
}

export function isRetryExhausted(retryCount) {
return (Number(retryCount) || 0) >= MAX_RETRIES;
}

export function getDelayMs(attempt) {
const idx = Math.min(Math.max(attempt, 1), MAX_RETRIES) - 1;
return BACKOFF_SECONDS[idx] * 1000;
}