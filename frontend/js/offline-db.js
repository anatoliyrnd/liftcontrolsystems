import { openDB } from './vendor/idb.js';

class OfflineDB {
    constructor() {
        this.dbPromise = openDB('LiftCallsDB', 1, {
            upgrade(db) {
                // Настройки и кэш конфига
                if (!db.objectStoreNames.contains('config')) {
                    db.createObjectStore('config', { keyPath: 'key' });
                }
                // Плоский список адресов для поиска
                if (!db.objectStoreNames.contains('address_flat')) {
                    const store = db.createObjectStore('address_flat', { keyPath: 'id' });
                    store.createIndex('city_id', 'city_id');
                }
                // Очередь неотправленных заявок
                if (!db.objectStoreNames.contains('outbox')) {
                    db.createObjectStore('outbox', { keyPath: 'uuid' });
                }
                // Кэш заявок (для отображения без сети)
                if (!db.objectStoreNames.contains('tickets_cache')) {
                    db.createObjectStore('tickets_cache', { keyPath: 'id' });
                }
            }
        });
    }

    // --- Конфиг ---
    async setConfig(key, value) {
        const db = await this.dbPromise;
        await db.put('config', { key, value });
    }

    async getConfig(key) {
        const db = await this.dbPromise;
        const res = await db.get('config', key);
        return res ? res.value : null;
    }

    // --- Адреса ---
    async saveAddresses(flatAddresses) {
        const db = await this.dbPromise;

        // Создаем ОДНУ транзакцию на весь процесс
        const tx = db.transaction('address_flat', 'readwrite');
        const store = tx.objectStore('address_flat');

        // Очищаем старые данные
        store.clear();

        // Пишем пачками внутри одной транзакции
        const CHUNK_SIZE = 2000;
        for (let i = 0; i < flatAddresses.length; i += CHUNK_SIZE) {
            const chunk = flatAddresses.slice(i, i + CHUNK_SIZE);

            // Promise.all ждет завершения записи пачки,
            // но не закрывает транзакцию (так как это все еще запросы к store).
            // Это дает браузеру "подышать" и не переполняет буфер.
            await Promise.all(chunk.map(addr => store.put(addr)));
        }

        // Закрываем транзакцию после записи всего массива
        await tx.done;
    }

    async getCities() {
        const db = await this.dbPromise;
        const all = await db.getAll('address_flat');
        const citiesMap = new Map();
        for (const item of all) {
            if (!citiesMap.has(item.city_id)) {
                citiesMap.set(item.city_id, { id: item.city_id, name: item.city_name });
            }
        }
        return Array.from(citiesMap.values()).sort((a, b) => a.name.localeCompare(b.name));
    }
    async searchAddresses(cityId, query) {
        const db = await this.dbPromise;
        const tx = db.transaction('address_flat', 'readonly');
        const index = tx.objectStore('address_flat').index('city_id');

        const q = query.toLowerCase().trim();
        const tokens = q ? q.split(' ').filter(t => t.length > 0) : [];
        const results = [];

        // Открываем курсор только по нужному городу
        let cursor = await index.openCursor(IDBKeyRange.only(cityId));

        while (cursor) {
            const item = cursor.value;

            if (tokens.length === 0) {
                // Если поиск пустой — набираем первые 50
                results.push(item);
            } else {
                const words = item.search_string.split(' ');
                const isMatch = tokens.every(token => words.some(word => word.startsWith(token)));
                if (isMatch) {
                    results.push(item);
                }
            }

            if (results.length >= 50) break; // Останавливаемся, как только набрали 50
            cursor = await cursor.continue();
        }

        await tx.done;
        return results;
    }
    // --- Очередь заявок (Outbox) ---
    async addToOutbox(ticket) {
        const db = await this.dbPromise;
        await db.put('outbox', ticket);
    }

    async getOutboxCount() {
        const db = await this.dbPromise;
        return await db.count('outbox');
    }

   async getOutboxBatch(limit = 10) {
    const db = await this.dbPromise;
    const tx = db.transaction('outbox', 'readonly');
    const store = tx.objectStore('outbox');

    // Курсор не читает оставшиеся записи — в отличие от getAll.
    const batch = [];
    let cursor = await store.openCursor();
    while (cursor && batch.length < limit) {
        batch.push(cursor.value);
        cursor = await cursor.continue();
    }
    await tx.done;
    return batch;
}
    async getAllFromOutbox() {
        const db = await this.dbPromise;
        return await db.getAll('outbox');
    }
    async deleteFromOutbox(uuids) {
        const db = await this.dbPromise;
        const tx = db.transaction('outbox', 'readwrite');
        for (const id of uuids) {
            tx.objectStore('outbox').delete(id);
        }
        await tx.done;
    }

        async clearOutbox() {
        const db = await this.dbPromise;
        await db.clear('outbox');
    }

    // --- Кэш заявок ---
    async saveTickets(type, tickets) {
    const db = await this.dbPromise;
    const tx = db.transaction('tickets_cache', 'readwrite');
    const store = tx.objectStore('tickets_cache');

    // Точечно вычищаем старый кэш нужного типа через курсор — не читаем
    // чужие типы (open/close) в память, как это делал getAll().
    let cursor = await store.openCursor();
    while (cursor) {
        if (cursor.value._type === type) {
            // Fire-and-forget: операция копится в буфере текущей транзакции,
            // курсор не теряет позицию. .catch(() => {}) гасит возможный
            // unhandled rejection — реальная ошибка всплывёт в tx.done ниже.
            cursor.delete().catch(() => {});
        }
        cursor = await cursor.continue();
    }

    // Записываем новые данные пачкой
    for (const t of tickets) {
        store.put({ ...t, _type: type });
    }

    // Закрываем транзакцию — здесь браузер атомарно применит
    // все удаления и записи на диск, либо откатит целиком.
    await tx.done;
    }

    async getTickets(type) {
        const db = await this.dbPromise;
        const tx = db.transaction('tickets_cache', 'readonly');
        const store = tx.objectStore('tickets_cache');
        const results = [];

        // Используем курсор вместо getAll
        let cursor = await store.openCursor();
        while (cursor) {
            if (cursor.value._type === type) {
                results.push(cursor.value);
            }
            cursor = await cursor.continue();
        }

        await tx.done;
        return results;
    }
}

export const offlineDB = new OfflineDB();