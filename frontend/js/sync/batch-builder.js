/**
 * Сборка пачки syncCommands из outbox.
 *
 * Отвечает за:
 *   1. FIFO-порядок (created_at asc, сохраняется из getPendingBatch).
 *   2. Пропуск команд, у которых next_retry_at > now (backoff ещё не истёк).
 *   3. Ограничение веса пачки (3.5 MB по JSON).
 *   4. Пропуск intra-batch mapping: команды с ticket_id=null + offline_uuid=X
 *      уже содержат offline_uuid — сервер свяжет с CreateTicket в той же пачке.
 *   5. applyAuthorMarker: если offline_author_id !== currentUser.id —
 *      добавляем ПРЕФИКС [Синхронизировано: ...] в текст payload
 *      (details / solution / text). CreateTicket — не трогаем
 *      (автор уже в offline_author_id/name по протоколу).
 */

import { isRetryDue } from './backoff.js';

const MAX_BATCH_WEIGHT_BYTES = 3.5 * 1024 * 1024;
const MAX_COMMANDS_PER_BATCH = 20;

function buildAuthorMarker(syncerUser, authorName, authorId) {
    const syncer = syncerUser?.name
        ? `${syncerUser.name} (ID: ${syncerUser.id ?? '?'})`
        : `ID: ${syncerUser?.id ?? '?'}`;
    const author = authorName
        ? `${authorName} (ID: ${authorId ?? '?'})`
        : `ID: ${authorId ?? '?'}`;
    return `[Синхронизировано: ${syncer}. Автор: ${author}]`;
}

function needsAuthorMarker(cmd, currentUser) {
    if (!currentUser || !currentUser.id) return false;
    if (cmd.offline_author_id == null) return false;
    if (String(cmd.offline_author_id) === String(currentUser.id)) return false;
    return cmd.command_type !== 'CreateTicket';
}

/**
 * Вернуть payload с префиксом-маркером (или исходный, если маркер не нужен).
 * Чистая функция — не мутирует оригинал.
 */
export function applyAuthorMarker(cmd, currentUser) {
    const original = cmd.payload || {};

    if (!needsAuthorMarker(cmd, currentUser)) {
        return { ...original };
    }

    const marker = buildAuthorMarker(
        currentUser,
        cmd.offline_author_name,
        cmd.offline_author_id
    );

    const patched = { ...original };

    if (cmd.command_type === 'EditTicket' && typeof patched.details === 'string') {
        patched.details = `${marker}\n\n${patched.details}`;
    } else if (cmd.command_type === 'CloseTicket' && typeof patched.solution === 'string') {
        patched.solution = `${marker}\n\n${patched.solution}`;
    } else if (cmd.command_type === 'AddComment' && typeof patched.text === 'string') {
        patched.text = `${marker}\n\n${patched.text}`;
    }

    return patched;
}

/**
 * Преобразовать запись outbox в команду для syncCommands.
 * Публичный — используется sync-manager'ом при force_create retry.
 * @param {Object} cmd — запись outbox
 * @param {Object} currentUser — authStore.getUser()
 * @param {Object} [opts]
 * @param {boolean} [opts.forceCreate] — добавить force_create: true
 */
export function buildCommand(cmd, currentUser, opts = {}) {
    const payload = applyAuthorMarker(cmd, currentUser);
    const command = {
        command_uuid: cmd.command_uuid,
        command_type: cmd.command_type,
        ticket_id: cmd.ticket_id ?? null,
        offline_uuid: cmd.offline_uuid ?? null,
        payload
    };
    if (opts.forceCreate) {
        command.force_create = true;
    }
    return command;
}

/**
 * Собрать пачку.
 *
 * @param {Array<Object>} pendingCommands — из outboxQueue.getPendingBatch()
 * @param {Object} currentUser
 * @param {Object} [opts]
 * @param {number} [opts.maxWeightBytes]
 * @param {number} [opts.maxCommands]
 * @param {number} [opts.nowSec] — для тестов
 * @returns {Array<Object>} commands[]
 */
export function buildBatch(pendingCommands, currentUser, opts = {}) {
    const maxWeight = opts.maxWeightBytes ?? MAX_BATCH_WEIGHT_BYTES;
    const maxCount = opts.maxCommands ?? MAX_COMMANDS_PER_BATCH;
    const nowSec = typeof opts.nowSec === 'number'
        ? opts.nowSec
        : Math.floor(Date.now() / 1000);

    const batch = [];
    let weight = 0;

    for (const cmd of pendingCommands) {
        if (batch.length >= maxCount) break;
        if (!isRetryDue(cmd, nowSec)) continue;

        const command = buildCommand(cmd, currentUser);
        const size = JSON.stringify(command).length;

        if (batch.length > 0 && weight + size > maxWeight) break;

        batch.push(command);
        weight += size;
    }

    return batch;
}

export function hasSyncable(pendingCommands, nowSec) {
    const now = typeof nowSec === 'number'
        ? nowSec
        : Math.floor(Date.now() / 1000);
    return pendingCommands.some(c => isRetryDue(c, now));
}