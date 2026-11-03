/**
 * Модалка подтверждения duplicate_detected.
 * Показывается из SyncManager._handleDuplicate.
 *
 * show({ record, existingTickets }) → Promise<boolean>
 *   true  — создать дубликат (force_create: true)
 *   false — отменить
 *
 * Стили — .duplicate-modal-* в style.css.
 */
class DuplicateTicketModal {
    constructor() {
        this._overlay = null;
        this._resolve = null;
    }

    show(record, existingTickets) {
        return new Promise((resolve) => {
            this._resolve = resolve;
            this._mount(record, existingTickets || []);
        });
    }

    _mount(record, existingTickets) {
        this._unmount();

        const overlay = document.createElement('div');
        overlay.className = 'duplicate-modal-overlay';
        overlay.onclick = (e) => {
            if (e.target === overlay) this._close(false);
        };

        const modal = document.createElement('div');
        modal.className = 'duplicate-modal';
        modal.setAttribute('role', 'dialog');
        modal.setAttribute('aria-modal', 'true');

        const author = record.offline_author_name
            ? `${record.offline_author_name}`
            : 'другим пользователем';

        const listHtml = existingTickets.map(t => {
            const d = t.details ? ` — ${this._escape(t.details)}` : '';
            const dateStr = t.date ? new Date(t.date * 1000).toLocaleString('ru') : '';
            return `<li style="margin-bottom:6px;font-size:13px;">
                <b>№${this._escape(String(t.call_id ?? '—'))}</b>${d}
                ${dateStr ? `<br><span style="color:var(--text-secondary);font-size:11px;">${this._escape(dateStr)}</span>` : ''}
            </li>`;
        }).join('');

        modal.innerHTML = `
            <h3 style="margin:0 0 10px 0;font-size:1.15rem;">⚠️ Возможен дубликат</h3>
            <div style="font-size:13px;color:var(--text-secondary);margin-bottom:12px;">
                На объект уже есть активная заявка. Действие создано ${this._escape(author)}.
            </div>
            <ul style="margin:0 0 16px 20px;padding:0;list-style:disc;max-height:200px;overflow-y:auto;">
                ${listHtml || '<li style="font-size:13px;color:var(--text-secondary);">—</li>'}
            </ul>
            <div style="font-size:12px;color:var(--text-secondary);margin-bottom:16px;">
                Создание новой заявки будет помечено как дубликат.
            </div>
            <div style="display:flex;gap:8px;justify-content:flex-end;">
                <button class="duplicate-modal-btn duplicate-modal-btn--cancel" type="button">
                    Отмена
                </button>
                <button class="duplicate-modal-btn duplicate-modal-btn--confirm" type="button">
                    Создать дубликат
                </button>
            </div>
        `;

        overlay.appendChild(modal);
        document.body.appendChild(overlay);
        this._overlay = overlay;

        modal.querySelector('.duplicate-modal-btn--cancel').onclick = () => this._close(false);
        modal.querySelector('.duplicate-modal-btn--confirm').onclick = () => this._close(true);

        requestAnimationFrame(() => overlay.classList.add('duplicate-modal-overlay--visible'));

        this._keyHandler = (e) => {
            if (e.key === 'Escape') this._close(false);
        };
        document.addEventListener('keydown', this._keyHandler);
    }

    _close(result) {
        const resolve = this._resolve;
        this._resolve = null;
        this._unmount();
        if (resolve) resolve(result);
    }

    _unmount() {
        if (this._keyHandler) {
            document.removeEventListener('keydown', this._keyHandler);
            this._keyHandler = null;
        }
        if (this._overlay && this._overlay.parentNode) {
            this._overlay.parentNode.removeChild(this._overlay);
        }
        this._overlay = null;
    }

    _escape(s) {
        return String(s)
            .replace(/&/g, '&amp;')
            .replace(/</g, '&lt;')
            .replace(/>/g, '&gt;')
            .replace(/"/g, '&quot;');
    }
}

export const duplicateTicketModal = new DuplicateTicketModal();