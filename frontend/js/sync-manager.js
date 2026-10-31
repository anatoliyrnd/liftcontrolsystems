import { offlineDB } from './offline-db.js';
import { OFFLINE } from './config.js';
import { notify } from './components/notify.js';
import { logHistoryAction } from './history-logger.js';
import { authStore } from './auth-store.js';
import { networkLed } from './components/network-led.js';

export class SyncManager {
    /**
     * @param {ApiService} api
     * @param {Function} router
     * @param {Function} onOpenTicketsUpdated - Колбэк для обновления массива заявок в памяти
     */
    constructor(api, router, onOpenTicketsUpdated) {
        this.api = api;
        this.router = router;
        this.onOpenTicketsUpdated = onOpenTicketsUpdated;
        this.isSyncing = false;
        this._cooldownUntil = 0;

        this._lifecycleAbort = new AbortController();
        window.addEventListener(
            'online',
            () => this.startSync(),
            { signal: this._lifecycleAbort.signal }
        );
    }

    destroy() {
        this._lifecycleAbort?.abort();
        this._lifecycleAbort = null;
    }

    async startSync() {
        if (this.isSyncing || !authStore.hasAccess()) return;

        if (Date.now() < this._cooldownUntil) {
            const waitMins = Math.ceil((this._cooldownUntil - Date.now()) / 60000);
            notify.warning(`Синхронизация заблокирована. Попробуйте через ${waitMins} мин.`);
            return;
        }

        const count = await offlineDB.getOutboxCount();
        if (count === 0) return;

        this.isSyncing = true;

        try {
            const btn = document.getElementById('refreshBtn');
            if (btn) btn.classList.add('is-syncing');
            window.dispatchEvent(new Event('refreshSyncState'));

            networkLed.requestStarted();
            logHistoryAction(`Обнаружено ${count} офлайн-заявок. Начинаем синхронизацию...`);

            await this._syncLoop();
        } catch (err) {
            console.error('[SyncManager] Ошибка синхронизации:', err);
        } finally {
            this.isSyncing = false;
            const btn = document.getElementById('refreshBtn');
            if (btn) btn.classList.remove('is-syncing');
            networkLed.requestFinished();
            window.dispatchEvent(new Event('refreshSyncState'));
        }
    }

    async _syncLoop() {
        let retries = 0;
        let lastSignature = '';

        while (true) {
            const batch = await offlineDB.getOutboxBatch(OFFLINE.SYNC_BATCH_SIZE);
            if (batch.length === 0) break;

            // Защита от зацикливания (если deleteFromOutbox не сработал)
            const signature = batch.map(b => b.uuid).join(',');
            if (signature === lastSignature && retries === 0) {
                throw new Error('Синхронизация застряла: очередь не уменьшается');
            }
            lastSignature = signature;

            // Формируем данные для сервера (чистый payload + метаданные)
            // Формируем данные для сервера из обновленных полей outbox
            const ticketsToSend = batch.map(item => ({
                ...item.payload,
                offline_uuid: item.offline_uuid,
                offline_author_id: item.offline_author_id,
                offline_author_name: item.offline_author_name
            }));

            try {
                // ОТПРАВЛЯЕМ ПАЧКУ ЧЕРЕЗ НОВЫЙ ЭКШЕН
                const response = await this.api.post({
                    action: 'callNewOffline',
                    tickets: ticketsToSend
                }, `Отправка заявок (${batch.length} шт.)...`, 'sync');

                if (response && response.status === 'ok') {
                    // 1. Сервер принял пачку — удаляем из очереди
                    const uuids = batch.map(item => item.uuid);
                    await offlineDB.deleteFromOutbox(uuids);

                    // 2. ОБНОВЛЯЕМ СПИСОК ОТКРЫТЫХ ЗАЯВОК (отдельный запрос)
                    try {
                        const openData = await this.api.post({ data: "open" }, null, 'sync');
                        if (Array.isArray(openData)) {
                            await offlineDB.saveTickets('open', openData);
                            if (this.onOpenTicketsUpdated) {
                                this.onOpenTicketsUpdated(openData);
                            }
                        }
                    } catch (openErr) {
                        // Если запрос open упал — это не критично.
                        // Заявки уже на сервере, просто обновимся позже.
                        console.warn('[SyncManager] Не удалось обновить open после синхронизации:', openErr);
                        logHistoryAction('Заявки отправлены, но список не обновлен. Данные подтянутся позже.');
                    }

                    logHistoryAction(`Успешно синхронизировано ${batch.length} заявок.`);
                    retries = 0; // сбрасываем счетчик ошибок

                } else {
                    throw new Error(response.message || 'Ошибка сервера');
                }
            } catch (err) {
                retries++;
                if (retries >= OFFLINE.MAX_SYNC_RETRIES) {
                    await this._showSyncErrorModal(err.message);
                    return; // Прерываем цикл
                }
                await new Promise(r => setTimeout(r, 2000)); // Ждем 2 секунды
            }
        }

        logHistoryAction('Все офлайн-заявки успешно синхронизированы.');
        notify.success('Офлайн-заявки отправлены на сервер.');
    }

    async _showSyncErrorModal(errorMsg) {
        const user = authStore.getUser() || { id: 'unknown', name: 'Неизвестно' };
        const outboxCount = await offlineDB.getOutboxCount();

        const diagText = `=== ДИАГНОСТИКА СБОЯ СИНХРОНИЗАЦИИ ===\n` +
            `Время: ${new Date().toLocaleString('ru')}\n` +
            `Пользователь: ${user.name} (ID: ${user.id})\n` +
            `Ошибка сервера: ${errorMsg}\n` +
            `Зависших заявок: ${outboxCount}\n\n` +
            `Скопируйте этот текст и передайте администратору.`;

        const action = prompt(
            `Не удалось синхронизировать заявки после 5 попыток.\n\n` +
            `Нажмите ОК, чтобы УДАЛИТЬ заявки и работать онлайн.\n` +
            `Нажмите Отмена, чтобы сохранить заявки и попробовать позже.\n\n` +
            `--- ДИАГНОСТИКА (для копирования) ---\n${diagText}`,
            diagText
        );
        this._cooldownUntil = Date.now() + OFFLINE.SYNC_COOLDOWN_MS;

        if (action !== null) {
            const confirmDelete = confirm("ВНИМАНИЕ! Все офлайн-заявки будут удалены навсегда. Вы уверены?");
            if (confirmDelete) {
                offlineDB.clearOutbox().then(async () => {
                    logHistoryAction('Офлайн-заявки удалены пользователем.');
                    notify.warning('Офлайн-заявки удалены. Вы работаете в онлайн-режиме.');
                    if (this.router) this.router.navigate('#/');
                    window.dispatchEvent(new Event('refreshSyncState'));
                });
            }
        } else {
            const btn = document.getElementById('refreshBtn');
            if (btn) {
                btn.disabled = true;
                setTimeout(() => btn.disabled = false, 3000);
            }
        }
    }
}