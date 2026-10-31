/**
 * Класс контроля активности пользователя с визуальным таймером обратного отсчёта.
 *
 * Особенности реализации:
 *  - Остаток времени рассчитывается от абсолютного deadline (Date.now()), а не декрементом.
 *    Это устраняет накопление дрейфа setInterval.
 *  - Тик визуального таймера — раз в 10 секунд (достаточно для 30-минутного окна).
 *  - visibilitychange мгновенно пересчитывает остаток при возврате на вкладку.
 *  - Все методы-callback-и привязаны к контексту через .bind(this) в конструкторе.
 */
export class InactivityTracker {
    /**
     * @param {Router} routerInstance - Экземпляр роутера для редиректа
     * @param {number} timeoutMs - Время ожидания в миллисекундах (по умолчанию 30 мин)
     */
    constructor(routerInstance, timeoutMs = 30 * 60 * 1000) {
        this.router = routerInstance;
        this.timeout = timeoutMs;

        this.timer = null;              // setTimeout автовозврата
        this.countdownInterval = null;  // setInterval визуального тика
        this.timeRemaining = 0;         // Остаток в миллисекундах
        this._deadline = 0;             // Абсолютная метка срабатывания автовозврата

        // Throttle: не даём mousemove дёргать resetTimer чаще, чем раз в секунду
        this._lastResetAt = 0;
        this._resetThrottleMs = 1000;

        // Интервал визуального тика — 10 секунд
        this._tickMs = 10000;

        // Привязка контекста ко всем методам, которые передаются как callback-и.
        // Без .bind(this) this внутри них будет указывать на window/DOM-элемент.
        this.resetTimer = this.resetTimer.bind(this);
        this._onHashChange = this._onHashChange.bind(this);
        this._onVisibilityChange = this._onVisibilityChange.bind(this);
        this._onTick = this._onTick.bind(this);
    }

    /**
     * Запустить отслеживание действий пользователя и визуальный отсчёт.
     */
    startTracking() {
        document.addEventListener('mousemove', this.resetTimer);
        document.addEventListener('keydown', this.resetTimer);
        document.addEventListener('click', this.resetTimer);
        window.addEventListener('hashchange', this._onHashChange);
        document.addEventListener('visibilitychange', this._onVisibilityChange);

        this.resetTimer();
    }

    /**
     * Сброс таймеров при активности пользователя.
     * Троттлится: повторный вызов раньше 1 сек игнорируется.
     */
    resetTimer() {
        const now = Date.now();
        if (now - this._lastResetAt < this._resetThrottleMs) return;
        this._lastResetAt = now;

        if (this.timer) clearTimeout(this.timer);
        if (this.countdownInterval) clearInterval(this.countdownInterval);

        // Абсолютная точка автовозврата — общая для setTimeout и визуального тика
        this._deadline = Date.now() + this.timeout;
        this.timeRemaining = this.timeout;
        this._updateVisualTicker();

        // Тик раз в 10 сек: остаток пересчитывается от реального времени
        this.countdownInterval = setInterval(this._onTick, this._tickMs);

        this.timer = setTimeout(() => {
            this._executeAutoReturn();
        }, this.timeout);
    }

    /**
     * Обработчик визуального тика.
     * Остаток = deadline − текущее время. Дрейф setInterval не накапливается.
     */
    _onTick() {
        this.timeRemaining = Math.max(0, this._deadline - Date.now());
        this._updateVisualTicker();

        if (this.timeRemaining <= 0) {
            clearInterval(this.countdownInterval);
            this.countdownInterval = null;
        }
    }

    /**
     * Мгновенный пересчёт видимости блока таймера при смене hash.
     */
    _onHashChange() {
        this._updateVisualTicker();
    }

    /**
     * При возврате на вкладку мгновенно пересчитываем остаток —
     * не ждём следующего 10-секундного тика.
     */
    _onVisibilityChange() {
        if (document.visibilityState === 'visible' && this.countdownInterval) {
            this._onTick();
        }
    }

    /**
     * Преобразование миллисекунд в ММ:СС и вывод в DOM.
     * Блок таймера скрыт, когда пользователь на главной (Открытые заявки).
     */
    _updateVisualTicker() {
        const countdownElement = document.getElementById('inactivityCountdown');
        const containerBlock = document.getElementById('inactivityStatusBlock');
        const currentHash = window.location.hash || '#/';

        if (containerBlock) {
            const isMain = currentHash === '#/' || currentHash === '';
            // Используем visibility, чтобы блок не схлопывался и не дергал верстку
            containerBlock.style.visibility = isMain ? 'hidden' : 'visible';
            if (isMain) return;
        }

        if (!countdownElement) return;

        const totalSeconds = Math.max(0, Math.floor(this.timeRemaining / 1000));
        const minutes = Math.floor(totalSeconds / 60);
        const seconds = totalSeconds % 60;

        countdownElement.textContent =
            String(minutes).padStart(2, '0') + ':' + String(seconds).padStart(2, '0');
    }

    /**
     * Автовозврат на «Открытые заявки» по истечении времени.
     */
    _executeAutoReturn() {
        if (this.countdownInterval) {
            clearInterval(this.countdownInterval);
            this.countdownInterval = null;
        }

        const currentHash = window.location.hash || '#/';
        if (currentHash !== '#/' && currentHash !== '') {
            console.log('[InactivityTracker] Время истекло. Автовозврат на Открытые заявки.');
            this.router.navigate('#/');
        }
    }

    /**
     * Полная остановка трекера.
     */
    stopTracking() {
        if (this.timer) {
            clearTimeout(this.timer);
            this.timer = null;
        }
        if (this.countdownInterval) {
            clearInterval(this.countdownInterval);
            this.countdownInterval = null;
        }

        document.removeEventListener('mousemove', this.resetTimer);
        document.removeEventListener('keydown', this.resetTimer);
        document.removeEventListener('click', this.resetTimer);
        window.removeEventListener('hashchange', this._onHashChange);
        document.removeEventListener('visibilitychange', this._onVisibilityChange);
    }
}