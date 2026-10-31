import { staffStore } from './staff-store.js';
import { userStore } from './user-store.js';
import { createDictSelect } from './components/dict-select.js';
import { createStaffSelect } from './components/staff-select.js';
import { logHistoryAction } from './history-logger.js';
import { createValidatedTextarea } from './components/validated-textarea.js';
import { createRepairTimePicker } from './components/repair-time-picker.js';
import { initVoiceTextarea, destroyVoiceInput } from './components/voiceInput.js';
import { notify } from './components/notify.js';
import { VALIDATION, UI, BUSINESS } from './config.js';
import { appState } from './app-state.js';
import { escapeHtml } from './utils/escape-html.js';
import { offlineDB } from './offline-db.js';
import { nowTs, formatTs } from './utils/date-utils.js';
import { authStore } from './auth-store.js'; // Добавлено для fallback user_id

const CAPS_REGEX = VALIDATION.CAPS_REGEX;
const MIN_SOLUTION_LEN = VALIDATION.MIN_SOLUTION_LEN;
const AUTO_RETURN_MS = UI.AUTO_RETURN_MS;
const ERROR_UNLOCK_MS = UI.ERROR_UNLOCK_MS;
const NOTIFY_CHANNELS = BUSINESS.NOTIFY_CHANNELS;
const ACCEPT_CHANNEL = BUSINESS.ACCEPT_CHANNEL;

// Вспомогательный метод для красивого текста статуса (для закрытых заявок)
function getStatusWord(status) {
    if (!status) return 'не уведомлен';
    const ch = NOTIFY_CHANNELS[status];
    if (!ch) return 'не уведомлен';
    return ch.replace(/[^\wа-яё\s]/gi, '').trim().toLowerCase();
}

// Безопасный рендер HTML для full_history (форматирует timestamp и чистит XSS)
function formatFullHistory(rawHtml) {
    if (!rawHtml) return '';
    let formatted = rawHtml.replace(/\b(\d{10})\b/g, (match) => formatTs(match));
    const parser = new DOMParser();
    const doc = parser.parseFromString(formatted, 'text/html');
    doc.querySelectorAll('script, iframe, object, embed').forEach(el => el.remove());
    doc.querySelectorAll('*').forEach(el => {
        Array.from(el.attributes).forEach(attr => {
            if (attr.name.startsWith('on') || attr.value.includes('javascript:')) {
                el.removeAttribute(attr.name);
            }
        });
    });
    return doc.body.innerHTML;
}

export class DetailsController {
    constructor(apiInstance, routerInstance) {
        this.api = apiInstance;
        this.router = routerInstance;
        this.currentTicketId = null;
        this.ticket = null;
        this.deptSelect = null;
        this.reqSelect = null;
        this.groupSelect = null;
        this.pendingChanges = {};
        this.mode = 'view';
        this.autoReturnTimer = null;

        this._staffChangedInSession = false;
        this._autoOpenPending = false;
        this._ticketSnapshot = null;
    }

    async mount(ticketId, combinedTicketsArray = []) {
        this.currentTicketId = ticketId;
        this.pendingChanges = {};
        this.mode = 'view';

        const container = document.getElementById('ticketDetailsDynamicContainer');
        if (!container) return;

        if (String(ticketId).startsWith('offline_')) {
            const outbox = await offlineDB.getAllFromOutbox();
            const found = outbox.find(o => o.uuid === ticketId);
            if (found) {
                this.ticket = {
                    ...found.payload,
                    id: found.uuid,
                    isOffline: true,
                    date: found.created_at
                };
                this._renderCard(container);
                return;
            }
        }

        let ticket = combinedTicketsArray.find(t => String(t.id) === String(ticketId));
        if (!ticket) {
            ticket = await this._fetchTicketFromServer(ticketId);
            if (this.currentTicketId !== ticketId) return;
        }

        if (!ticket) {
            this._render404(container, ticketId);
            return;
        }

        this.ticket = ticket;
        this._renderCard(container);
    }

    // ИСПРАВЛЕНО: Добавлены поля ID ('staff_id', 'staff_id2', 'staff_id3')
    async _refreshTicketAfterSave() {
        try {
            const fresh = await this._fetchTicketFromServer(this.ticket.id);
            if (!fresh) return;

            const fields = [
                'staff_id',    'staff_name',  'staff_phone',  'notify_status',  'notify_date',
                'staff_id2',   'staff_name2', 'staff_phone2', 'notify_status2', 'notify_date2',
                'staff_id3',   'staff_name3', 'staff_phone3', 'notify_status3', 'notify_date3'
            ];
            fields.forEach(key => {
                if (key in fresh) this.ticket[key] = fresh[key];
            });

            this._renderStaffSlots();
        } catch (err) {
            console.error('[DetailsController] Refresh after save error:', err);
        }
    }

    async _fetchTicketFromServer(ticketId) {
        try {
            const openData = await this.api.post({ data: 'open' }, 'Загрузка карточки №' + ticketId + '...', 'details');
            if (openData && openData.code === 'aborted') return null;
            if (Array.isArray(openData)) {
                const found = openData.find(t => String(t.id) === String(ticketId));
                if (found) { found.type = 'open'; return found; }
            }
            const closeData = await this.api.post({ data: 'close', period: '7' }, 'Поиск в архиве...', 'details');
            if (closeData && closeData.code === 'aborted') return null;
            if (Array.isArray(closeData)) {
                const found = closeData.find(t => String(t.id) === String(ticketId));
                if (found) { found.type = 'close'; return found; }
            }
        } catch (err) {
            console.error('[DetailsController] Ошибка загрузки с сервера:', err);
        }
        return null;
    }

    _getTicketSnapshotKeys() {
        return [
            'details', 'repair_time',
            'department_id', 'department', 'request_id', 'request', 'group_id', 'group',
            'solution',
            'staff_id',   'staff_name',   'staff_phone',   'notify_status',   'notify_date',
            'staff_id2',  'staff_name2',  'staff_phone2',  'notify_status2',  'notify_date2',
            'staff_id3',  'staff_name3',  'staff_phone3',  'notify_status3',  'notify_date3'
        ];
    }

    _render404(container, ticketId) {
        container.innerHTML = `
            <div class="error-card" style="padding: 2rem; text-align: center; background: var(--bg-secondary); border: 2px solid var(--border-color); border-radius: 12px; max-width: 500px; margin: 2rem auto;">
                <h2 style="color: #ef4444;">Инцидент №${escapeHtml(ticketId)} не найден</h2>
                <p style="color: var(--text-secondary); margin: 1rem 0;">Возможно, заявка удалена или введён неверный номер.</p>
                <button class="menu-item active" id="backToTableBtn" style="border: none; padding: 8px 16px; border-radius: 8px; cursor: pointer;">Вернуться в журнал</button>
            </div>`;
        const btn = document.getElementById('backToTableBtn');
        if (btn) btn.onclick = () => this.router.navigate('#/');
    }

    _renderCard(container) {
        const t = this.ticket;
        const isOffline = t.isOffline === true;
        const isOpen = t.type !== 'close';
        const isClosed = t.type === 'close';

        const isAssigned = userStore.isAssignedTo(t, userStore.userId);
        const canEdit = userStore.can('add_details', { isAssigned });
        const canClose = isOpen && (
            userStore.can('close_ticket', { isAssigned }) ||
            Number(t.closureallowed) === 1
        );

        const statusLabel = isOpen ? 'В РАБОТЕ' : 'ЗАКРЫТА';
        const statusBg = isOpen ? 'rgba(239,68,68,0.15)' : 'rgba(34,197,94,0.15)';
        const statusColor = isOpen ? '#ef4444' : '#22c55e';

        container.innerHTML = `
            <div class="ticket-card-layout-grid">
                <div class="ticket-info-panel" style="background: var(--bg-secondary); border: 2px solid var(--border-color); border-radius: 12px; padding: 1.25rem 1rem 0.75rem; display: flex; flex-direction: column; gap: 0.75rem; overflow: visible; height: 100%; min-height: 0; position: relative;">
                    <div style="position: absolute; top: 0; left: 0; right: 0; transform: translateY(-50%); display: flex; justify-content: space-between; align-items: center; padding: 0 1.25rem; gap: 8px; z-index: 5;">
                        <h2 style="font-size: 1.1rem; font-weight: 700; background: var(--bg-primary); padding: 0 0.5rem; line-height: 1; margin: 0;">Заявка №${escapeHtml(t.id)}</h2>
                        <span style="font-size: 11px; font-weight: 700; padding: 2px 10px; border-radius: 20px; background: ${statusBg}; color: ${statusColor}; border: 2px solid var(--bg-primary);">${statusLabel}</span>
                    </div>

                    <div class="info-group" style="flex-shrink: 0;">
                        <label style="font-size: 11px; font-weight: 700; color: var(--text-secondary); text-transform: uppercase;">📍 Адрес объекта</label>
                        <div style="font-size: 15px; font-weight: 600; margin-top: 2px; white-space: normal;">${escapeHtml(t.fullAddress || t.address || '—')}</div>
                    </div>

                    ${isOffline ? `
                    <div style="background: rgba(245, 158, 11, 0.15); border: 1px solid #f59e0b; border-radius: 8px; padding: 10px; color: #d97706; font-size: 13px; font-weight: 600; text-align: center; margin-top: 5px;">
                        ⏳ Заявка ожидает синхронизации с сервером. Редактирование недоступно.
                    </div>` : ''}
                        
                    <div id="ticketScrollArea" style="flex: 1 1 auto; min-height: 0; overflow-y: auto; display: flex; flex-direction: column; gap: 1rem; padding-right: 6px;">
                        <div id="ticketBodyBlock" style="display: flex; flex-direction: column; gap: 1rem;">
                            <div class="info-group">
                                <label style="font-size: 11px; font-weight: 700; color: var(--text-secondary); text-transform: uppercase;">🚨 Описание проблемы</label>
                                <div id="detailsDisplay" style="font-size: 14px; margin-top: 2px; background: var(--bg-primary); padding: 10px; border-radius: 8px; border: 1px solid var(--border-color); white-space: pre-wrap;">${escapeHtml(t.details || 'Описание отсутствует.')}</div>
                                <div id="detailsAddBlock" style="display: none; margin-top: 8px;">
                                    <textarea id="newDetailsInput" class="search-input editable-field" rows="3" placeholder="Введите дополнение к описанию..." style="width: 100%; resize: vertical; font-family: inherit;"></textarea>
                                    <div id="capsWarnDetails" style="display: none; color: #ef4444; font-size: 12px; margin-top: 4px;">⚠️ Слишком много заглавных букв подряд (максимум 4)</div>
                                    <button id="addDetailsBtn" class="menu-item" style="margin-top: 6px; padding: 6px 12px; border-radius: 6px; border: 1px solid var(--border-color); background: var(--bg-primary); color: var(--text-primary); cursor: pointer;">+ Добавить описание заявки</button>
                                </div>
                            </div>

                            <div class="info-group" id="staffAssignmentsBlock">
                                <label style="font-size: 11px; font-weight: 700; color: var(--text-secondary); text-transform: uppercase;">👷 Ответственные</label>
                                <div id="staffSlotsContainer" style="display: flex; flex-direction: column; gap: 8px; margin-top: 6px;"></div>
                            </div>

                            <div style="display: grid; grid-template-columns: 1fr 1fr; gap: 1rem;">
                                <div class="info-group">
                                    <label style="font-size: 11px; font-weight: 700; color: var(--text-secondary); text-transform: uppercase;">📅 Дата регистрации</label>
                                    <div style="font-size: 14px; margin-top: 2px;">${formatTs(t.date)}</div>
                                </div>
                                <div class="info-group">
                                    <label style="font-size: 11px; font-weight: 700; color: var(--text-secondary); text-transform: uppercase;">🛠 Дата ремонта</label>
                                    <div id="repairTimeDisplay" style="font-size: 14px; margin-top: 2px;">${formatTs(t.repair_time)}</div>
                                    <div id="repairTimeEditBlock" style="display: none; margin-top: 6px;"></div>
                                </div>
                            </div>

                            <div style="display: flex; flex-direction: column; gap: 1rem;">
                                <div class="info-group">
                                    <label style="font-size: 11px; font-weight: 700; color: var(--text-secondary); text-transform: uppercase;">🏢 Отдел</label>
                                    <div id="deptDisplay" style="font-size: 14px; margin-top: 2px;">${escapeHtml(t.department || '—')}</div>
                                    <div id="deptEditBlock" style="display: none; margin-top: 6px;"></div>
                                </div>
                                <div class="info-group">
                                    <label style="font-size: 11px; font-weight: 700; color: var(--text-secondary); text-transform: uppercase;">📋 Тип запроса</label>
                                    <div id="reqDisplay" style="font-size: 14px; margin-top: 2px;">${escapeHtml(t.request || '—')}</div>
                                    <div id="reqEditBlock" style="display: none; margin-top: 6px;"></div>
                                </div>
                                <div class="info-group">
                                    <label style="font-size: 11px; font-weight: 700; color: var(--text-secondary); text-transform: uppercase;">📦 Группа</label>
                                    <div id="groupDisplay" style="font-size: 14px; margin-top: 2px;">${escapeHtml(t.group || '—')}</div>
                                    <div id="groupEditBlock" style="display: none; margin-top: 6px;"></div>
                                </div>
                            </div>

                            ${isClosed ? `
                            <div class="info-group" style="border-top: 1px dashed var(--border-color); padding-top: 1rem;">
                                <label style="font-size: 11px; font-weight: 700; color: #22c55e; text-transform: uppercase;">✅ Принятое решение</label>
                                <div style="font-size: 14px; margin-top: 2px; font-weight: 500; white-space: pre-wrap;">${escapeHtml(t.solution || '—')}</div>
                                
                                <div style="font-size: 13px; color: var(--text-secondary); margin-top: 8px;">
                                    Закрыл: <b>${escapeHtml(t.close_name || '—')}</b> · ${formatTs(t.close_date)}
                                </div>

                                ${(userStore.isAdmin() && t.full_history) ? `
                                <details style="margin-top: 12px; border: 1px solid var(--border-color); border-radius: 6px; background: var(--bg-primary);">
                                    <summary style="cursor: pointer; font-size: 12px; font-weight: 600; padding: 8px 12px; user-select: none; outline: none;">📜 Показать полную историю</summary>
                                    <div style="font-size: 12px; padding: 0 12px 12px; white-space: pre-wrap; color: var(--text-secondary);">${formatFullHistory(t.full_history)}</div>
                                </details>
                                ` : ''}
                            </div>` : ''}
                        </div>

                        <div id="closeBlock" style="display: none; border-top: 1px dashed var(--border-color); padding-top: 1rem;">
                            <label style="font-size: 11px; font-weight: 700; color: #22c55e; text-transform: uppercase;">🔒 Решение по заявке</label>
                            <textarea id="solutionInput" class="search-input" rows="3" placeholder="Опишите, что было сделано (минимум ${MIN_SOLUTION_LEN} символов)..." style="width: 100%; resize: vertical; margin-top: 4px; font-family: inherit;"></textarea>
                            <div id="capsWarnSolution" style="display: none; color: #ef4444; font-size: 12px; margin-top: 4px;">⚠️ Слишком много заглавных букв подряд (максимум 4)</div>

                            <label id="closeAndCreateWrap" class="editable-field editable-field--checkbox" style="display: inline-flex; align-items: center; gap: 8px; margin-top: 10px; cursor: pointer; font-size: 13px; width: fit-content;">
                                <input type="checkbox" id="closeAndCreateCheck" style="cursor: pointer;">
                                <span>Закрыть и создать новую для этого объекта</span>
                            </label>
                        </div>
                        <div id="editErrorBanner" style="display: none; padding: 8px 12px; background: rgba(239,68,68,0.1); border: 1px solid #ef4444; border-radius: 8px; color: #ef4444; font-size: 13px;"></div>
                    </div>

                    <div class="ticket-actions-footer">
                        <button class="menu-item" id="backBtn" style="border: 2px solid var(--border-color); background: var(--bg-primary); color: var(--text-primary); padding: 10px; border-radius: 8px; cursor: pointer; font-weight: 600;">← Вернуться в журнал</button>
                        ${(!isOffline && isOpen && canEdit) ? `<button class="menu-item" id="editBtn" style="border: 2px solid var(--border-color); background: var(--bg-primary); color: var(--text-primary); padding: 10px; border-radius: 8px; cursor: pointer; font-weight: 600;">✏️ Редактировать</button>` : ''}
                        ${(!isOffline && canClose)  ? `<button class="menu-item" id="closeBtn" style="border: 2px solid var(--border-color); background: var(--bg-primary); color: var(--text-primary); padding: 10px; border-radius: 8px; cursor: pointer; font-weight: 600;">🔒 Закрыть заявку</button>` : ''}

                        <button class="menu-item " id="saveBtn" hidden disabled style="border: none; background: var(--accent); color: var(--mark-text); padding: 10px; border-radius: 8px; cursor: pointer; font-weight: 700;">Сохранить</button>
                        <button class="menu-item hide-action-btn" id="cancelEditBtn" style="border: 2px solid var(--border-color); background: var(--bg-primary); color: var(--text-primary); padding: 10px; border-radius: 8px; cursor: pointer; font-weight: 600;">Отмена</button>
                    </div>
                </div>

                <div class="ticket-notes-panel" style="background: var(--bg-secondary); border: 2px solid var(--border-color); border-radius: 12px; padding: 1.5rem; display: flex; flex-direction: column; min-height: 0; height: 100%; overflow: visible;">
                    <h3 style="font-size: 1.25rem; border-bottom: 2px solid var(--border-color); padding-bottom: 0.75rem; margin-bottom: 1rem; display: flex; align-items: center; justify-content: space-between; flex-shrink: 0;">
                        <span>📝 Комментарии к заявке</span>
                        <span id="notesCountBadge" style="font-size: 12px; background: var(--border-color); padding: 2px 8px; border-radius: 10px; font-weight: 600;">0</span>
                    </h3>
                    <div id="notesContainerDOM" style="flex: 1; overflow-y: auto; display: flex; flex-direction: column; gap: 10px; padding-right: 5px; margin-bottom: 8px; min-height: 0;"></div>

                    ${userStore.can('add_note', { isAssigned: userStore.isAssignedTo(t, userStore.userId) }) ? `
                    <div id="noteComposer" style="border-top: 1px dashed var(--border-color); padding-top: 10px; flex-shrink: 0;"></div>
                    ` : ''}
                </div>
            </div>
        `;

        this._renderStaffSlots();
        this._renderNotesList(t.note || []);
        this._renderNoteComposer();
        this._bindEvents();
    }

    _getStaffSlots() {
        const t = this.ticket;
        return [
            { slot: 1, id: t.staff_id, name: t.staff_name, notifyStatus: t.notify_status, notifyDate: t.notify_date },
            { slot: 2, id: t.staff_id2, name: t.staff_name2, notifyStatus: t.notify_status2, notifyDate: t.notify_date2 },
            { slot: 3, id: t.staff_id3, name: t.staff_name3, notifyStatus: t.notify_status3, notifyDate: t.notify_date3 }
        ];
    }

    _slotLabel(slotNumber) {
        if (slotNumber === 1) return 'Ответственный 1';
        return 'Доп. ответственный ' + slotNumber;
    }

    _renderStaffSlots() {
        const container = document.getElementById('staffSlotsContainer');
        if (!container) return;

        if (this.ticket.type === 'close') {
            const slots = this._getStaffSlots().filter(s => s.id);
            if (slots.length === 0) {
                container.innerHTML = '<div style="font-size: 13px; color: var(--text-secondary); font-style: italic;">Нет данных об ответственных</div>';
                return;
            }
            const list = document.createElement('div');
            list.style.cssText = 'font-size: 14px; line-height: 1.6; font-weight: 500; color: var(--text-primary);';
            slots.forEach(slot => {
                const status = getStatusWord(slot.notifyStatus);
                const div = document.createElement('div');
                div.textContent = `• ${slot.name} (${status})`;
                list.appendChild(div);
            });
            container.innerHTML = '';
            container.appendChild(list);
            return;
        }

        if (this.currentStaffSelect && typeof this.currentStaffSelect.destroy === 'function') {
            this.currentStaffSelect.destroy();
            this.currentStaffSelect = null;
        }

        container.innerHTML = '';

        const slots = this._getStaffSlots();
        const isOpen = this.ticket.type !== 'close';
        const isEdit = this.mode === 'edit';
        const isAdmin = userStore.isAdmin();
        const canAssign = isOpen && userStore.can('assign_staff');
        const isSessionLocked = this._staffChangedInSession;
        const isGridLocked = !!document.querySelector('.ticket-card-layout-grid.card-locked');

        const filled = slots.map((slot, idx) => {
            const keyId = 'staff_id' + (idx === 0 ? '' : (idx + 1));
            if (keyId in this.pendingChanges) {
                return !!this.pendingChanges[keyId];
            }
            return !!slot.id;
        });

        const visible = slots.map((_, idx) => {
            if (filled[idx]) return true;
            for (let i = 0; i < idx; i++) {
                if (!filled[i]) return false;
            }
            return true;
        });

        let firstEmptyIdx = -1;
        for (let i = 0; i < slots.length; i++) {
            if (visible[i] && !filled[i]) { firstEmptyIdx = i; break; }
        }

        slots.forEach((slot, idx) => {
            if (!visible[idx]) return;
            const slotNumber = idx + 1;

            if (filled[idx]) {
                this._renderFilledSlot(container, slot, slotNumber, { isOpen, isEdit, isAdmin, canAssign, isGridLocked });
            } else {
                this._renderEmptySlot(container, slotNumber, idx, { isEdit, canAssign, isSessionLocked, isGridLocked, firstEmptyIdx });
            }
        });

        if (this._autoOpenPending && isEdit && firstEmptyIdx === 0 && canAssign && !isGridLocked) {
            this._autoOpenPending = false;
            setTimeout(() => this._openAssignForm(1), 0);
        }
    }

    _renderFilledSlot(container, slot, slotNumber, ctx) {
        const { isOpen, isEdit, isAdmin, canAssign, isGridLocked } = ctx;
        const suffix = slotNumber === 1 ? '' : slotNumber;

        const row = document.createElement('div');
        row.style.cssText = 'display: flex; flex-direction: column; gap: 4px; padding: 8px 10px; border-radius: 8px; border: 1px solid var(--border-color); background: var(--bg-primary);';

        const head = document.createElement('div');
        head.style.cssText = 'display: flex; justify-content: space-between; align-items: center; gap: 8px;';

        const phoneFromTicket = this.ticket['staff_phone' + suffix];
        const phone = phoneFromTicket || staffStore.getPhone(slot.id);

        const nameEl = document.createElement('span');
        nameEl.style.cssText = 'font-weight: 600; font-size: 14px;';
        nameEl.textContent = (slotNumber === 1 ? '★ ' : '· ') + (slot.name || '—');
        if (phone) {
            nameEl.title = '📞 ' + phone;
            nameEl.style.cursor = 'help';
        }
        head.appendChild(nameEl);

        const labelEl = document.createElement('span');
        labelEl.style.cssText = 'font-size: 11px; color: var(--text-secondary);';
        labelEl.textContent = this._slotLabel(slotNumber);
        head.appendChild(labelEl);

        row.appendChild(head);

        const status = document.createElement('div');
        status.style.cssText = 'font-size: 12px; color: var(--text-secondary);';
        const channel = NOTIFY_CHANNELS[slot.notifyStatus] || '— Не уведомлён —';

        if (!slot.notifyStatus) {
            status.textContent = '— Не уведомлён —';
        } else if (slot.notifyDate) {
            status.textContent = `${channel} · ${formatTs(slot.notifyDate)}`;
        } else {
            status.textContent = `${channel} · будет зафиксировано при сохранении`;
            status.style.fontStyle = 'italic';
            status.style.color = 'var(--accent)';
        }
        row.appendChild(status);

        const keyStaffId = 'staff_id' + suffix;
        const isNewlyAssigned = keyStaffId in this.pendingChanges;

        if (isEdit && (isAdmin || (isNewlyAssigned && canAssign))) {
            const notifyWrap = document.createElement('label');
            notifyWrap.className = 'editable-field editable-field--checkbox';
            notifyWrap.style.cssText = 'display: inline-flex; align-items: center; gap: 8px; margin-top: 6px; cursor: pointer; font-size: 12px; width: fit-content;';

            const cb = document.createElement('input');
            cb.type = 'checkbox';
            cb.style.cursor = 'pointer';
            cb.checked = slot.notifyStatus === 1;

            const txt = document.createElement('span');
            txt.textContent = 'Уведомлён по телефону';

            cb.onchange = () => {
                const keyNotify = 'notify_status' + suffix;
                const keyNotifyDate = 'notify_date' + suffix;
                if (cb.checked) {
                    this.pendingChanges[keyNotify] = 1;
                    this.ticket[keyNotify] = 1;
                    this.ticket[keyNotifyDate] = nowTs();
                } else {
                    this.pendingChanges[keyNotify] = 0;
                    this.ticket[keyNotify] = 0;
                    this.ticket[keyNotifyDate] = null;
                }
                this._renderStaffSlots();
                this._updateSaveButtonState();
            };

            notifyWrap.appendChild(cb);
            notifyWrap.appendChild(txt);
            row.appendChild(notifyWrap);
        }

        const canReplace = isEdit && !isGridLocked && (isAdmin || (isNewlyAssigned && canAssign));
        const canUnassign = isEdit && !isGridLocked && isAdmin;

        if (canReplace || canUnassign) {
            const actionsRow = document.createElement('div');
            actionsRow.style.cssText = 'display: flex; gap: 6px; margin-top: 6px;';

            if (canReplace) {
                const replaceBtn = document.createElement('button');
                replaceBtn.textContent = '✏️ Заменить';
                replaceBtn.style.cssText = 'padding: 4px 10px; border-radius: 6px; border: 1px solid var(--border-color); background: var(--bg-secondary); color: var(--text-primary); cursor: pointer; font-size: 11px;';
                replaceBtn.onclick = () => this._openReplaceForm(slotNumber);
                actionsRow.appendChild(replaceBtn);
            }

            if (canUnassign) {
                const unassignBtn = document.createElement('button');
                unassignBtn.textContent = '× Снять';
                unassignBtn.style.cssText = 'padding: 4px 10px; border-radius: 6px; border: 1px solid #ef4444; background: transparent; color: #ef4444; cursor: pointer; font-size: 11px;';
                unassignBtn.onclick = () => this._onUnassignStaff(slotNumber);
                actionsRow.appendChild(unassignBtn);
            }

            row.appendChild(actionsRow);
        }

        const isMySlot = String(slot.id) === String(userStore.userId);
        if (isOpen && isMySlot && !slot.notifyStatus && userStore.isEngineer()) {
            const acceptBtn = document.createElement('button');
            acceptBtn.textContent = '✓ Принял в работу (WEB)';
            acceptBtn.style.cssText = 'margin-top: 4px; padding: 6px 10px; border-radius: 6px; border: 1px solid var(--accent); background: transparent; color: var(--accent); cursor: pointer; font-size: 12px; font-weight: 600;';
            acceptBtn.onclick = () => this._onAcceptAssignment(slotNumber);
            row.appendChild(acceptBtn);
        }

        container.appendChild(row);
    }

    _renderEmptySlot(container, slotNumber, idx, ctx) {
        const { isEdit, canAssign, isSessionLocked, isGridLocked, firstEmptyIdx } = ctx;

        const row = document.createElement('div');
        row.classList.add('staff-slot-empty');
        row.style.cssText = 'display: flex; flex-direction: column; gap: 4px; padding: 8px 10px; border-radius: 8px; border: 1px solid var(--border-color); background: var(--bg-primary);';

        const head = document.createElement('div');
        head.style.cssText = 'display: flex; justify-content: space-between; align-items: center; gap: 8px;';
        head.innerHTML = `
            <span style="font-size: 13px; font-weight: 600; color: var(--text-secondary);">${this._slotLabel(slotNumber)}</span>
            <span class="staff-slot-empty-label" style="font-size: 11px; font-style: italic;">не назначен</span>
        `;
        row.appendChild(head);

        const canAddHere =
            isEdit && canAssign && !isSessionLocked && !isGridLocked &&
            idx === firstEmptyIdx;

        if (canAddHere) {
            const addBtn = document.createElement('button');
            addBtn.textContent = '+ Добавить';
            addBtn.style.cssText = 'margin-top: 4px; padding: 6px 10px; border-radius: 6px; border: 1px solid var(--border-color); background: var(--bg-secondary); color: var(--text-primary); cursor: pointer; font-size: 12px;';
            addBtn.onclick = () => this._openAssignForm(slotNumber);
            row.appendChild(addBtn);
        }

        container.appendChild(row);
    }

    // ИСПРАВЛЕНО: Чистая очистка полей по контракту API v4.0
    _onUnassignStaff(slotNumber) {
        const suffix = slotNumber === 1 ? '' : slotNumber;
        const keyId = 'staff_id' + suffix;
        const keyName = 'staff_name' + suffix;
        const keyPhone = 'staff_phone' + suffix;
        const keyNotify = 'notify_status' + suffix;
        const keyNotifyDate = 'notify_date' + suffix;

        this.pendingChanges[keyId] = null;
        this.pendingChanges[keyNotify] = 0;
        this._staffChangedInSession = true;

        this.ticket[keyId] = null;
        this.ticket[keyName] = null;
        this.ticket[keyPhone] = null;
        this.ticket[keyNotify] = null;
        this.ticket[keyNotifyDate] = null;

        this._renderStaffSlots();
        this._updateSaveButtonState();
    }

    _openReplaceForm(slotNumber) {
        this._openAssignForm(slotNumber);
    }

    _openAssignForm(slotNumber) {
        const slots = this._getStaffSlots();
        const busyIds = slots
            .filter(s => s.slot !== slotNumber && s.id)
            .map(s => s.id);

        const rowIdx = slotNumber - 1;
        const container = document.getElementById('staffSlotsContainer');
        const row = container.children[rowIdx];
        if (!row) return;

        if (this.currentStaffSelect && typeof this.currentStaffSelect.destroy === 'function') {
            this.currentStaffSelect.destroy();
        }

        row.innerHTML = '';

        const notifyWrap = document.createElement('label');
        notifyWrap.className = 'editable-field editable-field--checkbox';
        notifyWrap.style.cssText = 'display: none; align-items: center; gap: 8px; margin-top: 6px; cursor: pointer; font-size: 13px;';

        const notifyCheck = document.createElement('input');
        notifyCheck.type = 'checkbox';
        notifyCheck.style.cursor = 'pointer';

        const notifyText = document.createElement('span');
        notifyText.textContent = 'Уведомлён по телефону';

        notifyWrap.appendChild(notifyCheck);
        notifyWrap.appendChild(notifyText);

        const staffSelect = createStaffSelect({
            list: staffStore.list,
            excludeIds: busyIds,
            placeholder: 'Начните вводить имя...',
            onSelect: (staff) => {
                const suffix = slotNumber === 1 ? '' : slotNumber;
                const keyId = 'staff_id' + suffix;
                const isNewOrReassign = !this.ticket[keyId] || (keyId in this.pendingChanges);

                if (staff && isNewOrReassign) {
                    notifyWrap.style.display = 'inline-flex';
                } else {
                    notifyWrap.style.display = 'none';
                    notifyCheck.checked = false;
                }
            }
        });
        this.currentStaffSelect = staffSelect;

        const confirmBtn = document.createElement('button');
        confirmBtn.textContent = 'Подтвердить';
        confirmBtn.style.cssText = 'margin-top: 6px; padding: 6px 10px; border-radius: 6px; border: none; background: var(--accent); color: var(--mark-text); cursor: pointer; font-size: 12px; font-weight: 600;';

        // ИСПРАВЛЕНО: Запись строго по новому API v4.0 + защита ID от NaN
        confirmBtn.onclick = () => {
            const selectedId = staffSelect.getValue();
            if (!selectedId) return;

            const suffix = slotNumber === 1 ? '' : slotNumber;
            const keyId = 'staff_id' + suffix;
            const keyNotify = 'notify_status' + suffix;
            const keyNotifyDate = 'notify_date' + suffix;
            const keyName = 'staff_name' + suffix;

            // Безопасное сохранение типа идентификатора (число или строка)
            const finalId = isNaN(selectedId) ? selectedId : Number(selectedId);

            this.pendingChanges[keyId] = finalId;

            if (notifyCheck.checked) {
                this.pendingChanges[keyNotify] = 1;
                this.ticket[keyNotify] = 1;
                this.ticket[keyNotifyDate] = nowTs();
            }

            this.ticket[keyId] = finalId;
            this.ticket[keyName] = staffStore.getById(selectedId)?.name || null;

            this._staffChangedInSession = true;
            this._autoOpenPending = false;

            staffSelect.destroy();
            this.currentStaffSelect = null;

            this._renderStaffSlots();
            this._updateSaveButtonState();
        };

        const cancelBtn = document.createElement('button');
        cancelBtn.textContent = 'Отмена';
        cancelBtn.style.cssText = 'margin-top: 6px; margin-left: 6px; padding: 6px 10px; border-radius: 6px; border: 1px solid var(--border-color); background: var(--bg-secondary); color: var(--text-primary); cursor: pointer; font-size: 12px;';
        cancelBtn.onclick = () => {
            staffSelect.destroy();
            this.currentStaffSelect = null;
            this._renderStaffSlots();
        };

        row.appendChild(staffSelect.element);
        row.appendChild(notifyWrap);
        row.appendChild(confirmBtn);
        row.appendChild(cancelBtn);

        setTimeout(() => staffSelect.focus(), 30);
    }

    async _onAcceptAssignment(slotNumber) {
        const keyNotify = 'notify_status' + (slotNumber === 1 ? '' : slotNumber);
        const keyNotifyDate = 'notify_date' + (slotNumber === 1 ? '' : slotNumber);
        const payload = {
            action: 'calledit',
            call_id: this.ticket.id,
            [keyNotify]: ACCEPT_CHANNEL
        };

        try {
            const response = await this.api.post(payload, 'Отметка «Принял в работу»...', 'details');
            if (response && response.status === 'ok') {
                this.ticket[keyNotify] = ACCEPT_CHANNEL;
                this.ticket[keyNotifyDate] = nowTs();
                this._renderStaffSlots();
                const msg = response.message || 'Статус уведомления обновлён.';
                logHistoryAction(msg);
                notify.success(msg);
            } else {
                const msg = (response && response.message) || 'Не удалось обновить статус.';
                logHistoryAction(msg);
                notify.error(msg);
            }
        } catch (err) {
            console.error('[DetailsController] Accept error:', err);
            logHistoryAction('Сбой сети при отметке «Принял в работу».');
            notify.error('Не удалось обновить статус. Проверьте соединение.');
        }
    }

    _bindEvents() {
        const $ = id => document.getElementById(id);

        $('backBtn').onclick = () => this.router.navigate(this.ticket.type === 'close' ? '#/closed' : '#/');

        const editBtn = $('editBtn');
        if (editBtn) editBtn.onclick = () => this._enterEditMode();

        const closeBtn = $('closeBtn');
        if (closeBtn) closeBtn.onclick = () => this._enterCloseMode();

        $('cancelEditBtn').onclick = () => this._exitEditMode();

        const addDetailsBtn = $('addDetailsBtn');
        if (addDetailsBtn) addDetailsBtn.onclick = () => this._onAddDescription();

        const newDetailsInput = $('newDetailsInput');
        if (newDetailsInput) {
            newDetailsInput.oninput = () => this._checkCaps(newDetailsInput.value, $('capsWarnDetails'));
        }

        const solutionInput = $('solutionInput');
        if (solutionInput) {
            solutionInput.oninput = () => {
                this._checkCaps(solutionInput.value, $('capsWarnSolution'));
                this._updateSaveButtonState();
            };
        }

        $('saveBtn').onclick = () => this._onSave();
    }

    _enterEditMode() {
        this.mode = 'edit';

        this._ticketSnapshot = {};
        this._getTicketSnapshotKeys().forEach(k => {
            this._ticketSnapshot[k] = this.ticket[k] ?? null;
        });

        this._staffChangedInSession = false;
        this._autoOpenPending = (this.ticket.staff_id == null);

        document.getElementById('detailsAddBlock').style.display = 'block';
        document.getElementById('editBtn').style.display = 'none';
        const newDetailsInput = document.getElementById('newDetailsInput');
        if (newDetailsInput) initVoiceTextarea(newDetailsInput);
        const closeBtn = document.getElementById('closeBtn');
        if (closeBtn) closeBtn.style.display = 'none';
        document.getElementById('saveBtn').hidden = false;
        document.getElementById('cancelEditBtn').style.display = 'block';
        this._renderStaffSlots();

        const dictRules = [
            { key: 'department', action: 'change_department', idField: 'department_id', ref: 'deptSelect',  blockId: 'deptEditBlock',  currentValue: this.ticket.department_id },
            { key: 'request',    action: 'change_request',    idField: 'request_id',    ref: 'reqSelect',   blockId: 'reqEditBlock',   currentValue: this.ticket.request_id },
            { key: 'group',      action: 'change_group',      idField: 'group_id',      ref: 'groupSelect', blockId: 'groupEditBlock', currentValue: this.ticket.group_id }
        ];

        dictRules.forEach(rule => {
            if (!userStore.can(rule.action, { currentValue: rule.currentValue })) return;

            const block = document.getElementById(rule.blockId);
            if (!block) return;
            block.style.display = 'block';

            if (!this[rule.ref]) {
                const comp = createDictSelect({
                    key: rule.key,
                    initialValue: rule.currentValue || null,
                    placeholder: '— выберите —',
                    required: true,
                    onChange: (value) => {
                        if (value) {
                            this.pendingChanges[rule.idField] = String(value);
                        } else {
                            delete this.pendingChanges[rule.idField];
                        }
                        this._updateSaveButtonState();
                    }
                });
                block.innerHTML = '';
                block.appendChild(comp.element);
                this[rule.ref] = comp;
            }
        });

        const isAssigned = userStore.isAssignedTo(this.ticket, userStore.userId);
        if (userStore.can('set_repair_time', { isAssigned })) {
            const block = document.getElementById('repairTimeEditBlock');
            if (block) {
                block.style.display = 'block';
                if (!this.repairPicker) {
                    this.repairPicker = createRepairTimePicker({
                        initialValue: this.ticket.repair_time,
                        onChange: (value) => {
                            this.pendingChanges.repair_time = value;
                            this._updateSaveButtonState();
                        }
                    });
                    block.innerHTML = '';
                    block.appendChild(this.repairPicker.element);
                }
            }
        }

        this._updateSaveButtonState();
    }

    _enterCloseMode() {
        this.mode = 'close';

        const bodyBlock = document.getElementById('ticketBodyBlock');
        if (bodyBlock) bodyBlock.style.display = 'none';

        document.getElementById('closeBlock').style.display = 'block';
        const closeAndCreateCheck = document.getElementById('closeAndCreateCheck');
        if (closeAndCreateCheck) closeAndCreateCheck.checked = false;

        const solutionInput = document.getElementById('solutionInput');
        if (solutionInput) initVoiceTextarea(solutionInput);

        document.getElementById('editBtn').style.display = 'none';
        const closeBtn = document.getElementById('closeBtn');
        if (closeBtn) closeBtn.style.display = 'none';
        document.getElementById('saveBtn').hidden = false;
        document.getElementById('cancelEditBtn').style.display = 'block';

        setTimeout(() => {
            const ta = document.getElementById('solutionInput');
            if (ta) ta.focus();
        }, 50);

        this._updateSaveButtonState();
    }

    _exitEditMode() {
        destroyVoiceInput();

        if (this._ticketSnapshot) {
            this._getTicketSnapshotKeys().forEach(k => {
                this.ticket[k] = this._ticketSnapshot[k];
            });
            this._ticketSnapshot = null;
        }

        this.pendingChanges = {};
        this.mode = 'view';
        this._staffChangedInSession = false;
        this._autoOpenPending = false;

        const bodyBlock = document.getElementById('ticketBodyBlock');
        if (bodyBlock) bodyBlock.style.display = 'flex';
        document.getElementById('detailsAddBlock').style.display = 'none';
        document.getElementById('closeBlock').style.display = 'none';
        document.getElementById('saveBtn').hidden = true;
        document.getElementById('cancelEditBtn').style.display = 'none';
        const editBtn = document.getElementById('editBtn');
        if (editBtn) editBtn.style.display = 'block';
        const closeBtn = document.getElementById('closeBtn');
        if (closeBtn) closeBtn.style.display = 'block';

        const newDetailsInput = document.getElementById('newDetailsInput');
        if (newDetailsInput) newDetailsInput.value = '';
        const solutionInput = document.getElementById('solutionInput');
        if (solutionInput) solutionInput.value = '';
        const capsWarnDetails = document.getElementById('capsWarnDetails');
        if (capsWarnDetails) capsWarnDetails.style.display = 'none';
        const capsWarnSolution = document.getElementById('capsWarnSolution');
        if (capsWarnSolution) capsWarnSolution.style.display = 'none';

        const display = document.getElementById('detailsDisplay');
        if (display) display.textContent = this.ticket.details || 'Описание отсутствует.';

        // 1. Уничтожаем и зануляем пикер даты ремонта
        const repairBlock = document.getElementById('repairTimeEditBlock');
        if (repairBlock) {
            repairBlock.style.display = 'none';
            repairBlock.innerHTML = ''; // Очищаем DOM
        }
        if (this.repairPicker) {
            if (typeof this.repairPicker.destroy === 'function') this.repairPicker.destroy();
            this.repairPicker = null; // Зануляем ссылку
        }

        // 2. Уничтожаем и зануляем селекты справочников (Отдел, Тип, Группа)
        [
            { blockId: 'deptEditBlock',  ref: 'deptSelect',  displayId: 'deptDisplay',  field: 'department' },
            { blockId: 'reqEditBlock',   ref: 'reqSelect',   displayId: 'reqDisplay',   field: 'request' },
            { blockId: 'groupEditBlock', ref: 'groupSelect', displayId: 'groupDisplay', field: 'group' }
        ].forEach(item => {
            const block = document.getElementById(item.blockId);
            if (block) {
                block.style.display = 'none';
                block.innerHTML = ''; // Очищаем DOM
            }
            if (this[item.ref]) {
                if (typeof this[item.ref].destroy === 'function') this[item.ref].destroy();
                this[item.ref] = null; // Зануляем ссылку (это и исправляет баг)
            }
            const display = document.getElementById(item.displayId);
            if (display) display.textContent = this.ticket[item.field] || '—';
        });

        // 3. Уничтожаем селект выбора механика (если он был открыт)
        if (this.currentStaffSelect && typeof this.currentStaffSelect.destroy === 'function') {
            this.currentStaffSelect.destroy();
            this.currentStaffSelect = null;
        }

        const repairDisplay = document.getElementById('repairTimeDisplay');
        if (repairDisplay) repairDisplay.textContent = formatTs(this.ticket.repair_time);

        this._renderStaffSlots();
    }

    _onAddDescription() {
        const input = document.getElementById('newDetailsInput');
        const text = input.value.trim();
        if (!text || CAPS_REGEX.test(text)) return;

        const currentDetails = this.pendingChanges.details !== undefined
            ? this.pendingChanges.details
            : (this.ticket.details || '');

        const separator = currentDetails ? '\n\n' : '';
        this.pendingChanges.details = currentDetails + separator + '📝 Дополнение: ' + text;

        const display = document.getElementById('detailsDisplay');
        if (display) display.textContent = this.pendingChanges.details;

        input.value = '';
        this._updateSaveButtonState();
    }

    _checkCaps(text, warnEl) {
        const hasCaps = CAPS_REGEX.test(text);
        if (warnEl) warnEl.style.display = hasCaps ? 'block' : 'none';
        this._updateSaveButtonState();
    }

    _updateSaveButtonState() {
        const saveBtn = document.getElementById('saveBtn');
        if (!saveBtn || saveBtn.classList.contains('btn-loading') ||
            saveBtn.classList.contains('btn-success') ||
            saveBtn.classList.contains('btn-error')) return;

        const $ = id => document.getElementById(id);
        let enabled = false;

        if (this.mode === 'edit') {
            enabled = Object.keys(this.pendingChanges).length > 0;
            const newDetails = $('newDetailsInput');
            if (newDetails && CAPS_REGEX.test(newDetails.value)) enabled = false;
            if (this.repairPicker && !this.repairPicker.isValid()) enabled = false;
            if (this.deptSelect && !this.deptSelect.isValid()) enabled = false;
            if (this.reqSelect && !this.reqSelect.isValid()) enabled = false;
            if (this.groupSelect && !this.groupSelect.isValid()) enabled = false;
        } else if (this.mode === 'close') {
            const sol = $('solutionInput');
            const len = sol ? sol.value.trim().length : 0;
            enabled = len >= MIN_SOLUTION_LEN && !CAPS_REGEX.test(sol.value);
        }

        saveBtn.disabled = !enabled;
        saveBtn.style.opacity = enabled ? '1' : '0.5';
        saveBtn.style.cursor = enabled ? 'pointer' : 'not-allowed';
    }

    _setSaveBtnState(state) {
        const btn = document.getElementById('saveBtn');
        if (!btn) return;

        btn.classList.remove('btn-loading', 'btn-success', 'btn-error');

        if (state === 'loading') {
            btn.disabled = true;
            btn.classList.add('btn-loading');
            btn.textContent = '';
        } else if (state === 'success') {
            btn.disabled = true;
            btn.classList.add('btn-success');
            btn.textContent = '';
        } else if (state === 'error') {
            btn.disabled = true;
            btn.classList.add('btn-error');
            btn.textContent = '';
        } else {
            btn.textContent = 'Сохранить';
            this._updateSaveButtonState();
        }
    }

    _lockCard() {
        const grid = document.querySelector('.ticket-card-layout-grid');
        if (grid) grid.classList.add('card-locked');

        if (this.noteSubmitBtn) this.noteSubmitBtn.disabled = true;

        if (this.noteField && this.noteField.element) {
            const ta = this.noteField.element.querySelector('textarea');
            if (ta) ta.disabled = true;
        }
    }

    _unlockCard() {
        const grid = document.querySelector('.ticket-card-layout-grid');
        if (grid) grid.classList.remove('card-locked');

        if (this.noteField && this.noteField.element) {
            const ta = this.noteField.element.querySelector('textarea');
            if (ta) ta.disabled = false;
        }

        if (this.noteField && this.noteSubmitBtn) {
            const val = this.noteField.getValue();
            const valid = this.noteField.isValid();
            this.noteSubmitBtn.disabled = !valid || !val;
        }
    }

    async _onSave() {
        if (this.mode === 'edit' && Object.keys(this.pendingChanges).length === 0) return;

        let payload;

        if (this.mode === 'close') {
            const sol = document.getElementById('solutionInput');
            const solutionText = sol ? sol.value.trim() : '';
            const user = userStore.userId || (authStore.getUser()?.id || 0);

            payload = {
                action: 'callClose',
                call_id: this.ticket.id,
                solution: solutionText,
                user_id: user
            };
        } else {
            payload = {
                action: 'calledit',
                call_id: this.ticket.id,
                ...this.pendingChanges
            };
        }

        this._lockCard();
        this._setSaveBtnState('loading');

        try {
            const response = await this.api.post(payload, '', 'details');

            if (response && response.status === 'ok') {
                this._setSaveBtnState('success');
                const msg = response.message || 'Изменения сохранены.';
                logHistoryAction(msg);
                notify.success(msg);

                this._staffChangedInSession = false;
                this._autoOpenPending = false;
                this._ticketSnapshot = null;

                if (this.mode === 'close') {
                    const closeAndCreateCheck = document.getElementById('closeAndCreateCheck');
                    const shouldCreateNew = closeAndCreateCheck && closeAndCreateCheck.checked;

                    if (this.autoReturnTimer) clearTimeout(this.autoReturnTimer);

                    if (shouldCreateNew) {
                        const backBtn = document.getElementById('backBtn');
                        if (backBtn) backBtn.style.display = 'none';

                        const fromTicketId = this.ticket.id;
                        this.autoReturnTimer = setTimeout(() => {
                            appState.pendingCreateAddress = {
                                from_ticket_id: fromTicketId,
                                address:   this.ticket.fullAddress || this.ticket.address || '',
                                city_id:   this.ticket.city_id    || null,
                                street_id: this.ticket.street_id  || null,
                                home_id:   this.ticket.home_id    || null,
                                object_id: this.ticket.object_id  || null
                            };
                            this.router.navigate('#/create');
                        }, 3000);
                    } else {
                        this.autoReturnTimer = setTimeout(() => {
                            if (window.location.hash.startsWith('#/ticket/')) {
                                this.router.navigate('#/closed');
                            }
                        }, AUTO_RETURN_MS);
                    }
                } else {
                    this._refreshTicketAfterSave();
                    this._exitEditMode();

                    this.autoReturnTimer = setTimeout(() => {
                        if (window.location.hash.startsWith('#/ticket/')) {
                            this.router.navigate(this.ticket.type === 'close' ? '#/closed' : '#/');
                        }
                    }, AUTO_RETURN_MS);
                }
            } else {
                const msg = (response && response.message) || 'Не удалось сохранить изменения.';
                this._setSaveBtnState('error');
                logHistoryAction(msg);
                notify.error(msg);

                if (this.autoReturnTimer) clearTimeout(this.autoReturnTimer);
                this.autoReturnTimer = setTimeout(() => {
                    this._unlockCard();
                    this._setSaveBtnState('idle');
                }, ERROR_UNLOCK_MS);
            }
        } catch (err) {
            console.error('[DetailsController] Save error:', err);
            this._setSaveBtnState('error');
            const msg = 'Сбой сети при сохранении: ' + (err.message || 'неизвестная ошибка');
            logHistoryAction(msg);
            notify.error('Не удалось сохранить. Проверьте соединение.');

            if (this.autoReturnTimer) clearTimeout(this.autoReturnTimer);
            this.autoReturnTimer = setTimeout(() => {
                this._unlockCard();
                this._setSaveBtnState('idle');
            }, ERROR_UNLOCK_MS);
        }
    }

    _renderNotesList(notesData) {
        const containerDOM = document.getElementById('notesContainerDOM');
        const countBadge = document.getElementById('notesCountBadge');
        if (!containerDOM) return;

        const notesList = Array.isArray(notesData)
            ? notesData
            : (notesData && typeof notesData === 'object' ? Object.values(notesData) : []);

        if (countBadge) countBadge.textContent = notesList.length;

        if (notesList.length === 0) {
            containerDOM.innerHTML = `
                <div style="text-align: center; color: var(--text-secondary); margin: auto 0; padding: 2rem;">
                    <div style="font-size: 13px; font-weight: 500;">Комментарии к заявке отсутствуют</div>
                </div>`;
            return;
        }

        containerDOM.innerHTML = '';
        notesList.forEach(note => {
            const noteItem = document.createElement('div');
            const isAccent = String(note.type) === '1';
            noteItem.style.cssText = `
                background: ${isAccent ? 'rgba(138, 43, 226, 0.05)' : 'var(--bg-primary)'};
                border: 1px solid ${isAccent ? 'var(--accent)' : 'var(--border-color)'};
                border-radius: 8px;
                padding: 10px 12px;
                display: flex;
                flex-direction: column;
                gap: 4px;
            `;

            const header = document.createElement('div');
            header.style.cssText = 'display: flex; justify-content: space-between; align-items: center; border-bottom: 1px dashed var(--border-color); padding-bottom: 3px; margin-bottom: 2px;';

            const userSpan = document.createElement('span');
            userSpan.style.cssText = 'font-size: 12px; font-weight: 700;';
            userSpan.textContent = '👤 ' + (note.user || 'Сотрудник не указан');

            const dateSpan = document.createElement('span');
            dateSpan.style.cssText = 'font-size: 11px; color: var(--text-secondary); font-weight: 500;';
            dateSpan.textContent = '🕒 ' + formatTs(note.date);

            header.appendChild(userSpan);
            header.appendChild(dateSpan);

            const body = document.createElement('div');
            body.style.cssText = 'font-size: 13px; line-height: 1.4; white-space: pre-wrap; word-break: break-word;';
            body.textContent = note.body || 'Пустая заметка.';

            noteItem.appendChild(header);
            noteItem.appendChild(body);
            containerDOM.appendChild(noteItem);
        });
    }

    _renderNoteComposer() {
        const container = document.getElementById('noteComposer');
        if (!container) return;

        this.noteField = createValidatedTextarea({
            placeholder: 'Введите комментарий к заявке...',
            rows: 3,
            minLength: 1,
            voice: true,
            onChange: (value, isValid) => {
                if (this.noteSubmitBtn) {
                    this.noteSubmitBtn.disabled = !isValid || !value;
                    this.noteSubmitBtn.style.opacity = (!isValid || !value) ? '0.5' : '1';
                    this.noteSubmitBtn.style.cursor = (!isValid || !value) ? 'not-allowed' : 'pointer';
                }
            }
        });

        const submitBtn = document.createElement('button');
        submitBtn.textContent = 'Добавить комментарий';
        submitBtn.disabled = true;
        submitBtn.style.cssText = 'margin-top: 6px; padding: 8px 14px; border-radius: 6px; border: none; background: var(--accent); color: var(--mark-text); cursor: not-allowed; font-size: 13px; font-weight: 600; opacity: 0.5;';
        submitBtn.onclick = () => this._onAddNote();

        this.noteSubmitBtn = submitBtn;

        container.appendChild(this.noteField.element);
        container.appendChild(submitBtn);
    }

    async _onAddNote() {
        const text = this.noteField ? this.noteField.getValue() : '';
        if (!text) return;
        if (this.noteField && !this.noteField.isValid()) return;

        const payload = {
            action: 'callnote',
            call_id: this.ticket.id,
            note: text
        };

        const btn = this.noteSubmitBtn;
        if (btn) {
            btn.disabled = true;
            btn.textContent = 'Отправка...';
            btn.style.opacity = '0.7';
        }

        try {
            const response = await this.api.post(payload, '', 'details');

            if (response && response.status === 'ok') {
                const msg = response.message || 'Комментарий добавлен.';
                logHistoryAction(msg);
                notify.success(msg);

                const note = {
                    id: 'local_' + Date.now(),
                    user: 'Вы',
                    body: text,
                    date: nowTs(),
                    type: 0
                };

                if (Array.isArray(this.ticket.note)) {
                    this.ticket.note.push(note);
                } else if (this.ticket.note && typeof this.ticket.note === 'object') {
                    this.ticket.note[Object.keys(this.ticket.note).length + 1] = note;
                } else {
                    this.ticket.note = [note];
                }

                this._renderNotesList(this.ticket.note);
                this.noteField.reset();
                if (btn) {
                    btn.textContent = 'Добавить комментарий';
                    btn.disabled = true;
                    btn.style.opacity = '0.5';
                }
            } else {
                const msg = (response && response.message) || 'Не удалось добавить комментарий.';
                logHistoryAction(msg);
                notify.error(msg);
                if (btn) {
                    btn.textContent = 'Добавить комментарий';
                    btn.disabled = false;
                    btn.style.opacity = '1';
                }
            }
        } catch (err) {
            console.error('[DetailsController] AddNote error:', err);
            logHistoryAction('Сбой сети при добавлении комментария.');
            notify.error('Не удалось добавить комментарий. Проверьте соединение.');
            if (btn) {
                btn.textContent = 'Добавить комментарий';
                btn.disabled = false;
                btn.style.opacity = '1';
            }
        }
    }

    unmount() {
        this._staffChangedInSession = false;
        this._autoOpenPending = false;
        destroyVoiceInput();
        this._unlockCard();
        this.api.abortTag('details');

        if (this._ticketSnapshot && this.ticket) {
            this._getTicketSnapshotKeys().forEach(k => {
                this.ticket[k] = this._ticketSnapshot[k];
            });
            this._ticketSnapshot = null;
        }

        ['currentStaffSelect', 'repairPicker', 'deptSelect', 'reqSelect', 'groupSelect'].forEach(name => {
            const comp = this[name];
            if (comp && typeof comp.destroy === 'function') comp.destroy();
            this[name] = null;
        });
        if (this.autoReturnTimer) {
            clearTimeout(this.autoReturnTimer);
            this.autoReturnTimer = null;
        }
        if (this.noteField && typeof this.noteField.destroy === 'function') {
            this.noteField.destroy();
        }
        this.noteField = null;
        this.noteSubmitBtn = null;
        this.pendingChanges = {};
        this.mode = 'view';
        this.ticket = null;
        this.currentTicketId = null;
    }
}