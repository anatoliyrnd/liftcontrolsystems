import { offlineDB } from './offline-db.js';
import { authStore } from './auth-store.js';
import { generateCommandUuid, generateOfflineUuid } from './utils/uuid.js';
import { formatTs } from './utils/date-utils.js'; // Для форматирования даты в комментариях

function nowTs() {
    return Math.floor(Date.now() / 1000);
}

function currentAuthor() {
    const user = authStore.getUser();
    if (!user) return { id: null, name: null };
    const name = user.surname
        ? `${user.surname} ${user.name || ''}`.trim()
        : user.name;
    return { id: user.id ?? null, name: name || null };
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

// Вспомогательный метод: найти CreateTicket по offline_uuid и обновить его
async function mergeIntoOfflineCreate(offlineUuid, updateFn) {
    const db = await offlineDB.dbPromise;
    const tx = db.transaction('outbox', 'readonly');
    const index = tx.objectStore('outbox').index('offline_uuid');
    
    // Точечный поиск по индексу вместо чтения всей очереди
    const cmds = await index.getAll(IDBKeyRange.only(offlineUuid));
    await tx.done;

    const cmd = cmds.find(c => c.command_type === 'CreateTicket');
    if (!cmd) return null; 

    const updatedPayload = { ...cmd.payload };
    updateFn(updatedPayload);

    await offlineDB.updateOutboxCommand(cmd.command_uuid, {
        payload: updatedPayload
    });
    return cmd;
}
export const outboxQueue = {
    async enqueueCreate(payload) {
        const author = currentAuthor();
        const enriched = {
            ...payload,
            offline_author_id: payload.offline_author_id ?? author.id,
            offline_author_name: payload.offline_author_name ?? author.name,
            opened_at: payload.opened_at ?? nowTs() // v5.2 Требование!
        };
        const offlineUuid = generateOfflineUuid();
        const cmd = baseCommand('CreateTicket', enriched, {
            ticket_id: null,
            offline_uuid: offlineUuid
        });
        return offlineDB.addOutboxCommand(cmd);
    },

    async enqueueEdit(ticketId, patch, opts = {}) {
        const isOffline = String(ticketId).startsWith('offline_');
        const offlineUuid = isOffline ? ticketId : opts.offline_uuid;

        // Если заявка офлайн — сливаем правки в CreateTicket
        if (offlineUuid) {
            const merged = await mergeIntoOfflineCreate(offlineUuid, (payload) => {
                if (patch.details) {
                    payload.details = (payload.details || '') + '\n\n' + patch.details;
                }
                if (patch.staff_id != null) payload.staff_id = patch.staff_id;
                if (patch.notify_status != null) payload.notify_status = patch.notify_status;
                if (patch.repair_time != null) payload.repair_time = patch.repair_time;
            });
            if (merged) return merged;
        }

        // Иначе — обычная команда EditTicket
        const payload = {};
        if (typeof patch.details === 'string' && patch.details.trim() !== '') {
            payload.details = patch.details.trim();
        }
        if (patch.staff_id != null) payload.staff_id = patch.staff_id;
        if (patch.notify_status != null) payload.notify_status = patch.notify_status;
        if (patch.repair_time != null) payload.repair_time = patch.repair_time;

        const cmd = baseCommand('EditTicket', payload, {
            ticket_id: isOffline ? null : ticketId,
            offline_uuid: offlineUuid
        });
        return offlineDB.addOutboxCommand(cmd);
    },

    async enqueueClose(ticketId, solution, opts = {}) {
        const isOffline = String(ticketId).startsWith('offline_');
        const offlineUuid = isOffline ? ticketId : opts.offline_uuid;
        const author = currentAuthor();

        // Если заявка офлайн — сливаем в CreateTicket
        if (offlineUuid) {
            const merged = await mergeIntoOfflineCreate(offlineUuid, (payload) => {
                payload.solution = String(solution || '').trim();
                payload.closed_at = nowTs();
                payload.closed_by_name = author.name || '—';
                payload.closed_by_id = author.id;
            });
            if (merged) return merged;
        }

        // Иначе — обычная команда CloseTicket
        const cmd = baseCommand('CloseTicket', {
            solution: String(solution || '').trim(),
            closed_at: nowTs()
        }, {
            ticket_id: isOffline ? null : ticketId,
            offline_uuid: offlineUuid
        });
        return offlineDB.addOutboxCommand(cmd);
    },

    async enqueueComment(ticketId, text, opts = {}) {
        const isOffline = String(ticketId).startsWith('offline_');
        const offlineUuid = isOffline ? ticketId : opts.offline_uuid;
        const author = currentAuthor();

        // Если заявка офлайн — сливаем в CreateTicket.comments
        if (offlineUuid) {
            const dateStr = formatTs(nowTs()).replace('@', ' ');
            const line = `[${author.name || 'Сотрудник'}, ${dateStr}]: ${text}`;

            const merged = await mergeIntoOfflineCreate(offlineUuid, (payload) => {
                if (!payload.comments) {
                    payload.comments = `⏳ [Офлайн-комментарии]\n${line}`;
                } else {
                    payload.comments += `\n${line}`;
                }
            });
            if (merged) return merged;
        }

        // Иначе — обычная команда AddComment
        const cmd = baseCommand('AddComment', {
            text: String(text || '').trim(),
            created_at: nowTs()
        }, {
            ticket_id: isOffline ? null : ticketId,
            offline_uuid: offlineUuid
        });
        return offlineDB.addOutboxCommand(cmd);
    },

    async getPendingBatch(limit = 20) {
        return offlineDB.getPendingBatch(limit);
    },

    async getPendingByTicket(ticketId) {
        return offlineDB.getPendingByTicket(ticketId);
    },

    async getPendingByAuthor(authorId) {
        return offlineDB.getPendingByAuthor(authorId);
    },

    async getTicketFlags(ticketId) {
        const cmds = await offlineDB.getPendingByTicket(ticketId);
        const flags = {
            hasCreate: false, hasEdit: false, hasClose: false, hasComment: false, count: cmds.length
        };
        for (const c of cmds) {
            if (c.command_type === 'CreateTicket') flags.hasCreate = true;
            if (c.command_type === 'EditTicket') flags.hasEdit = true;
            if (c.command_type === 'CloseTicket') flags.hasClose = true;
            if (c.command_type === 'AddComment') flags.hasComment = true;
        }
        return flags;
    },

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