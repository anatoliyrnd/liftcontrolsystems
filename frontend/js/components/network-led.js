/**
 * Индикатор сетевого шлюза (LED-точка в левом нижнем углу).
 * Синглтон, управляющий цветом и тултипом единственной точки на странице.
 *
 * Состояния:
 *   idle     — серый, стартовое (нет ещё ни одного завершённого запроса)
 *   loading  — спиннер, пока есть хотя бы один активный запрос
 *   online   — зелёный, последний запрос завершился успешно
 *   offline  — красный, последний запрос завершился ошибкой
 *
 * Логика:
 *   requestStarted()  — счётчик +1, спиннер
 *   requestFinished() — счётчик −1, если 0 — вернуть к _lastOutcome
 *   reportSuccess()   — запомнить «online»
 *   reportFailure()   — запомнить «offline»
 *   reportAborted()   — не менять _lastOutcome (отмена — не ошибка)
 *
 * Таймаута до idle нет: LED показывает результат последнего запроса,
 * пока не будет сделан новый.
 */

const TITLES = {
    idle:    'Сетевой шлюз: ожидание',
    loading: 'Запрос к серверу...',
    online:  'Сетевой шлюз: online',
    offline: 'Сетевой шлюз: нет ответа'
};

export const networkLed = {
    _loadingCount: 0,
    _lastOutcome: 'idle',   // 'idle' | 'online' | 'offline'

    _el() {
        return document.getElementById('networkLedIndicator');
    },

    _apply(state) {
        const led = this._el();
        if (!led) return;

        led.classList.remove('loading', 'online', 'offline');

        if (state === 'loading') led.classList.add('loading');
        if (state === 'online')  led.classList.add('online');
        if (state === 'offline') led.classList.add('offline');

        led.setAttribute('title', TITLES[state] || TITLES.idle);
    },

    _render() {
        if (this._loadingCount > 0) {
            this._apply('loading');
        } else {
            this._apply(this._lastOutcome);
        }
    },

    /** Старт запроса. Увеличивает счётчик, показывает спиннер. */
    requestStarted() {
        this._loadingCount += 1;
        this._render();
    },

    /** Финиш запроса. Уменьшает счётчик, при нуле — возврат к последнему итогу. */
    requestFinished() {
        this._loadingCount = Math.max(0, this._loadingCount - 1);
        this._render();
    },

    /** Запомнить успех. */
    reportSuccess() { this._lastOutcome = 'online'; },

    /** Запомнить ошибку. */
    reportFailure() { this._lastOutcome = 'offline'; },

    /** Отмена — не меняет итог, но закрывает загрузку. */
    reportAborted() { /* _lastOutcome остаётся прежним */ },

    /** Ручной сброс в idle (например, при логауте). */
    reset() {
        this._loadingCount = 0;
        this._lastOutcome = 'idle';
        this._render();
    },

    /** Ручная установка состояния — для тестов и отладки. */
    setState(state) {
        if (state === 'loading') {
            this._loadingCount = 1;
        } else {
            this._loadingCount = 0;
            this._lastOutcome = state;
        }
        this._render();
    }
};