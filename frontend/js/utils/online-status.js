/**
 * Трекер сетевого статуса браузера.
 *
 * Источник правды — navigator.onLine + события online/offline.
 * Специально НЕ делает ping: серверные ошибки ловит api-service.js
 * и возвращает { offline: true }, не смешивая «нет сети» и «сервер упал».
 *
 * Использование:
 *   import { onlineStatus } from './utils/online-status.js';
 *
 *   if (onlineStatus.isOnline()) { ... }
 *
 *   const unsub = onlineStatus.subscribe((online) => {
 *       // Вызывается СРАЗУ при подписке с текущим состоянием,
 *       // затем на каждый переход online <-> offline.
 *   });
 *
 *   // позже
 *   unsub();
 *
 * Почему эмитим начальное состояние: подписчики (banner, sync-trigger)
 * должны отрисовать актуальный статус без отдельного «get + subscribe».
 */

class OnlineStatus {
    constructor() {
        this._subscribers = new Set();
        this._online = typeof navigator !== 'undefined'
            ? navigator.onLine !== false
            : true;

        this._handleOnline = this._handleOnline.bind(this);
        this._handleOffline = this._handleOffline.bind(this);

        if (typeof window !== 'undefined') {
            window.addEventListener('online', this._handleOnline);
            window.addEventListener('offline', this._handleOffline);
        }
    }

    isOnline() {
        return this._online;
    }

    /**
     * Подписаться на изменения.
     * @param {(online: boolean) => void} cb
     * @returns {() => void} unsubscribe
     */
    subscribe(cb) {
        if (typeof cb !== 'function') return () => {};
        this._subscribers.add(cb);
        // Начальная эмиссия — синхронно, чтобы подписчик сразу увидел состояние.
        try { cb(this._online); } catch (e) { console.error('[onlineStatus] subscriber error:', e); }
        return () => this._subscribers.delete(cb);
    }

    _handleOnline() {
        if (this._online) return;
        this._online = true;
        this._emit();
    }

    _handleOffline() {
        if (!this._online) return;
        this._online = false;
        this._emit();
    }

    _emit() {
        const state = this._online;
        this._subscribers.forEach((cb) => {
            try { cb(state); } catch (e) { console.error('[onlineStatus] subscriber error:', e); }
        });
    }
}

export const onlineStatus = new OnlineStatus();