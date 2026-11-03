# Сообщение 3 из 3: `OFFLINE_PROTOCOL.md` v3.0 FINAL

```markdown
# 📄 OFFLINE_PROTOCOL.md — v3.0 (FINAL)

**Версия:** 3.0  
**Статус:** Утверждено (Готово к реализации)  
**Дата:** 03.11.2026  
**База данных:** MariaDB 10.11+  
**Изменения от v2.0:**
- ❌ Отказ от ограничения "только создание заявок".
- ✅ Добавлены команды: `EditTicket`, `CloseTicket`, `AddComment`, `AcceptTicket`.
- ✅ Переход на архитектуру **Command-Based Outbox + Snapshot Store**.
- ✅ Новый универсальный эндпоинт `POST /calls/syncCommands`.
- ✅ Таблица `offline_actions_archive` для отброшенных действий (30 дней).
- ✅ Логика **Soft Merge** при редактировании.
- ✅ Частичный успех (Partial Success) вместо атомарности.
- ✅ `ticket_not_found` → `archived` (не `failed`), чтобы избежать бесконечных retry.
- ✅ Использование `match` для чистой маршрутизации команд.
- ❌ Отказ от обратной совместимости с `callNewOffline` (не был в продакшене).

**Связанные документы:** `API_PROTOCOL.md` v4.2, `API_syncCommands.md` v4.2, `AUTH_PROTOCOL.md` v2.0, `TECHNICAL_DEBT.md`.

---

## 📑 Содержание

1. [Общие принципы](#1-общие-принципы)
2. [Матрица прав](#2-матрица-прав)
3. [Архитектура: Snapshot Store + Command Outbox](#3-архитектура-snapshot-store--command-outbox)
4. [Типы команд и их payload](#4-типы-команд-и-их-payload)
5. [Синхронизация: POST /calls/syncCommands](#5-синхронизация-post-callssynccommands)
6. [Серверная логика: Soft Merge и Обработка](#6-серверная-логика-soft-merge-и-обработка)
7. [Таблица offline_actions_archive](#7-таблица-offline_actions_archive)
8. [Идемпотентность](#8-идемпотентность)
9. [Обработка ошибок](#9-обработка-ошибок)
10. [Retry-стратегия](#10-retry-стратегия)
11. [UI-индикаторы и UX](#11-ui-индикаторы-и-ux)
12. [История изменений](#12-история-изменений)
13. [Схема БД (MariaDB)](#13-схема-бд-mariadb)
14. [Migration тенанта](#14-migration-тенанта)
15. [Что НЕ синхронизируется](#15-что-не-синхронизируется)

---

## 1. Общие принципы

### 1.1. Назначение
Офлайн-синхронизация позволяет пользователям (диспетчерам и механикам) выполнять ключевые действия с заявками без доступа к сети. Все изменения накапливаются в локальной очереди (IndexedDB) и автоматически синхронизируются при восстановлении соединения.

### 1.2. Поддерживаемые действия

| Действие | Диспетчер/Админ | Механик |
|----------|:---:|:---:|
| Создание заявки (`CreateTicket`) | ✅ | ❌ |
| Редактирование заявки (`EditTicket`) | ✅ | ❌ |
| Закрытие заявки (`CloseTicket`) | ✅ | ✅ |
| Добавление комментария (`AddComment`) | ✅ | ✅ |
| Принятие в работу (`AcceptTicket`) | ✅ | ✅ |

### 1.3. Ключевые правила

- **Максимум 20 команд** в одной пачке синхронизации.
- **Частичный успех (Partial Success):** Каждая команда обрабатывается независимо. Отброшенные действия сохраняются в `offline_actions_archive`.
- **Идемпотентность:** Повторная отправка команды с тем же `command_uuid` не вызывает побочных эффектов.
- **Soft Merge:** При редактировании никогда не затираем данные, уже установленные другими пользователями.
- **Оффлайн-маркер:** Все изменения логируются с пометкой `source = 'offline'` в `lift_history` и `audit_log`.

---

## 2. Матрица прав

| Команда | Условие успеха | Условие архивации (`offline_actions_archive`) |
|---------|----------------|-----------------------------------------------|
| `CreateTicket` | Пользователь — диспетчер/админ. Лифт не скрыт (`vis=1`). | Нет прав. Лифт скрыт (`contract_terminated`). Дубликат объекта. |
| `EditTicket` | Пользователь — диспетчер/админ. Заявка открыта. | Нет прав. Заявка закрыта. Заявка не найдена. |
| `CloseTicket` | Заявка открыта. | Заявка уже закрыта. Заявка не найдена. |
| `AddComment` | Заявка открыта. Лимит фото не превышен. | Заявка уже закрыта. Заявка не найдена. |
| `AcceptTicket` | Заявка открыта. `call_staff_status = 0`. | Заявка закрыта. Заявка не найдена. |

---

## 3. Архитектура: Snapshot Store + Command Outbox

### 3.1. Компоненты

| Компонент | Где | Роль |
|-----------|-----|------|
| `tickets_cache` | IndexedDB | Read Model. Полные данные заявок с сервера. |
| `local_changes` | IndexedDB | Write Model. Локальные изменения для мгновенного UI. |
| `outbox` | IndexedDB | Command Queue. Неизменяемые команды для синхронизации. |
| `sync-manager.js` | SPA (JS) | Отправка пачек при `online`. |
| `POST /calls/syncCommands` | API | Приём и обработка команд. |
| `offline_actions_archive` | MariaDB | Архив отброшенных действий (30 дней). |
| `offline_sync_log` | MariaDB | Лог всех синхронизаций (пачек). |
| `offline_command_log` | MariaDB | Лог отдельных команд (идемпотентность). |

### 3.2. Схема записи в Outbox (IndexedDB)

```json
{
  "command_uuid": "cmd_1761234567_abc123",
  "command_type": "CloseTicket",
  "ticket_id": 35732,
  "offline_uuid": "offline_...",
  "payload": { "solution": "..." },
  "created_at": 1761234567,
  "retry_count": 0,
  "last_error": null,
  "status": "pending"
}
```

### 3.3. Поток данных (Write)

1. Пользователь выполняет действие → UI обновляется мгновенно из `local_changes` (Optimistic UI).
2. Команда пушится в `outbox` со статусом `pending`.
3. `SyncManager` при `online` событии отправляет пачку на `/calls/syncCommands`.
4. Обработка ответа сервера:
   - `success` → команда удаляется из `outbox`, `tickets_cache` обновляется.
   - `archived` → команда удаляется из `outbox`, UI показывает уведомление.
   - `ignored` → команда удаляется из `outbox` (не ошибка).
   - `failed` → команда остаётся в `outbox`, retry через backoff.

---

## 4. Типы команд и их payload

### 4.1. `CreateTicket` (Создание)

```json
{
  "command_type": "CreateTicket",
  "offline_uuid": "offline_1761234567_x7k2p",
  "command_uuid": "cmd_...",
  "payload": {
    "offline_author_id": 3, "offline_author_name": "Сергеенко Сергей",
    "city_id": 1, "street_id": 2, "home_id": 3, "object_id": 11,
    "fullAddress": "...", "group_id": "8", "request_id": "2", 
    "department_id": "22", "repair_time": 1761220800, 
    "details": "Описание проблемы...", "staff_id": 3
  }
}
```

### 4.2. `EditTicket` (Редактирование — только диспетчер)

```json
{
  "command_type": "EditTicket", "ticket_id": 35732, "command_uuid": "cmd_...",
  "payload": {
    "description_delta": "Текст дополнения",
    "staff_id": 5, "repair_time": 1761230000, "notify_status": 2
  }
}
```
*Важно:* Фронтенд отправляет **только дельту** описания (`description_delta`).

### 4.3. `CloseTicket` (Закрытие)

```json
{
  "command_type": "CloseTicket", "ticket_id": 35732, "command_uuid": "cmd_...",
  "payload": { "solution": "Произведена замена реле", "closed_at": 1761234567 }
}
```

### 4.4. `AddComment` (Комментарий)

```json
{
  "command_type": "AddComment", "ticket_id": 35732, "command_uuid": "cmd_...",
  "payload": { "text": "Текст комментария", "photo_base64": "...", "created_at": 1761234500 }
}
```

### 4.5. `AcceptTicket` (Принять в работу)

```json
{
  "command_type": "AcceptTicket", "ticket_id": 35732, "command_uuid": "cmd_...",
  "payload": { "accepted_at": 1761234567 }
}
```

---

## 5. Синхронизация: POST /calls/syncCommands

### 5.1. Request

```json
{
  "action": "syncCommands",
  "batch_id": "batch_1761234567_xyz789",
  "commands": [ ... ]
}
```

### 5.2. Response 200 (Partial Success)

```json
{
  "status": "ok",
  "data": {
    "batch_id": "batch_1761234567_xyz789",
    "results": [
      { "command_uuid": "cmd_001", "status": "success", "ticket_id": 35732 },
      { "command_uuid": "cmd_002", "status": "archived", "reason": "ticket_already_closed", "archive_id": 1042 }
    ],
    "summary": { "success": 1, "archived": 1, "ignored": 0, "failed": 0 },
    "created_tickets": { "offline_123": 35740 }
  }
}
```

### 5.3. Статусы результатов

| Статус | Описание | Действие клиента |
|--------|----------|------------------|
| `success` | Команда выполнена. | Удалить из `outbox`. Обновить `tickets_cache`. |
| `archived` | Отброшено (нет прав, закрыта, **не найдена**). | Удалить из `outbox`. Показать уведомление. |
| `ignored` | Идемпотентность / уже уведомлён. | Удалить из `outbox`. Без уведомления. |
| `failed` | Временная ошибка (сеть, БД). | Оставить в `outbox`, retry. |
| `duplicate_detected` | Есть активная заявка на объект. | Модалка подтверждения + `force_create`. |

---

## 6. Серверная логика: Soft Merge и Обработка

### 6.1. Общий алгоритм обработки пачки (Intra-batch mapping)

Сервер ведет локальный словарь `$uuidToIdMap` для связывания команд внутри одной пачки (например, `AddComment` ссылается на `CreateTicket` по `offline_uuid`).

```php
public function syncBatch(array $user, string $batchId, array $commands): array
{
    // 1. Идемпотентность пачки
    if ($cached = $this->syncLogRepo->findSuccessByBatchId($batchId)) return $cached;
    
    $uuidToIdMap = [];
    $results = [];
    
    foreach ($commands as $command) {
        // Резолвим ticket_id (из БД или из $uuidToIdMap)
        $resolvedTicketId = $this->resolveTicketId($command, $uuidToIdMap);
        
        try {
            $result = $this->processCommand($command, $user, $resolvedTicketId);
            $results[] = $result;
            
            if ($command['command_type'] === 'CreateTicket' && $result['status'] === 'success') {
                $uuidToIdMap[$command['offline_uuid']] = $result['ticket_id'];
            }
        } catch (\Throwable $e) {
            $this->archiveCommand($command, $user, 'server_error');
            $results[] = ['status' => 'failed', 'reason' => 'server_error'];
        }
    }
    return $this->formatResponse($batchId, $results);
}
```

### 6.2. Маршрутизация команды (`match` + Идемпотентность)

```php
private function processCommand(array $command, array $user, ?int $resolvedTicketId): array
{
    // 1. Проверка идемпотентности ПРЯМО ПЕРЕД MATCH
    if ($this->db->fetchOne("SELECT id FROM offline_command_log WHERE command_uuid = ?", [$command['command_uuid']])) {
        return ['status' => 'ignored', 'reason' => 'already_processed'];
    }
    if ($archived = $this->db->fetchOne("SELECT id, reason FROM offline_actions_archive WHERE command_uuid = ?", [$command['command_uuid']])) {
        return ['status' => 'archived', 'reason' => $archived['reason'], 'archive_id' => $archived['id']];
    }

    // 2. Проверка прав
    if (!$this->checkPermission($user, $command)) {
        $this->archiveCommand($command, $user, 'no_rights');
        return ['status' => 'archived', 'reason' => 'no_rights'];
    }

    // 3. Маршрутизация через match
    return match ($command['command_type']) {
        'CreateTicket' => $this->handleCreate($command, $user),
        'EditTicket'   => $this->handleEdit($command, $user, $resolvedTicketId),
        'CloseTicket'  => $this->handleClose($command, $user, $resolvedTicketId),
        'AddComment'   => $this->handleComment($command, $user, $resolvedTicketId),
        'AcceptTicket' => $this->handleAccept($command, $user, $resolvedTicketId),
        default        => ['status' => 'failed', 'reason' => 'unknown_command_type'],
    };
}
```

### 6.3. Обработка `ticket_not_found` (Критическое исправление)

Во всех обработчиках (`handleEdit`, `handleClose`, `handleComment`, `handleAccept`), если заявка не найдена (удалена, ушла в архив), команда **архивируется**, а не падает в `failed`. Это предотвращает бесконечные retry.

```php
private function handleClose(array $command, array $user, ?int $ticketId): array
{
    $call = $this->callRepo->findById($ticketId);
    
    if (!$call) {
        $this->archiveCommand($command, $user, 'ticket_not_found');
        return [
            'status'  => 'archived', 
            'reason'  => 'ticket_not_found',
            'message' => 'Заявка не найдена (возможно, удалена). Действие отменено.'
        ];
    }
    // ... далее проверка call_status === 1 и логика закрытия ...
}
```

### 6.4. Логика `CloseTicket` (Слияние комментариев)

При успешном закрытии:
1. Считываем все записи из `lift_notes` для данной заявки.
2. Формируем JSON-массив и сохраняем в `lift_calls.call_full_note_history`.
3. В `lift_calls.call_solution` пишем **только** текст решения.
4. Удаляем записи из `lift_notes` (`DELETE FROM lift_notes WHERE note_relation = ?`).

### 6.5. Логика `EditTicket` (Soft Merge)

- `call_details`: Конкатенация `CONCAT(old, '\n\n[Оффлайн <user>]\n', delta)`.
- `call_staff`, `expected_repair_time`, `call_staff_status`: Обновляются **только** если текущее значение равно `0` (не назначено / не установлено).

---

## 7. Таблица `offline_actions_archive`

Хранит отброшенные действия 30 дней.

**Причины архивации (`reason`):**
`ticket_already_closed`, `no_rights`, `ticket_not_found`, `contract_terminated`, `photo_limit_exceeded`, `validation_error`, `duplicate_detected`.

---

## 8. Идемпотентность

1. **`batch_id`:** UNIQUE в `offline_sync_log`. Повторный запрос возвращает кэшированный ответ.
2. **`command_uuid`:** UNIQUE в `offline_command_log` и `offline_actions_archive`. Проверяется до `match`.
3. **`offline_uuid`:** UNIQUE в `lift_calls`. Защищает от дублей при создании.

---

## 9. Обработка ошибок (Итоговая матрица)

| Код `reason` | Статус | Описание | Действие клиента |
|--------------|:------:|----------|------------------|
| `no_rights` | `archived` | Нет прав на действие | Удалить из outbox, показать ⚠️ |
| `ticket_already_closed` | `archived` | Заявка уже закрыта | Удалить из outbox, показать ⚠️ |
| `ticket_not_found` | `archived` | Заявка удалена/не найдена | Удалить из outbox, показать ⚠️ |
| `contract_terminated` | `archived` | Лифт скрыт (`vis=0`) | Удалить из outbox, показать ⚠️ |
| `photo_limit_exceeded` | `archived` | Лимит фото (2 шт.) | Удалить из outbox, показать ⚠️ |
| `validation_error` | `archived` | Ошибка валидации | Удалить из outbox, показать ⚠️ |
| `duplicate_uuid` | `ignored` | `offline_uuid` уже есть | Удалить из outbox (без тоста) |
| `already_processed` | `ignored` | Идемпотентность | Удалить из outbox (без тоста) |
| `already_notified` | `ignored` | Уже уведомлён | Удалить из outbox (без тоста) |
| `missing_ticket_id` | `failed` | Intra-batch mapping не сработал | Оставить, retry |
| `server_error` | `failed` | Внутренняя ошибка / Таймаут | Оставить, retry |
| `duplicate_detected` | `duplicate` | Есть активная заявка на объект | Модалка подтверждения |

---

## 10. Retry-стратегия

### 10.1. Backoff (экспоненциальный)

| Попытка | Задержка |
|---------|----------|
| 1 | 30 сек |
| 2 | 60 сек |
| 3 | 120 сек |
| 4 | 240 сек |
| 5 | 480 сек |
| > 5 | Ручное вмешательство |

### 10.2. Триггеры синхронизации

- Восстановление сети (`online` event).
- Открытие SPA (первичная проверка).
- Ручной запуск (кнопка «Обновить»).
- Периодический поллинг каждые 60 секунд, если в outbox есть команды.
- После успешной синхронизации предыдущей пачки (если в outbox ещё есть).

---

## 11. UI-индикаторы и UX

### 11.1. Индикатор очереди

В SPA, в шапке:
- 🟢 `Синхронизировано` — outbox пуст.
- 🟡 `Ожидает синхронизации: N` — в outbox N команд.
- 🔴 `Ошибка синхронизации: N` — N команд с ошибкой (> 0 retry).

### 11.2. Экран «Очередь»

Список команд с датой создания, типом действия, ID заявки / UUID.

**Кнопки:**
- «Синхронизировать сейчас» (для `pending`)
- «Удалить» (только для `failed`)
- «Редактировать» (только для `pending` — пока не улетело на сервер)

### 11.3. Уведомления

| Событие | Сообщение |
|---------|-----------|
| Создание офлайн-действия | «✅ Сохранено. Будет синхронизировано при восстановлении сети.» |
| Успешная синхронизация | «✅ Синхронизировано: N действий.» |
| Архивация | «⚠️ Действие сохранено в архив: <reason>.» |
| 5+ неудач | «🔴 Требуется ручное вмешательство. Обратитесь к администратору.» |

---

## 12. История изменений

### v3.0 (текущая, production-ready)

- Универсальная система офлайн-команд.
- Поддержка 5 типов: `CreateTicket`, `EditTicket`, `CloseTicket`, `AddComment`, `AcceptTicket`.
- Архитектура Command-Based Outbox + Snapshot Store.
- Частичный успех (Partial Success) вместо атомарности.
- Soft Merge для редактирования.
- Таблица `offline_actions_archive` для отброшенных действий.
- Эндпоинт `POST /calls/syncCommands`.

### v2.0 (экспериментальная, не была в продакшене)

- Только создание заявок.
- Эндпоинт `callNewOffline` (удалён в v3.0, не был в продакшене).

### v1.0 (экспериментальная)

- Базовая офлайн-синхронизация.

---

## 13. Схема БД (MariaDB 10.11+)

### 13.1. Новые таблицы

#### `offline_actions_archive`

```sql
CREATE TABLE offline_actions_archive (
  id INT AUTO_INCREMENT PRIMARY KEY,
  command_uuid VARCHAR(64) NOT NULL,
  command_type VARCHAR(50) NOT NULL,
  ticket_id INT DEFAULT NULL,
  offline_uuid VARCHAR(64) DEFAULT NULL,
  user_id INT NOT NULL,
  user_name VARCHAR(255) NOT NULL,
  payload JSON NOT NULL,
  reason VARCHAR(100) NOT NULL,
  message TEXT DEFAULT NULL,
  created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
  expires_at TIMESTAMP NOT NULL,
  UNIQUE KEY uk_command_uuid (command_uuid),
  KEY idx_expires (expires_at),
  KEY idx_user_created (user_id, created_at),
  KEY idx_ticket (ticket_id)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb3 COLLATE=utf8mb3_unicode_ci;
```

#### `offline_command_log`

```sql
CREATE TABLE offline_command_log (
  id INT AUTO_INCREMENT PRIMARY KEY,
  command_uuid VARCHAR(64) NOT NULL,
  batch_id VARCHAR(64) NOT NULL,
  user_id INT NOT NULL,
  status VARCHAR(20) NOT NULL,
  result JSON DEFAULT NULL,
  created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
  UNIQUE KEY uk_command_uuid (command_uuid),
  KEY idx_batch (batch_id),
  KEY idx_user (user_id)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb3 COLLATE=utf8mb3_unicode_ci;
```

#### `offline_sync_log`

```sql
CREATE TABLE offline_sync_log (
  id INT AUTO_INCREMENT PRIMARY KEY,
  batch_id VARCHAR(64) NOT NULL,
  user_id INT NOT NULL,
  commands_count INT NOT NULL DEFAULT 0,
  status VARCHAR(20) NOT NULL DEFAULT 'started',
  started_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
  finished_at TIMESTAMP NULL DEFAULT NULL,
  cached_response LONGTEXT DEFAULT NULL COMMENT 'JSON-ответ при status=success для идемпотентности',
  error_message TEXT DEFAULT NULL,
  commands_success INT NOT NULL DEFAULT 0,
  commands_archived INT NOT NULL DEFAULT 0,
  commands_ignored INT NOT NULL DEFAULT 0,
  commands_failed INT NOT NULL DEFAULT 0,
  UNIQUE KEY uk_batch_id (batch_id),
  KEY idx_user_started (user_id, started_at),
  KEY idx_status (status)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb3 COLLATE=utf8mb3_unicode_ci;
```

### 13.2. Изменения в существующих таблицах

```sql
-- audit_log: маркировка источника действия
ALTER TABLE audit_log 
  ADD COLUMN source VARCHAR(20) NOT NULL DEFAULT 'online' 
  COMMENT 'online / offline / legacy / system / api';
CREATE INDEX idx_audit_source ON audit_log(source, timestamp);

-- lift_calls: начинаем использовать существующую колонку
ALTER TABLE lift_calls 
  MODIFY COLUMN call_full_note_history LONGTEXT CHARACTER SET utf8mb4 COLLATE utf8mb4_bin 
  NOT NULL DEFAULT '{}' COMMENT 'JSON-история всех комментариев';

-- lift_notes: маркировка офлайн-комментариев
ALTER TABLE lift_notes 
  ADD COLUMN is_offline TINYINT(1) NOT NULL DEFAULT 0 COMMENT '1 = создан в офлайне';

-- lift_history: источник изменения
ALTER TABLE lift_history 
  ADD COLUMN source VARCHAR(20) DEFAULT 'online' COMMENT 'online / offline / legacy';
```

### 13.3. Ключевые индексы для бизнес-логики

```sql
-- Для быстрой проверки дублей при создании (объект + статус + тип + дата)
CREATE INDEX idx_calls_active_object 
ON lift_calls(address_lift, call_status, call_request, call_date);

-- Для поиска неотверифицированных адресов (cron)
CREATE INDEX idx_calls_unverified 
ON lift_calls(address_not_verified) WHERE address_not_verified = 1;
```

### 13.4. Cron-задачи (Ежедневно)

```sql
-- Очистка архива
DELETE FROM offline_actions_archive WHERE expires_at < NOW() LIMIT 1000;

-- Очистка логов
DELETE FROM offline_command_log WHERE created_at < NOW() - INTERVAL 30 DAY LIMIT 1000;
DELETE FROM offline_sync_log WHERE started_at < NOW() - INTERVAL 30 DAY LIMIT 1000;
```

---

## 14. Migration тенанта

### 14.1. Контекст

При переезде тенанта с MariaDB на PostgreSQL (в будущем) — миграция данных.

### 14.2. Что мигрирует

| Данные | Мигрирует? |
|--------|:----------:|
| Пользователи | ✅ |
| Группы и справочники | ✅ |
| Лифты | ✅ |
| Открытые заявки | ✅ |
| Комментарии открытых | ✅ |
| История открытых | ✅ |
| Закрытые заявки | ❌ (архив) |
| `offline_actions_archive` | ❌ (30-дневные данные, не критично) |
| `offline_sync_log`, `offline_command_log` | ❌ (логи, не критично) |

### 14.3. Офлайн-очередь при миграции

**Проблема:** У пользователей могут быть команды в outbox на момент миграции.

**Решение:**
1. За 24 часа до миграции — уведомить пользователей: «Синхронизируйте офлайн-действия до <дата>.»
2. В день миграции — проверить `offline_sync_log`: если есть `started` за последние 24 часа — отложить миграцию.
3. Фронт на новом API: `offline_uuid` UNIQUE, старые UUID не конфликтуют (новая БД, новая схема).

---

## 15. Что НЕ синхронизируется

### 15.1. Ограничения офлайн-режима

| Действие | Почему не поддерживается офлайн |
|----------|----------------------------------|
| Изменение адреса заявки | Требует актуального справочника |
| Смена группы / типа неисправности | Требует актуальных справочников |
| Загрузка фото (свыше 2 шт.) | Требует storage и сжатия |
| Массовые действия | Требует онлайн-валидации прав |
| Работа с отчетами | Только чтение, онлайн |
| Управление пользователями | Только онлайн |

### 15.2. UI-ограничения в офлайне

- Кнопки «Редактировать адрес», «Сменить группу» — **disabled** с подсказкой «Требуется подключение к сети».
- Кнопки «Создать», «Закрыть», «Комментировать», «Принять в работу» — **enabled** (уходят в outbox).
- Кнопка «Редактировать» (для диспетчера) — **enabled** (Soft Merge).

---

**Конец `OFFLINE_PROTOCOL.md` (v3.0 FINAL).**
```

---

## ✅ Все три документа готовы

**Документы отправлены:**
1. ✅ `API_PROTOCOL.md` v4.2 — базовый протокол API
2. ✅ `API_syncCommands.md` v4.2 — детальная спецификация syncCommands
3. ✅ `OFFLINE_PROTOCOL.md` v3.0 FINAL — архитектура офлайн-синхронизации

**Ключевые согласованные решения:**
- ❌ `callNewOffline` удалён (не был в продакшене)
- ✅ `ticket_not_found` → `archived` (не `failed`)
- ✅ Использование `match` для маршрутизации
- ✅ Проверка идемпотентности до `match`
- ✅ Все 5 типов команд + Soft Merge
- ✅ Частичный успех (Partial Success)
- ✅ Таблица `offline_actions_archive` с `audit_log.source`

**Документы готовы к реализации!** 🎯

Что делаем дальше? Могу подготовить:
- SQL-миграции (готовый `.sql` файл)
- Nginx-конфиг (`client_max_body_size 10M`)
- Архитектуру клиентского `SyncManager` (JavaScript)