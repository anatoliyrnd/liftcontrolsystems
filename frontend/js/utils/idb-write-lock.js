/**
 * Внутривкладочный mutex для операций записи в IndexedDB.
 *
 * Web Locks (sync-lock.js) защищает между вкладками, но НЕ сериализует
 * операции внутри одной вкладки. SyncManager (пачка syncCommands)
 * и NotificationsPoller (_refreshStores) могут одновременно писать в
 * outbox / config. IDB поставит транзакции в очередь, но между
 * отдельными await в длинной серии возможен race: poller прочитал
 * устаревший статус, sync его перезаписал, poller записал свой
 * результат поверх.
 *
 * Простая FIFO-очередь промисов. Сериализует серию операций внутри
 * одной вкладки. Не для коротких одиночных транзакций (там IDB сам
 * справляется) — для «длинных сессий» с несколькими await.
 *
 * Использование:
 *   import { withIdbWriteLock } from './utils/idb-write-lock.js';
 *
 *   await withIdbWriteLock(async () => {
 *     // серия операций с IDB
 *   });
 */

let lastOp = Promise.resolve();

export function withIdbWriteLock(fn) {
  const next = lastOp
    .then(() => fn())
    .catch((err) => {
      // Логируем — ошибка не должна теряться, но и очередь не должна
      // ломаться. Пробрасываем наверх, чтобы вызывающий увидел.
      console.error("[idb-write-lock] operation failed:", err);
      throw err;
    });

  // Хвост обновляем на «успех или ошибка — дальше идём».
  // Без catch() здесь next.catch проглатывал бы ошибку для
  // следующего в очереди — это правильно (одна упавшая операция
  // не блокирует остальные).
  lastOp = next.catch(() => {});

  return next;
}
