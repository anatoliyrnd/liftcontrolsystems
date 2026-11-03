/**
 * Экспоненциальный backoff для retry синхронизации outbox.
 *
 * Согласовано с OFFLINE_PROTOCOL.md v3.0 (раздел 10.1):
 *   1 → 30s, 2 → 60s, 3 → 120s, 4 → 240s, 5 → 480s
 *   > 5 → ручное вмешательство (status='failed', last_error='retry_exhausted')
 *
 * Использование:
 *   import { getNextRetryAt, getDelayMs, MAX_RETRIES } from './sync/backoff.js';
 *
 *   if (retryCount >= MAX_RETRIES) { markFailed(cmd, 'retry_exhausted'); }
 *   else { const ts = getNextRetryAt(retryCount + 1); markRetry(cmd, reason, ts); }
 */

export const MAX_RETRIES = 5;

const DELAYS_SEC = [30, 60, 120, 240, 480];

/**
 * Задержка перед retry (мс) для попытки №attempt (1-based).
 * Если attempt > MAX_RETRIES — возвращает последнюю задержку (480s).
 */
export function getDelayMs(attempt) {
    const idx = Math.min(Math.max(attempt, 1), MAX_RETRIES) - 1;
    return DELAYS_SEC[idx] * 1000;
}

/**
 * Unix timestamp (секунды), раньше которого retry не запускать.
 * @param {number} attempt — номер следующей попытки (1-based).
 * @param {number} [nowSec] — для тестов; по умолчанию Date.now()/1000
 */
export function getNextRetryAt(attempt, nowSec) {
    const now = typeof nowSec === 'number' ? nowSec : Math.floor(Date.now() / 1000);
    return now + Math.floor(getDelayMs(attempt) / 1000);
}

/**
 * Пора ли ретраить команду?
 * @param {Object} cmd — запись outbox
 * @param {number} [nowSec]
 */
export function isRetryDue(cmd, nowSec) {
    const now = typeof nowSec === 'number' ? nowSec : Math.floor(Date.now() / 1000);
    return (cmd.next_retry_at || 0) <= now;
}