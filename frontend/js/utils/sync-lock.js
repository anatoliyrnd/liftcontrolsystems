/**
 * Межтабовый мьютекс для синхронизации outbox.
 *
 * Зачем: при 5 открытых вкладках каждая может запустить _syncLoop()
 * одновременно. Сервер защищён идемпотентностью (batch_id, command_uuid),
 * но 4 из 5 табов сделают бесполезный POST. Web Locks API сериализует
 * вызовы между табами одного origin.
 *
 * Поддержка: Chrome 69+, Firefox 96+, Safari 15.4+.
 * Fallback: если navigator.locks недоступен — просто выполняем callback
 * без блокировки (пользуемся идемпотентностью сервера).
 *
 * Использование:
 *   import { withSyncLock } from './utils/sync-lock.js';
 *
 *   await withSyncLock(async () => {
 *       await syncManager._syncLoop();
 *   });
 *
 * Семантика: если лок занят другим табом — ЖДЁМ освобождения.
 * Когда лок получен — callback выполняется. Если outbox уже пуст
 * (другой таб всё синхронизировал) — _syncLoop() просто быстро выйдет.
 *
 * Имя лока префиксовано доменом приложения, чтобы не конфликтовать
 * с локами других скриптов на том же origin.
 */

const LOCK_NAME = 'liftcs.sync.outbox';

export async function withSyncLock(callback) {
    if (
        typeof navigator !== 'undefined' &&
        navigator.locks &&
        typeof navigator.locks.request === 'function'
    ) {
        return navigator.locks.request(LOCK_NAME, callback);
    }
    // Fallback: без Web Locks. Один таб будет синхронизировать,
    // остальные получат 4xx/ignored — не критично.
    return callback();
}