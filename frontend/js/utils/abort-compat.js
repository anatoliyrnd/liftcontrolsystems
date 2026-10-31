/**
 * Хелперы для отмены fetch-запросов с возможностью отличить
 * «отмену пользователем» (abortTag) от «таймаута» (AbortController по setTimeout).
 *
 * Используется современный AbortSignal.reason (Chrome 98+, Firefox 97+, Safari 15.4+).
 * Если целевые браузеры старше 2022 — переключиться на вариант А в комментарии.
 */

/**
 * Вариант Б (текущий): AbortSignal.reason через DOMException.
 * Возвращает reason для передачи в controller.abort(reason).
 */
export function userAbortReason() {
    return new DOMException('User abort', 'UserAbort');
}

/**
 * Проверка: ошибка пришла из-за отмены пользователем?
 * @param {Error|DOMException} err
 * @returns {boolean}
 */
export function isUserAbort(err) {
    return !!err && err.name === 'UserAbort';
}

/* =========================================================================
   ВАРИАНТ А (резервный, если нужна поддержка браузеров до 2022 года):
   Вместо AbortSignal.reason — пометка флага на самом controller.

   // В abortTag (api-service.js):
   //   set.forEach(c => { c._liftUserAbort = true; c.abort(); });
   //
   // В _sendPostRequest catch:
   //   const userAborted = err.name === 'AbortError' && controller._liftUserAbort;

   Для перехода на вариант А:
   1. Раскомментировать соответствующие строки в api-service.js.
   2. Удалить экспорты userAbortReason / isUserAbort из этого файла.
   ========================================================================= */