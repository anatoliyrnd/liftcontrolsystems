/**
 * Контроллер экрана #/queue (API_syncCommands.md v5.4, ТЗ волна 2 §13.1).
 * Четыре группы в порядке FIFO:
 *   pending            — «Удалить»
 *   needs_confirmation — «Создать дубликат» (модалка), «Удалить»
 *   failed             — «Повторить», «Удалить»
 *   rejected           — «Создать заново онлайн», «Удалить»
 * «Удалить» есть на каждой записи любого статуса (п. 2.17).
 * «Синхронизировать» — сбрасывает ручной режим через triggerSync → syncNow.
 *
 * Владение DOM: _isActive / _mountId / _renderSeq.
 * После каждого await — isStale() перед обращением к DOM или навигацией.
 * Экранирование — только общий escapeHtml (правило 1 архитектуры).
 */
import { offlineDB, OUTBOX_STATUS } from "./offline-db.js";
import { outboxQueue } from "./outbox-queue.js";
import { notify } from "./components/notify.js";
import { formatTs } from "./utils/date-utils.js";
import { escapeHtml } from "./utils/escape-html.js";
import { appState } from "./app-state.js";
import { logHistoryAction } from "./history-logger.js";

const TYPE_LABEL = {
    CreateTicket: "Создание",
    EditTicket: "Редактирование",
    CloseTicket: "Закрытие",
    AddComment: "Комментарий",
    AcceptTicket: "Принятие",
};

const GROUP_TITLE = {
    [OUTBOX_STATUS.PENDING]: "Ожидает",
    [OUTBOX_STATUS.NEEDS_CONFIRMATION]: "Требует подтверждения",
    [OUTBOX_STATUS.FAILED]: "Ошибка",
    [OUTBOX_STATUS.REJECTED]: "Отклонено",
};

const GROUP_ORDER = [
    OUTBOX_STATUS.PENDING,
    OUTBOX_STATUS.NEEDS_CONFIRMATION,
    OUTBOX_STATUS.FAILED,
    OUTBOX_STATUS.REJECTED,
];

export class QueueController {
    constructor(api, router) {
        this.api = api;
        this.router = router;
        this._refreshHandler = null;
        this._syncingSyncBtn = null;
        this._isActive = false;
        this._mountId = 0;
        this._renderSeq = 0;
    }

    async mount() {
        this._mountId++;
        this._isActive = true;

        const $ = (id) => document.getElementById(id);
        const syncBtn = $("queueSyncBtn");
        const backBtn = $("queueBackBtn");

        if (backBtn) backBtn.onclick = () => this.router.navigate("#/");
        if (syncBtn) {
            syncBtn.onclick = () => {
                // triggerSync без detail → syncNow(): сброс ручного режима (п. 2.10).
                window.dispatchEvent(new Event("triggerSync"));
                this._setSyncBtnState(true);
            };
        }
        this._syncingSyncBtn = syncBtn;

        this._refreshHandler = () => {
            if (!this._isActive) return;
            this._render();
        };
        window.addEventListener("refreshSyncState", this._refreshHandler);

        await this._render();
    }

    unmount() {
        this._isActive = false;
        this._mountId++;
        this._renderSeq++; // обрываем рендер, который ещё в await
        if (this._refreshHandler) {
            window.removeEventListener("refreshSyncState", this._refreshHandler);
            this._refreshHandler = null;
        }
        this._syncingSyncBtn = null;
    }

    _setSyncBtnState(syncing) {
        const btn = this._syncingSyncBtn;
        if (!btn) return;
        if (syncing) {
            btn.disabled = true;
            btn.textContent = "Синхронизация...";
        } else {
            btn.disabled = false;
            btn.textContent = "Синхронизировать";
        }
    }

    async _render() {
        if (!this._isActive) return;
        const token = ++this._renderSeq;
        const isStale = () => !this._isActive || token !== this._renderSeq;

        const $ = (id) => document.getElementById(id);
        const tbody = document.querySelector("#queueTable tbody");
        const empty = $("queueEmpty");
        const summary = $("queueSummary");
        if (!tbody) return;

        this._setSyncBtnState(window.syncManagerInstance?.isSyncing === true);

        let groups;
        try {
            groups = await offlineDB.getOutboxGrouped();
        } catch (e) {
            console.warn("[QueueController] Очередь недоступна:", e);
            return;
        }
        if (isStale()) return;

        const counts = {
            pending: groups[OUTBOX_STATUS.PENDING]?.length || 0,
            needs_confirmation: groups[OUTBOX_STATUS.NEEDS_CONFIRMATION]?.length || 0,
            failed: groups[OUTBOX_STATUS.FAILED]?.length || 0,
            rejected: groups[OUTBOX_STATUS.REJECTED]?.length || 0,
        };
        const total =
            counts.pending + counts.needs_confirmation + counts.failed + counts.rejected;

        if (summary) {
            summary.textContent =
                total === 0
                    ? ""
                    : `Всего: ${total} · Ожидает: ${counts.pending} · Подтвердить: ${counts.needs_confirmation} · Ошибок: ${counts.failed} · Отклонено: ${counts.rejected}`;
        }

        tbody.innerHTML = "";
        if (total === 0) {
            if (empty) empty.style.display = "block";
            return;
        }
        if (empty) empty.style.display = "none";

        let rowIndex = 0;
        for (const status of GROUP_ORDER) {
            const list = groups[status] || [];
            if (list.length === 0) continue;

            const header = document.createElement("tr");
            header.className = "queue-group-header";
            header.innerHTML = `<td colspan="8" style="background: var(--bg-primary); font-weight: 700; padding: 8px;">${escapeHtml(GROUP_TITLE[status])} (${list.length})</td>`;
            tbody.appendChild(header);

            for (const cmd of list) {
                rowIndex++;
                tbody.appendChild(this._renderRow(cmd, rowIndex, status));
            }
        }
        this._bindActions(tbody);
    }

    _renderRow(cmd, idx, status) {
        const row = document.createElement("tr");
        if (status === OUTBOX_STATUS.FAILED) {
            row.style.background = "rgba(239,68,68,0.08)";
        } else if (status === OUTBOX_STATUS.NEEDS_CONFIRMATION) {
            row.style.background = "rgba(249,115,22,0.08)";
        } else if (status === OUTBOX_STATUS.REJECTED) {
            row.style.background = "rgba(100,116,139,0.08)";
        }

        const objectRef =
            cmd.ticket_id != null
                ? `№${cmd.ticket_id}`
                : cmd.offline_uuid
                    ? cmd.offline_uuid.slice(0, 16) + "…"
                    : "—";

        const preview = this._preview(cmd);
        const statusCell = this._statusCell(cmd, status);
        const actions = this._actionsHtml(cmd, status);

        row.innerHTML = `
            <td>${idx}</td>
            <td>${escapeHtml(TYPE_LABEL[cmd.command_type] || cmd.command_type)}</td>
            <td>${escapeHtml(cmd.offline_author_name || "—")}</td>
            <td>${escapeHtml(objectRef)}</td>
            <td title="${escapeHtml(preview)}" style="max-width:280px;overflow:hidden;text-overflow:ellipsis;">${escapeHtml(preview)}</td>
            <td>${statusCell}</td>
            <td data-ts="${Number(cmd.created_at) || 0}">${formatTs(cmd.created_at)}</td>
            <td style="white-space:nowrap;">
                ${actions}
                <button class="queue-delete-btn" data-uuid="${escapeHtml(cmd.command_uuid)}" data-action="delete" title="Удалить из очереди" style="margin-left:4px;padding:2px 8px;border-radius:4px;border:1px solid #ef4444;background:transparent;color:#ef4444;cursor:pointer;">×</button>
            </td>
        `;
        return row;
    }

    _statusCell(cmd, status) {
        if (status === OUTBOX_STATUS.PENDING) {
            return `<span style="color:#f59e0b;font-weight:600;">Ожидает</span>`;
        }
        if (status === OUTBOX_STATUS.FAILED) {
            const err = cmd.last_error || "error";
            const cnt = Number(cmd.retry_count) || 0;
            return `<span style="color:#ef4444;font-weight:600;" title="${escapeHtml(err)}">Ошибка${cnt ? ` (${cnt})` : ""}</span>`;
        }
        if (status === OUTBOX_STATUS.NEEDS_CONFIRMATION) {
            const n = Array.isArray(cmd.existing_tickets) ? cmd.existing_tickets.length : 0;
            return `<span style="color:#f97316;font-weight:600;">Дубликат${n ? ` (${n})` : ""}</span>`;
        }
        if (status === OUTBOX_STATUS.REJECTED) {
            const reason = cmd.reason || cmd.last_error || "отклонено";
            return `<span style="color:#64748b;font-weight:600;" title="${escapeHtml(reason)}">Отклонено</span>`;
        }
        return "";
    }

    _actionsHtml(cmd, status) {
        const uuid = escapeHtml(cmd.command_uuid);
        if (status === OUTBOX_STATUS.NEEDS_CONFIRMATION) {
            return `<button class="queue-action-btn" data-uuid="${uuid}" data-action="confirm" style="padding:2px 8px;border-radius:4px;border:1px solid #f97316;background:transparent;color:#f97316;cursor:pointer;">Создать дубликат</button>`;
        }
        if (status === OUTBOX_STATUS.FAILED) {
            return `<button class="queue-action-btn" data-uuid="${uuid}" data-action="retry" style="padding:2px 8px;border-radius:4px;border:1px solid #6366f1;background:transparent;color:#6366f1;cursor:pointer;">Повторить</button>`;
        }
        if (status === OUTBOX_STATUS.REJECTED && cmd.command_type === "CreateTicket") {
            return `<button class="queue-action-btn" data-uuid="${uuid}" data-action="recreate" style="padding:2px 8px;border-radius:4px;border:1px solid #22c55e;background:transparent;color:#22c55e;cursor:pointer;">Создать заново</button>`;
        }
        return "";
    }

    _bindActions(tbody) {
        tbody.querySelectorAll(".queue-delete-btn, .queue-action-btn").forEach((btn) => {
            btn.onclick = () => this._handleAction(btn.dataset.uuid, btn.dataset.action);
        });
    }

    async _handleAction(uuid, action) {
        if (!uuid || !action || !this._isActive) return;

        // Локальная копия поколения экрана. Без неё ветка recreate
        // после await могла бы увести пользователя на #/create,
        // когда он уже ушёл с очереди.
        const myMountId = this._mountId;
        const isStale = () => !this._isActive || this._mountId !== myMountId;

        const sm = window.syncManagerInstance;

        // --- Удаление любой записи (п. 2.17) ---
        if (action === "delete") {
            if (!confirm("Удалить действие из очереди? Оно не будет синхронизировано.")) return;
            await outboxQueue.remove([uuid]);
            if (isStale()) return;
            logHistoryAction("Действие удалено из очереди.");
            notify.info("Действие удалено из очереди.");
            window.dispatchEvent(new Event("refreshSyncState"));
            return;
        }

        // --- Создать дубликат (п. 2.20: модалка из очереди) ---
        if (action === "confirm") {
            if (!sm?.confirmDuplicate) {
                notify.error("Синхронизация недоступна. Обновите страницу.");
                return;
            }
            try {
                await sm.confirmDuplicate(uuid);
                if (isStale()) return;
            } catch (e) {
                console.error("[QueueController] confirmDuplicate error:", e);
                if (!isStale()) notify.error("Не удалось подтвердить дубликат.");
            }
            return;
        }

        // --- Повторить failed (п. 2.18) ---
        if (action === "retry") {
            if (!sm?.retryFailed) {
                notify.error("Синхронизация недоступна. Обновите страницу.");
                return;
            }
            try {
                await sm.retryFailed(uuid);
                if (isStale()) return;
                notify.info("Действие возвращено в очередь.");
            } catch (e) {
                console.error("[QueueController] retryFailed error:", e);
                if (!isStale()) notify.error("Не удалось вернуть действие в очередь.");
            }
            return;
        }

        // --- Создать заново онлайн из rejected (п. 2.18) ---
        if (action === "recreate") {
            const all = await offlineDB.getAllCommands();
            if (isStale()) return;

            const cmd = all.find((c) => c.command_uuid === uuid);
            if (!cmd || cmd.command_type !== "CreateTicket") {
                notify.warning("Восстановить можно только отклонённую заявку.");
                return;
            }

            const p = cmd.payload || {};
            appState.pendingCreateAddress = {
                from_ticket_id: null,
                address: p.fullAddress || p.address || "",
                city_id: p.city_id ?? null,
                street_id: p.street_id ?? null,
                home_id: p.home_id ?? null,
                object_id: p.object_id ?? null,
            };

            // Удаляем отклонённую запись: пользователь создаёт заново онлайн.
            await outboxQueue.remove([uuid]);
            if (isStale()) return;

            logHistoryAction("Отклонённая заявка открыта для создания заново.");
            notify.info(
                "Открыта форма создания. Заполните поля и сохраните онлайн.",
                { once: true },
            );
            this.router.navigate("#/create");
            return;
        }
    }

    _preview(cmd) {
        const p = cmd.payload || {};
        if (cmd.command_type === "CreateTicket") return p.fullAddress || p.address || "—";
        if (cmd.command_type === "EditTicket") {
            if (p.details) return p.details;
            if (p.staff_id != null) return "Назначить ответственного";
            if (p.notify_status != null) return "Изменить статус уведомления";
            return "—";
        }
        if (cmd.command_type === "CloseTicket") return p.solution || "—";
        if (cmd.command_type === "AddComment") return p.text || "—";
        return "—";
    }
}