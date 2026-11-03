/**
 * Контроллер экрана #/queue.
 * Показывает все pending + failed команды (любых авторов).
 * - «Синхронизировать» — triggerSync event.
 * - «Удалить» (только для failed) — outboxQueue.remove.
 * - live-update по refreshSyncState.
 */
import { offlineDB } from './offline-db.js';
import { outboxQueue } from './outbox-queue.js';
import { notify } from './components/notify.js';
import { formatTs } from './utils/date-utils.js';

const TYPE_LABEL = {
    CreateTicket: 'Создание',
    EditTicket:   'Редактирование',
    CloseTicket:  'Закрытие',
    AddComment:   'Комментарий',
    AcceptTicket: 'Принятие'
};

export class QueueController {
    constructor(api, router) {
        this.api = api;
        this.router = router;
        this._refreshHandler = null;
    }

    async mount() {
        const $ = (id) => document.getElementById(id);

        const syncBtn = $('queueSyncBtn');
        const backBtn = $('queueBackBtn');
        if (backBtn) backBtn.onclick = () => this.router.navigate('#/');
        if (syncBtn) {
            syncBtn.onclick = () => {
                syncBtn.disabled = true;
                syncBtn.textContent = 'Синхронизация...';
                window.dispatchEvent(new Event('triggerSync'));
                setTimeout(() => {
                    syncBtn.disabled = false;
                    syncBtn.textContent = 'Синхронизировать';
                }, 3000);
            };
        }

        this._refreshHandler = () => this._render();
        window.addEventListener('refreshSyncState', this._refreshHandler);

        await this._render();
    }

    unmount() {
        if (this._refreshHandler) {
            window.removeEventListener('refreshSyncState', this._refreshHandler);
            this._refreshHandler = null;
        }
    }

    async _render() {
        const $ = (id) => document.getElementById(id);
        const tbody = document.querySelector('#queueTable tbody');
        const empty = $('queueEmpty');
        const summary = $('queueSummary');
        if (!tbody) return;

        const all = await offlineDB.getAllPending();
        const list = all.filter(c => c.status === 'pending' || c.status === 'failed')
                        .sort((a, b) => a.created_at - b.created_at);

        const pendingCount = list.filter(c => c.status === 'pending').length;
        const failedCount  = list.filter(c => c.status === 'failed').length;

        if (summary) {
            summary.textContent = list.length === 0
                ? ''
                : `Всего: ${list.length} · Ожидает: ${pendingCount} · Ошибок: ${failedCount}`;
        }

        tbody.innerHTML = '';

        if (list.length === 0) {
            if (empty) empty.style.display = 'block';
            return;
        }
        if (empty) empty.style.display = 'none';

        list.forEach((cmd, idx) => {
            const row = document.createElement('tr');
            if (cmd.status === 'failed') row.style.background = 'rgba(239,68,68,0.08)';

            const objectRef = cmd.ticket_id != null
                ? `№${cmd.ticket_id}`
                : (cmd.offline_uuid ? cmd.offline_uuid.slice(0, 16) + '…' : '—');

            const preview = this._preview(cmd);

            row.innerHTML = `
                <td>${idx + 1}</td>
                <td>${this._esc(TYPE_LABEL[cmd.command_type] || cmd.command_type)}</td>
                <td>${this._esc(cmd.offline_author_name || '—')}</td>
                <td>${this._esc(objectRef)}</td>
                <td title="${this._esc(preview)}" style="max-width:280px;overflow:hidden;text-overflow:ellipsis;">
                    ${this._esc(preview)}
                </td>
                <td style="color:${cmd.status === 'failed' ? '#ef4444' : '#f59e0b'};font-weight:600;">
                    ${cmd.status === 'failed' ? 'Ошибка' : 'Ожидает'}
                </td>
                <td>${formatTs(cmd.created_at)}</td>
                <td>
                    ${cmd.status === 'failed'
                        ? '<button class="queue-delete-btn" data-uuid="' + this._esc(cmd.command_uuid) + '" title="Удалить из очереди">×</button>'
                        : ''}
                </td>
            `;

            tbody.appendChild(row);
        });

        tbody.querySelectorAll('.queue-delete-btn').forEach(btn => {
            btn.onclick = async () => {
                const uuid = btn.dataset.uuid;
                if (!uuid) return;
                if (!confirm('Удалить действие из очереди? Оно не будет синхронизировано.')) return;
                await outboxQueue.remove([uuid]);
                notify.info('Действие удалено из очереди.');
                await this._render();
            };
        });
    }

    _preview(cmd) {
        const p = cmd.payload || {};
        if (cmd.command_type === 'CreateTicket') return p.fullAddress || '—';
        if (cmd.command_type === 'EditTicket') {
            if (p.details) return p.details;
            if (p.staff_id != null) return 'Назначить ответственного';
            if (p.repair_time != null) return 'Изменить время ремонта';
            if (p.notify_status != null) return 'Изменить статус уведомления';
            return '—';
        }
        if (cmd.command_type === 'CloseTicket') return p.solution || '—';
        if (cmd.command_type === 'AddComment') return p.text || '—';
        return '—';
    }

    _esc(s) {
        return String(s ?? '')
            .replace(/&/g, '&amp;')
            .replace(/</g, '&lt;')
            .replace(/>/g, '&gt;')
            .replace(/"/g, '&quot;');
    }
}
