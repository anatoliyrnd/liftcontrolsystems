/**
 * Индикатор состояния очереди синхронизации в шапке.
 *
 * Три состояния:
 *   🟢 idle    — pending=0, failed=0
 *   🟡 pending — pending>0, failed=0 (показывает число)
 *   🔴 error   — failed>0 (показывает число)
 *
 * Клик → переход на #/queue.
 * Реагирует на событие refreshSyncState (см. sync-manager._emitStateChanged).
 */
import { offlineDB } from '../offline-db.js';

class SyncIndicator {
    constructor() {
        this.el = null;
        this._last = { pending: -1, failed: -1 };
        this._onRefresh = this._onRefresh.bind(this);
        this._onClick = this._onClick.bind(this);
    }

    init() {
        this.el = document.getElementById('syncIndicator');
        if (!this.el) return;
        this.el.addEventListener('click', this._onClick);
        window.addEventListener('refreshSyncState', this._onRefresh);
        this._onRefresh();
    }

    _onClick() {
        window.location.hash = '#/queue';
    }

    async _onRefresh() {
        if (!this.el) return;
        const [pending, failed] = await Promise.all([
            offlineDB.getOutboxCount(),
            offlineDB.getFailedCount()
        ]);
        this.update(pending, failed);
    }

    update(pending, failed) {
        if (!this.el) return;
        if (pending === this._last.pending && failed === this._last.failed) return;
        this._last = { pending, failed };

        this.el.classList.remove('sync-idle', 'sync-pending', 'sync-error');
        const badge = this.el.querySelector('.sync-indicator-badge');
        const total = pending + failed;

        if (failed > 0) {
            this.el.classList.add('sync-error');
            this.el.title = `Ошибка синхронизации: ${failed}. Клик — очередь.`;
            if (badge) { badge.textContent = total; badge.style.display = 'inline-flex'; }
        } else if (pending > 0) {
            this.el.classList.add('sync-pending');
            this.el.title = `Ожидает синхронизации: ${pending}. Клик — очередь.`;
            if (badge) { badge.textContent = pending; badge.style.display = 'inline-flex'; }
        } else {
            this.el.classList.add('sync-idle');
            this.el.title = 'Всё синхронизировано';
            if (badge) badge.style.display = 'none';
        }
    }
}

export const syncIndicator = new SyncIndicator();