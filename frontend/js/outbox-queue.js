/**
 * Единый фасад постановки офлайн-команд в outbox.
 *
 * Все контроллеры (create / details) работают ТОЛЬКО через этот модуль.
 * Прямой offlineDB.addOutboxCommand() — запрещён, кроме как изнутри здесь.
 *
 * Схема записи (см. offline-db.js v2):
 *   command_uuid, command_type, ticket_id, offline_uuid,
 *   payload, created_at, retry_count, next_retry_at, last_error,
 *   status, offline_author_id, offline_author_name
 *
 * Авторство (offline_author_id / offline_author_name) фиксируется
 * в момент enqueue. Если команду потом синхронизирует другой пользователь
 * — batch-builder добавит префикс-маркер в payload (см. applyAuthorMarker).
 */

import { offlineDB } from './offline-db.js';
import { authStore } from './auth-store.js';
import { generateCommandUuid, generateOfflineUuid } from './utils/uuid.js';

function nowTs() {
    return Math.floor(Date.now() / 1000);
}

function currentAuthor() {
    const user = authStore.getUser();
    return {
        id: user?.id ?? null,
        name: user?.name ?? null
    };
}

function baseCommand(type, payload, extra = {}) {
    const author = currentAuthor();
    return {
        command_uuid: generateCommandUuid(),
        command_type: type,
        ticket_id: extra.ticket_id ?? null,
        offline_uuid: extra.offline_uuid ?? null,
        payload,
        created_at: nowTs(),
        retry_count: 0,
        next_retry_at: 0,
        last_error: null,
        status: 'pending',
        offline_author_id: author.id,
        offline_author_name: author.name
    };
}

export const outboxQueue = {

    // =====================================================================
    // CreateTicket (диспетчер / админ)
    // =====================================================================

    /**
     * @param {Object} payload — поля callnew без action:
     *   { city_id, street_id, home_id, object_id, fullAddress,
     *     group_id, request_id, department_id, repair_time,
     *     details, staff_id }
     * @returns {Object} запись outbox
     */
    async enqueueCreate(payload) {
        const offlineUuid = generateOfflineUuid();
        const cmd = baseCommand('CreateTicket', payload, {
            ticket_id: null,
            offline_uuid: offlineUuid
        });
        return offlineDB.addOutboxCommand(cmd);
    },

    // =====================================================================
    // EditTicket (диспетчер / админ) — Soft Merge на сервере
    // =====================================================================

    /**
     * Офлайн-разрешены только:
     *   - details         (append-only, сервер склеит)
     *   - staff_id        (только если не назначен)
     *   - notify_status   (только если не установлен)
     *   - repair_time     (только если не установлен)
     *
     * НЕ отправляем: group_id / request_id / department_id — только онлайн.
     *
     * @param {number|string} ticketId
     * @param {Object} patch — { details?, staff_id?, notify_status?, repair_time? }
     * @param {Object} [opts]
     * @param {string|null} [opts.offline_uuid] — если заявка ещё не на сервере
     *   (создана офлайн, ticket_id = null)
     * @returns {Object} запись outbox
     */
    async enqueueEdit(ticketId, patch, opts = {}) {
        const payload = {};
        if (typeof patch.details === 'string' && patch.details.trim() !== '') {
            payload.details = patch.details.trim();
        }
        if (patch.staff_id != null) payload.staff_id = patch.staff_id;
        if (patch.notify_status != null) payload.notify_status = patch.notify_status;
        if (patch.repair_time != null) payload.repair_time = patch.repair_time;

        const cmd = baseCommand('EditTicket', payload, {
            ticket_id: ticketId ?? null,
            offline_uuid: opts.offline_uuid ?? null
        });
        return offlineDB.addOutboxCommand(cmd);
    },

    // =====================================================================
    // CloseTicket (диспетчер / админ / механик)
    // =====================================================================

    /**
     * @param {number|string} ticketId
     * @param {string} solution — минимум 6 символов (валидируется в UI)
     * @param {Object} [opts]
     * @param {string|null} [opts.offline_uuid]
     * @returns {Object} запись outbox
     */
    async enqueueClose(ticketId, solution, opts = {}) {
        const cmd = baseCommand('CloseTicket', {
            solution: String(solution || '').trim(),
            closed_at: nowTs()
        }, {
            ticket_id: ticketId ?? null,
            offline_uuid: opts.offline_uuid ?? null
        });
        return offlineDB.addOutboxCommand(cmd);
    },

    // =====================================================================
    // AddComment (диспетчер / админ / механик)
    // =====================================================================

    /**
     * Фото — ТОЛЬКО ОНЛАЙН. В outbox photo_base64 не попадает.
     *
     * @param {number|string} ticketId
     * @param {string} text
     * @param {Object} [opts]
     * @param {string|null} [opts.offline_uuid]
     * @returns {Object} запись outbox
     */
    async enqueueComment(ticketId, text, opts = {}) {
        const cmd = baseCommand('AddComment', {
            text: String(text || '').trim(),
            created_at: nowTs()
        }, {
            ticket_id: ticketId ?? null,
            offline_uuid: opts.offline_uuid ?? null
        });
        return offlineDB.addOutboxCommand(cmd);
    },

    // =====================================================================
    // Чтение (обёртки над offline-db для единообразия)
    // =====================================================================

    /**
     * Все pending, FIFO. Любые авторы. Для batch-builder'а.
     */
    async getPendingBatch(limit = 20) {
        return offlineDB.getPendingBatch(limit);
    },

    /**
     * Pending по заявке — для бейджей «⏳» в таблице и карточке.
     * Возвращает массив команд (любые авторы).
     */
    async getPendingByTicket(ticketId) {
        return offlineDB.getPendingByTicket(ticketId);
    },

    /**
     * Pending по автору — только для UI-фильтра «Только мои» в очереди.
     */
    async getPendingByAuthor(authorId) {
        return offlineDB.getPendingByAuthor(authorId);
    },

    /**
     * Сводка по заявке: { hasEdit, hasClose, hasComment, hasCreate, count }
     * Удобно для рендера бейджей.
     */
    async getTicketFlags(ticketId) {
        const cmds = await offlineDB.getPendingByTicket(ticketId);
        const flags = {
            hasCreate: false,
            hasEdit: false,
            hasClose: false,
            hasComment: false,
            count: cmds.length
        };
        for (const c of cmds) {
            if (c.command_type === 'CreateTicket') flags.hasCreate = true;
            if (c.command_type === 'EditTicket') flags.hasEdit = true;
            if (c.command_type === 'CloseTicket') flags.hasClose = true;
            if (c.command_type === 'AddComment') flags.hasComment = true;
        }
        return flags;
    },

    // =====================================================================
    // Управление
    // =====================================================================

    async remove(commandUuids) {
        return offlineDB.deleteOutboxCommands(commandUuids);
    },

    async markFailed(commandUuid, reason) {
        return offlineDB.updateOutboxCommand(commandUuid, {
            status: 'failed',
            last_error: String(reason || 'unknown')
        });
    },

    async markRetry(commandUuid, reason, nextRetryAt) {
        const existing = await offlineDB.getPendingBatch(1);
        // читаем актуальный retry_count из store
        const all = await offlineDB.getAllPending();
        const record = all.find(c => c.command_uuid === commandUuid);
        const retryCount = (record?.retry_count ?? 0) + 1;
        return offlineDB.updateOutboxCommand(commandUuid, {
            retry_count: retryCount,
            next_retry_at: nextRetryAt || 0,
            last_error: String(reason || 'unknown'),
            status: 'pending'
        });
    },

    async resetToPending(commandUuid) {
        return offlineDB.updateOutboxCommand(commandUuid, {
            status: 'pending',
            next_retry_at: 0
        });
    },

    async clear() {
        return offlineDB.clearOutbox();
    },

    async getCounts() {
        const [pending, failed] = await Promise.all([
            offlineDB.getOutboxCount(),
            offlineDB.getFailedCount()
        ]);
        return { pending, failed };
    }
};