/**
 * Хранилище сессии SPA.
 * Access-токен живёт ТОЛЬКО в памяти — XSS его не украдёт.
 * User — в localStorage (для UI-восстановления между F5).
 *
 * Refresh-токен вообще не хранится на фронте — он в httpOnly cookie.
 */
import { AUTH } from './config.js';

export const authStore = {
    _accessToken: null,
    _expiresAt: null,
    _user: null,

    /** Загрузить user из localStorage (вызывается при старте). */
    loadUser() {
        try {
            const raw = localStorage.getItem(AUTH.USER_STORAGE_KEY);
            this._user = raw ? JSON.parse(raw) : null;
        } catch (e) { this._user = null; }
    },

    /** Установить сессию. access_token — только в память, user — в localStorage. */
    setSession(accessToken, expiresAt, user) {
        this._accessToken = accessToken || null;
        this._expiresAt   = expiresAt || null;
        this._user        = user || null;

        if (user) {
            try { localStorage.setItem(AUTH.USER_STORAGE_KEY, JSON.stringify(user)); } catch (e) {}
        }
    },

    /** Обновить только access (после refresh). */
    setAccess(accessToken, expiresAt) {
        this._accessToken = accessToken;
        this._expiresAt   = expiresAt;
    },

    /** Полная очистка. */
    clear() {
        this._accessToken = null;
        this._expiresAt   = null;
        this._user        = null;
        try { localStorage.removeItem(AUTH.USER_STORAGE_KEY); } catch (e) {}
    },

    getAccess()    { return this._accessToken; },
    getExpiresAt() { return this._expiresAt; },
    getUser()      { return this._user; },
    hasAccess()    { return !!this._accessToken; },

    /** Роль текущего пользователя. */
    getRole() {
        return this._user && this._user.role ? this._user.role : 'guest';
    }
};