/**
 * Плашка «Вы офлайн / есть несинхронизированные действия».
 * Показывается под шапкой, если:
 *   - navigator.onLine = false, ИЛИ
 *   - pending + failed > 0.
 *
 * Содержит кнопку «Синхронизировать» (диспатчит triggerSync).
 */
import { offlineDB } from '../offline-db.js';
import { onlineStatus } from '../utils/online-status.js';

class OfflineBanner {
    constructor() {
        this.el = null;
        this.textEl = null;
        this.btn = null;
        this._isOnline = true;
        this._counts = { pending: 0, failed: 0 };
        this._onRefresh = this._onRefresh.bind(this);
        this._onOnlineChange = this._onOnlineChange.bind(this);
        this._unsubscribe = null;
    }

    init() {
        this.el = document.getElementById('offlineBanner');
        if (!this.el) return;
        this.textEl = this.el.querySelector('.offline-banner-text');
        this.btn = this.el.querySelector('.offline-banner-btn');

        if (this.btn) {
            this.btn.onclick = (e) => {
                e.preventDefault();
                window.dispatchEvent(new Event('triggerSync'));
            };
        }

        this._unsubscribe = onlineStatus.subscribe(this._onOnlineChange);
        window.addEventListener('refreshSyncState', this._onRefresh);
        this._onRefresh();
    }

    _onOnlineChange(isOnline) {
        this._isOnline = isOnline;
        this._render();
    }

    async _onRefresh() {
        const [pending, failed] = await Promise.all([
            offlineDB.getOutboxCount(),
            offlineDB.getFailedCount()
        ]);
        this._counts = { pending, failed };
        this._render();
    }

    _render() {
        if (!this.el) return;
        const total = this._counts.pending + this._counts.failed;

        if (this._isOnline && total === 0) {
            this.el.style.display = 'none';
            return;
        }

        this.el.style.display = 'flex';
        this.el.classList.toggle('offline-banner--error', this._counts.failed > 0);

        let text;
        if (!this._isOnline && total === 0) {
            text = 'Вы работаете офлайн. Действия будут сохранены локально.';
        } else if (!this._isOnline && total > 0) {
            text = `Вы офлайн. ${total} действий ждут синхронизации.`;
        } else if (this._counts.failed > 0) {
            text = `Не удалось синхронизировать ${this._counts.failed} действий. Попробуйте снова.`;
        } else {
            text = `Ожидает синхронизации: ${this._counts.pending}.`;
        }

        if (this.textEl) this.textEl.textContent = text;
        if (this.btn) {
            this.btn.style.display = this._isOnline ? 'inline-flex' : 'none';
        }
    }
}

export const offlineBanner = new OfflineBanner();