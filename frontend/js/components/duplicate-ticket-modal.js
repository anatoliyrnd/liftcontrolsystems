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
      // Защита от зависшего Promise: если предыдущий show() не был
      // закрыт через _close() (пользователь не нажал ни одну кнопку,
      // а прилетел новый duplicate_detected), резолвим старый как false.
      // Иначе await onDuplicateDetected(...) в SyncManager повиснет навсегда
      // и остановит _syncLoop.
      if (this._resolve) {
        const prev = this._resolve;
        this._resolve = null;
        try {
          prev(false);
        } catch (e) {
          /* ignore */
        }
      }
      this._resolve = resolve;
      this._mount(record, existingTickets || []);
    });
  }

  _mount(record, existingTickets) {
    this._unmount();

    const overlay = document.createElement("div");
    overlay.className = "duplicate-modal-overlay";
    overlay.onclick = (e) => {
      if (e.target === overlay) this._close(false);
    };

    const modal = document.createElement("div");
    modal.className = "duplicate-modal";
    modal.setAttribute("role", "dialog");
    modal.setAttribute("aria-modal", "true");

    const author = record.offline_author_name
      ? `${record.offline_author_name}`
      : "другим пользователем";

        const listHtml = existingTickets
      .map((t) => {
        // 1. Достаем ID (сервер отдает ticket_id)
        const ticketId = t.ticket_id ?? t.call_id ?? "—";
        
        // 2. Форматируем дату
        const dateStr = t.date
          ? new Date(t.date * 1000).toLocaleString("ru")
          : "";
          
        // 3. Достаем адрес (на случай, если сервер его присылает)
        const addressStr = t.address || t.fullAddress;
        const addressHtml = addressStr 
            ? `<div style="font-size:12px; color:var(--text-secondary); margin-top:2px;">📍 ${this._escape(addressStr)}</div>` 
            : "";
            
        // 4. Достаем описание (details)
        const detailsHtml = t.details 
            ? `<div style="margin-top:6px; font-size:13px; font-weight:500;">${this._escape(t.details)}</div>` 
            : "";

        // 5. Собираем карточку
        return `<li style="margin-bottom:12px; padding-bottom:8px; border-bottom:1px solid rgba(0,0,0,0.1);">
                    <div style="display:flex; justify-content:space-between; align-items:center;">
                        <b style="font-size:14px; color:var(--text-primary);">№${this._escape(String(ticketId))}</b>
                        <span style="color:var(--text-secondary); font-size:11px;">${this._escape(dateStr)}</span>
                    </div>
                    ${addressHtml}
                    ${detailsHtml}
                </li>`;
      })
      .join("");

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

    modal.querySelector(".duplicate-modal-btn--cancel").onclick = () =>
      this._close(false);
    modal.querySelector(".duplicate-modal-btn--confirm").onclick = () =>
      this._close(true);

    requestAnimationFrame(() =>
      overlay.classList.add("duplicate-modal-overlay--visible"),
    );

    this._keyHandler = (e) => {
      if (e.key === "Escape") this._close(false);
    };
    document.addEventListener("keydown", this._keyHandler);
  }

  _close(result) {
    const resolve = this._resolve;
    this._resolve = null;
    this._unmount();
    if (resolve) resolve(result);
  }

  _unmount() {
    if (this._keyHandler) {
      document.removeEventListener("keydown", this._keyHandler);
      this._keyHandler = null;
    }
    if (this._overlay && this._overlay.parentNode) {
      this._overlay.parentNode.removeChild(this._overlay);
    }
    this._overlay = null;
  }

  _escape(s) {
    return String(s)
      .replace(/&/g, "&amp;")
      .replace(/</g, "&lt;")
      .replace(/>/g, "&gt;")
      .replace(/"/g, "&quot;");
  }
}

export const duplicateTicketModal = new DuplicateTicketModal();
