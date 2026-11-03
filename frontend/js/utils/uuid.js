/**
 * Генераторы UUID для офлайн-синхронизации.
 *
 * Форматы соответствуют API_PROTOCOL.md v4.2 (раздел 9.2):
 *   batch_id       — 'batch_<ts>_<rand8>'    (max 64)
 *   command_uuid   — 'cmd_<ts>_<rand8>'      (max 64)
 *   offline_uuid   — 'offline_<ts>_<rand8>'  (max 64)
 *
 * Гарантии:
 *   - Уникальность в пределах одного пользователя/устройства:
 *     timestamp + 8 случайных символов (base16 из crypto.randomUUID или base36).
 *   - Формат стабилен: префикс + timestamp + '_' + suffix. Регулярки для
 *     валидации на бэке — /^(batch|cmd|offline)_\d+_[a-z0-9]{8}$/.
 *
 * НЕ использует crypto.randomUUID() целиком — оставляет свой суффикс,
 * чтобы все три типа имели одинаковую длину хвоста.
 */

function randomSuffix() {
    if (typeof crypto !== 'undefined' && typeof crypto.randomUUID === 'function') {
        return crypto.randomUUID().replace(/-/g, '').slice(0, 8);
    }
    return Math.random().toString(36).slice(2, 10).padEnd(8, '0');
}

/** batch_id для пачки syncCommands. */
export function generateBatchId() {
    return 'batch_' + Date.now() + '_' + randomSuffix();
}

/** command_uuid для отдельной команды в outbox. */
export function generateCommandUuid() {
    return 'cmd_' + Date.now() + '_' + randomSuffix();
}

/** offline_uuid для CreateTicket (уникальный ID заявки на клиенте). */
export function generateOfflineUuid() {
    return 'offline_' + Date.now() + '_' + randomSuffix();
}