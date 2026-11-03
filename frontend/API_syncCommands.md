# Сообщение 2 из 3: `API_syncCommands.md` v4.2

```markdown
# 📋 API_PROTOCOL.md — Приложение: Синхронизация офлайн-команд (`syncCommands`)

**Версия:** 4.2  
**Статус:** Актуально (согласовано)  
**Дата:** 03.11.2026  
**База данных:** MariaDB 10.11+

**Изменения от v4.1:**
- ❌ Удалены все упоминания `callNewOffline` (не был в продакшене)
- ✅ `syncCommands` — единственный production-ready эндпоинт для офлайн-синхронизации
- ✅ Поддержка 5 типов команд: `CreateTicket`, `EditTicket`, `CloseTicket`, `AddComment`, `AcceptTicket`
- ✅ Частичный успех (Partial Success) вместо атомарности
- ✅ Soft Merge для редактирования
- ✅ `ticket_not_found` → `archived` (не `failed`), чтобы избежать бесконечных retry
- ✅ Intra-batch mapping (связывание команд в одной пачке через `offline_uuid`)
- ✅ Сжатие фото до 500 КБ на клиенте
- ✅ Лимит запроса: 10 MB (Nginx), пачка: 3.5 MB

**Связанные документы:** `OFFLINE_PROTOCOL.md` v3.0, `API_PROTOCOL.md` v4.2, `AUTH_PROTOCOL.md` v2.0, `TECHNICAL_DEBT.md`

---

## 📑 Содержание

1. [Обзор эндпоинта](#1-обзор-эндпоинта)
2. [Авторизация и мультитенантность](#2-авторизация-и-мультитенантность)
3. [Request: общая структура](#3-request-общая-структура)
4. [Типы команд и payload](#4-типы-команд-и-payload)
5. [Response: общая структура](#5-response-общая-структура)
6. [Статусы результатов](#6-статусы-результатов)
7. [Примеры запросов и ответов](#7-примеры-запросов-и-ответов)
8. [Обработка ошибок](#8-обработка-ошибок)
9. [Идемпотентность](#9-идемпотентность)
10. [Intra-batch mapping](#10-intra-batch-mapping-связывание-команд-в-пачке)
11. [Rate-limiting](#11-rate-limiting)
12. [Полная таблица кодов ошибок](#12-полная-таблица-кодов-ошибок)
13. [История API](#13-история-api)

---

## 1. Обзор эндпоинта

### 1.1. Endpoint

```
POST https://api.liftcs.ru/calls/syncCommands
```

**Назначение:** Универсальный эндпоинт для пакетной синхронизации офлайн-действий: создание, редактирование, закрытие, комментирование, принятие в работу.

### 1.2. HTTP-характеристики

| Параметр | Значение |
|----------|----------|
| Метод | `POST` |
| Content-Type | `application/json; charset=utf-8` |
| Accept | `application/json` |
| Таймаут клиента | 30 секунд |
| Максимальный размер запроса | **10 MB** (настроить `client_max_body_size` в Nginx) |
| Максимальный вес пачки | **3.5 MB** (JSON). Фронтенд обязан собирать пачку по весу |
| Максимум команд в пачке | 20 |
| HTTP-статус | Всегда `200 OK` (ошибки в теле) |

### 1.3. Поддерживаемые типы команд

| Тип | Кто может отправлять |
|-----|----------------------|
| `CreateTicket` | Только `administrator` / `dispatcher` |
| `EditTicket` | Только `administrator` / `dispatcher` |
| `CloseTicket` | `administrator`, `dispatcher`, `engineer` |
| `AddComment` | `administrator`, `dispatcher`, `engineer` |
| `AcceptTicket` | `administrator`, `dispatcher`, `engineer` |

---

## 2. Авторизация и мультитенантность

### 2.1. Обязательные заголовки

```http
POST /calls/syncCommands HTTP/1.1
Host: api.liftcs.ru
Content-Type: application/json; charset=utf-8
Accept: application/json
Authorization: Bearer <access_token>
X-Tenant: l3
```

| Заголовок | Обязательно | Описание |
|-----------|:-----------:|----------|
| `Authorization` | ✅ | Bearer-токен (access) из `AUTH_PROTOCOL.md` |
| `X-Tenant` | ⚠️ | Обязателен, если тенант не определён по JWT |
| `Content-Type` | ✅ | `application/json` |
| `Accept` | ✅ | `application/json` |

### 2.2. Роли и права

| Роль | `CreateTicket` | `EditTicket` | `CloseTicket` | `AddComment` | `AcceptTicket` |
|------|:--------------:|:------------:|:-------------:|:------------:|:--------------:|
| `administrator` | ✅ | ✅ | ✅ | ✅ | ✅ |
| `dispatcher` | ✅ | ✅ | ✅ | ✅ | ✅ |
| `engineer` (механик) | ❌ | ❌ | ✅ | ✅ | ✅ |
| `guest` | ❌ | ❌ | ❌ | ❌ | ❌ |

**Проверка прав:** Сервер проверяет `user_permissions` из `config` и `CallPolicy::can{Action}($user, $payload)`. При отсутствии прав → команда архивируется с `reason: no_rights`.

---

## 3. Request: общая структура

### 3.1. JSON Schema

```json
{
  "action": "syncCommands",
  "batch_id": "string (UUID v4, max 64)",
  "commands": [
    {
      "command_uuid": "string (max 64)",
      "command_type": "CreateTicket | EditTicket | CloseTicket | AddComment | AcceptTicket",
      "ticket_id": "integer | null",
      "offline_uuid": "string | null",
      "payload": { ... },
      "force_create": "boolean (опционально, только для CreateTicket)"
    }
  ]
}
```

### 3.2. Обязательные поля верхнего уровня

| Поле | Тип | Обязательно | Описание |
|------|-----|:-----------:|----------|
| `action` | string | ✅ | Всегда `"syncCommands"` |
| `batch_id` | string | ✅ | UUID v4 пачки (генерируется клиентом) |
| `commands` | array | ✅ | Массив команд (1–20 элементов) |

### 3.3. Валидация верхнего уровня

| Условие | Ошибка |
|---------|--------|
| `action !== "syncCommands"` | `invalid_input: invalid_action` |
| `batch_id` пустой или > 64 символов | `invalid_input: invalid_batch_id` |
| `commands.length < 1` | `invalid_input: commands_empty` |
| `commands.length > 20` | `invalid_input: commands_too_many` |
| Дубликаты `command_uuid` внутри пачки | `invalid_input: duplicate_command_uuid` |

---

## 4. Типы команд и payload

### 4.1. Общие поля команды

| Поле | Тип | Обязательно | Описание |
|------|-----|:-----------:|----------|
| `command_uuid` | string | ✅ | Уникальный ID команды в пределах пачки (рекомендуется: `cmd_<timestamp>_<random>`) |
| `command_type` | enum | ✅ | Один из: `CreateTicket`, `EditTicket`, `CloseTicket`, `AddComment`, `AcceptTicket` |
| `ticket_id` | integer \| null | ⚠️ | ID заявки с сервера. `null` для `CreateTicket` или если команда ссылается на `offline_uuid` той же пачки |
| `offline_uuid` | string \| null | ⚠️ | UUID заявки (для `CreateTicket` или для связывания с командой создания в той же пачке) |
| `payload` | object | ✅ | Данные команды (зависят от типа) |
| `force_create` | boolean | ❌ | Только для `CreateTicket`. Обходит проверку дублей (после подтверждения пользователем) |

**Важно:** Для `CreateTicket` обязательно наличие `offline_uuid`. Для остальных типов — обязательно `ticket_id` ИЛИ `offline_uuid` (для Intra-batch mapping).

---

### 4.2. `CreateTicket` (Создание заявки)

**Права:** Только `administrator` / `dispatcher`  
**Особенности:** Использует `offline_uuid` вместо `ticket_id`

#### Payload

```json
{
  "offline_author_id": 3,
  "offline_author_name": "Сергеенко Сергей",
  "city_id": "1",
  "street_id": "2",
  "home_id": "3",
  "object_id": "11",
  "fullAddress": "г. Ростов-на-Дону - Красноармейская ул. дом № 2 корп.2 - п. 1 прав.",
  "group_id": "8",
  "request_id": "2",
  "department_id": "22",
  "repair_time": 1761220800,
  "details": "Описание проблемы...",
  "staff_id": 3,
  "call_phone": "+79001234567",
  "call_first_name": "Иван",
  "call_last_name": "Иванов"
}
```

#### Обязательные поля payload

| Поле | Тип | Обязательно | Описание |
|------|-----|:-----------:|----------|
| `offline_author_id` | int | ✅ | ID автора (с устройства) |
| `offline_author_name` | string | ✅ | ФИО автора |
| `city_id` | string\|int | ✅ | ID города |
| `street_id` | string\|int | ✅ | ID улицы |
| `home_id` | string\|int | ✅ | ID дома |
| `object_id` | string\|int | ✅ | ID лифта |
| `fullAddress` | string | ✅ | Полный адрес (текст) |
| `group_id` | string | ✅ | ID группы лифтов |
| `request_id` | string | ✅ | ID типа неисправности |
| `department_id` | string | ✅ | ID отдела |
| `repair_time` | int | ✅ | Unix timestamp планируемого устранения |
| `details` | string | ✅ | Описание (мин. 6 символов) |
| `staff_id` | int | ✅ | ID ответственного |

#### Опциональные поля payload

| Поле | Тип | Описание |
|------|-----|----------|
| `call_phone` | string | Телефон заявителя |
| `call_first_name` | string | Имя заявителя |
| `call_last_name` | string | Фамилия заявителя |
| `force_create` | boolean | Обойти проверку дублей (после подтверждения UI) |

#### Валидация payload

| Условие | Код ошибки |
|---------|------------|
| `details` < 6 символов | `validation_error: details_too_short` |
| `repair_time` < текущего времени | `validation_error: repair_time_in_past` |
| `staff_id` не существует | `validation_error: staff_not_found` |
| `object_id` не существует | `validation_error: object_not_found` |
| `object.vis = 0` (скрыт) и нет прав | `contract_terminated` |
| `group_id` вне доступа пользователя | `forbidden: group_not_allowed` |

---

### 4.3. `EditTicket` (Редактирование)

**Права:** Только `administrator` / `dispatcher`  
**Особенности:** Soft Merge — не затираем установленные поля

#### Payload

```json
{
  "description_delta": "Текст дополнения к описанию",
  "staff_id": 5,
  "repair_time": 1761230000,
  "notify_status": 2
}
```

#### Поля payload (все опциональные, но минимум одно обязательно)

| Поле | Тип | Описание | Soft Merge правило |
|------|-----|----------|-------------------|
| `description_delta` | string | **Только дельта** (дополнение к существующему описанию) | **Всегда применяется:** `call_details = CONCAT(old, '\n\n[Оффлайн <user> <date>]\n', delta)` |
| `staff_id` | int | ID ответственного | Только если `call_staff = 0` |
| `repair_time` | int | Unix timestamp | Только если `expected_repair_time = 0` |
| `notify_status` | int (0-7) | Канал уведомления | Только если `call_staff_status = 0` |
| `group_id` | string | ID группы | Только если `call_group = 0` |
| `request_id` | string | Тип неисправности | Только если `call_request = 0` |

#### Валидация payload

| Условие | Код ошибки |
|---------|------------|
| Все поля пустые | `validation_error: edit_payload_empty` |
| `description_delta` < 6 символов | `validation_error: delta_too_short` |
| Заявка закрыта (`call_status = 1`) | `ticket_already_closed` → архивация |

---

### 4.4. `CloseTicket` (Закрытие)

**Права:** `administrator`, `dispatcher`, `engineer`  
**Особенности:** При закрытии все комментарии из `lift_notes` сериализуются в `call_full_note_history` (JSON) и удаляются из таблицы.

#### Payload

```json
{
  "solution": "Произведена очистка контактов реле и замена предохранителя.",
  "closed_at": 1761234567
}
```

#### Поля payload

| Поле | Тип | Обязательно | Описание |
|------|-----|:-----------:|----------|
| `solution` | string | ✅ | Текст решения (мин. 6 символов) |
| `closed_at` | int | ❌ | Unix timestamp закрытия (если не указан — используется `time()`) |

#### Валидация payload

| Условие | Код ошибки |
|---------|------------|
| `solution` < 6 символов | `validation_error: solution_too_short` |
| Заявка закрыта | `ticket_already_closed` → архивация |

---

### 4.5. `AddComment` (Добавление комментария)

**Права:** `administrator`, `dispatcher`, `engineer`  
**Особенности:** Лимит 2 фото на заявку (суммарно онлайн + офлайн)

#### Payload

```json
{
  "text": "Текст комментария, примечания или отчёта мастера",
  "photo_base64": "data:image/jpeg;base64,/9j/4AAQSkZJRg...",
  "created_at": 1761234500
}
```

#### Поля payload

| Поле | Тип | Обязательно | Описание |
|------|-----|:-----------:|----------|
| `text` | string | ✅ | Текст комментария (мин. 6 символов) |
| `photo_base64` | string | ❌ | Фото в base64 (JPEG). **Макс. 500 КБ после декодирования** (~670 КБ в base64). Фронтенд обязан сжать фото на устройстве перед добавлением в outbox |
| `created_at` | int | ❌ | Unix timestamp создания (если не указан — `time()`) |

#### Валидация payload

| Условие | Код ошибки |
|---------|------------|
| `text` < 6 символов | `validation_error: text_too_short` |
| `photo_base64` > 500 КБ (декодированное) | `archived: photo_too_large` |
| Заявка закрыта | `ticket_already_closed` → архивация |
| Уже 2 фото в заявке | `photo_limit_exceeded` → архивация |

---

### 4.6. `AcceptTicket` (Принять в работу)

**Права:** `administrator`, `dispatcher`, `engineer`  
**Особенности:** Меняет `call_staff_status` на `2` (WEB), только если текущий статус `0` (Не уведомлён)

#### Payload

```json
{
  "accepted_at": 1761234567
}
```

#### Поля payload

| Поле | Тип | Обязательно | Описание |
|------|-----|:-----------:|----------|
| `accepted_at` | int | ❌ | Unix timestamp принятия (если не указан — `time()`) |

#### Валидация payload

| Условие | Код результата |
|---------|----------------|
| Заявка закрыта | `ticket_already_closed` → архивация |
| `call_staff_status != 0` | `already_notified` → `ignored` |

---

## 5. Response: общая структура

### 5.1. Успешный ответ (HTTP 200)

```json
{
  "status": "ok",
  "data": {
    "batch_id": "batch_1761234567_xyz789",
    "results": [
      {
        "command_uuid": "cmd_001",
        "status": "success",
        "ticket_id": 35740,
        "server_id": 35740,
        "offline_uuid": "offline_x7k2p",
        "message": "Заявка создана"
      }
    ],
    "summary": {
      "success": 3,
      "archived": 1,
      "ignored": 1,
      "failed": 0
    },
    "created_tickets": {
      "offline_1761234567_x7k2p": 35740
    }
  }
}
```

### 5.2. Поля верхнего уровня

| Поле | Тип | Описание |
|------|-----|----------|
| `status` | string | `"ok"` или `"error"` |
| `data` | object | Данные ответа (при `status: ok`) |
| `error` | object | Данные ошибки (при `status: error`) |

### 5.3. Поля `data`

| Поле | Тип | Описание |
|------|-----|----------|
| `batch_id` | string | ID пачки (из запроса) |
| `results` | array | Массив результатов по каждой команде |
| `summary` | object | Сводка по пачке |
| `created_tickets` | object | Маппинг `offline_uuid → server_id` для `CreateTicket` |

### 5.4. Структура элемента `results[]`

```json
{
  "command_uuid": "cmd_001",
  "status": "success | archived | ignored | failed | duplicate_detected",
  "ticket_id": 35740,
  "server_id": 35740,
  "offline_uuid": "offline_x7k2p",
  "reason": "optional_error_code",
  "message": "Human-readable сообщение",
  "archive_id": 1042,
  "changes": { ... },
  "notes_merged": 2,
  "note_id": 144,
  "existing_tickets": [
    {
      "call_id": 35732,
      "details": "Не горит свет в кабине",
      "date": 1761214200
    }
  ],
  "current_status": 2
}
```

### 5.5. Структура `summary`

```json
{
  "success": 3,
  "archived": 1,
  "ignored": 1,
  "failed": 0,
  "duplicate_detected": 0
}
```

### 5.6. Структура `created_tickets`

```json
{
  "offline_1761234567_x7k2p": 35740,
  "offline_1761234568_y8m3q": 35741
}
```

Используется клиентом для:
- Обновления `ticket_id` в последующих командах (если были в этой же пачке).
- Маппинга локальных `offline_uuid` на серверные `ticket_id` для `tickets_cache`.

---

## 6. Статусы результатов

### 6.1. Таблица статусов

| Статус | Описание | HTTP-аналог | Действие клиента |
|--------|----------|:-----------:|------------------|
| `success` | Команда успешно выполнена | 200 | Удалить из `outbox`. Обновить `tickets_cache`. Показать ✅ тост. |
| `archived` | Действие отброшено, сохранено в `offline_actions_archive` | 200 (но с `reason`) | Удалить из `outbox`. Показать ⚠️ уведомление с причиной. |
| `ignored` | Команда не выполнена, но не ошибка (идемпотентность, уже уведомлён) | 200 | Удалить из `outbox`. Без уведомления. |
| `failed` | Критическая ошибка (валидация payload, БД) | 200 (но с `reason`) | Оставить в `outbox` для retry. Показать 🔴 ошибку. |
| `duplicate_detected` | Обнаружена активная заявка на объект | 200 | Модалка подтверждения с `force_create: true`. |

### 6.2. Детальная матрица статусов по типам команд

| Команда | Успех | Архивация | Игнорирование | Ошибка |
|---------|:-----:|:---------:|:-------------:|:------:|
| `CreateTicket` | ✅ заявка создана | `no_rights`, `contract_terminated`, `validation_error`, `duplicate_uuid`, `ticket_not_found` | `duplicate_detected` (с `force_create=false`) | `server_error` |
| `EditTicket` | ✅ изменения применены | `no_rights`, `ticket_already_closed`, `ticket_not_found`, `validation_error` | — | `server_error` |
| `CloseTicket` | ✅ заявка закрыта | `ticket_already_closed`, `ticket_not_found` | — | `server_error` |
| `AddComment` | ✅ комментарий добавлен | `ticket_already_closed`, `ticket_not_found`, `photo_limit_exceeded`, `validation_error` | — | `server_error` |
| `AcceptTicket` | ✅ статус изменён | `ticket_already_closed`, `ticket_not_found` | `already_notified` | `server_error` |

---

## 7. Примеры запросов и ответов

### 7.1. Пример 1: Смешанная пачка с Partial Success

**Request:**

```json
{
  "action": "syncCommands",
  "batch_id": "batch_1761234567_xyz789",
  "commands": [
    {
      "command_uuid": "cmd_001",
      "command_type": "CreateTicket",
      "offline_uuid": "offline_1761234567_x7k2p",
      "payload": {
        "offline_author_id": 3,
        "offline_author_name": "Сергеенко Сергей",
        "city_id": 1, "street_id": 2, "home_id": 3, "object_id": 11,
        "fullAddress": "г. Ростов-на-Дону - Красноармейская ул. дом № 2 - п. 1 прав.",
        "group_id": "8", "request_id": "2", "department_id": "22",
        "repair_time": 1761220800,
        "details": "Застревание пассажира",
        "staff_id": 3
      }
    },
    {
      "command_uuid": "cmd_002",
      "command_type": "AddComment",
      "ticket_id": null,
      "offline_uuid": "offline_1761234567_x7k2p",
      "payload": {
        "text": "Дополнительная информация от механика",
        "created_at": 1761234500
      }
    },
    {
      "command_uuid": "cmd_003",
      "command_type": "CloseTicket",
      "ticket_id": 35732,
      "payload": {
        "solution": "Произведена замена реле",
        "closed_at": 1761234567
      }
    },
    {
      "command_uuid": "cmd_004",
      "command_type": "EditTicket",
      "ticket_id": 35733,
      "payload": {
        "description_delta": "Пассажир жалуется на духоту"
      }
    }
  ]
}
```

**Response:**

```json
{
  "status": "ok",
  "data": {
    "batch_id": "batch_1761234567_xyz789",
    "results": [
      {
        "command_uuid": "cmd_001",
        "status": "success",
        "ticket_id": 35740,
        "server_id": 35740,
        "offline_uuid": "offline_1761234567_x7k2p",
        "message": "Заявка создана"
      },
      {
        "command_uuid": "cmd_002",
        "status": "success",
        "ticket_id": 35740,
        "note_id": 145,
        "message": "Комментарий добавлен к заявке №35740"
      },
      {
        "command_uuid": "cmd_003",
        "status": "archived",
        "ticket_id": 35732,
        "reason": "ticket_already_closed",
        "message": "Заявка уже закрыта 02.11.2026 14:30 пользователем Петров П.П. Действие сохранено в архив.",
        "archive_id": 1042
      },
      {
        "command_uuid": "cmd_004",
        "status": "success",
        "ticket_id": 35733,
        "changes": {
          "call_details": {
            "old": "Застревание пассажира",
            "delta": "Пассажир жалуется на духоту"
          }
        },
        "message": "Изменения применены"
      }
    ],
    "summary": {
      "success": 3,
      "archived": 1,
      "ignored": 0,
      "failed": 0,
      "duplicate_detected": 0
    },
    "created_tickets": {
      "offline_1761234567_x7k2p": 35740
    }
  }
}
```

---

### 7.2. Пример 2: Intra-batch mapping (CreateTicket + AddComment в одной пачке)

**Request:**

```json
{
  "action": "syncCommands",
  "batch_id": "batch_1761234568_abc123",
  "commands": [
    {
      "command_uuid": "cmd_100",
      "command_type": "CreateTicket",
      "offline_uuid": "offline_intra_001",
      "payload": {
        "offline_author_id": 3,
        "offline_author_name": "Иванов И.",
        "city_id": 1, "street_id": 2, "home_id": 3, "object_id": 11,
        "fullAddress": "...",
        "group_id": "8", "request_id": "2", "department_id": "22",
        "repair_time": 1761220800,
        "details": "Застревание",
        "staff_id": 3
      }
    },
    {
      "command_uuid": "cmd_101",
      "command_type": "AddComment",
      "ticket_id": null,
      "offline_uuid": "offline_intra_001",
      "payload": {
        "text": "Первый комментарий к только что созданной заявке"
      }
    }
  ]
}
```

**Response:**

```json
{
  "status": "ok",
  "data": {
    "batch_id": "batch_1761234568_abc123",
    "results": [
      {
        "command_uuid": "cmd_100",
        "status": "success",
        "ticket_id": 35750,
        "offline_uuid": "offline_intra_001",
        "message": "Заявка создана"
      },
      {
        "command_uuid": "cmd_101",
        "status": "success",
        "ticket_id": 35750,
        "note_id": 146,
        "message": "Комментарий добавлен к заявке №35750"
      }
    ],
    "summary": {
      "success": 2,
      "archived": 0,
      "ignored": 0,
      "failed": 0,
      "duplicate_detected": 0
    },
    "created_tickets": {
      "offline_intra_001": 35750
    }
  }
}
```

**Как это работает на сервере:**
1. `CreateTicket` (cmd_100) создаёт заявку с `call_id = 35750`.
2. Сервер сохраняет маппинг: `offline_intra_001 → 35750` в локальном словаре `$uuidToIdMap`.
3. `AddComment` (cmd_101) приходит с `ticket_id = null` и `offline_uuid = offline_intra_001`.
4. Сервер резолвит `ticket_id` из словаря: `35750`.
5. Комментарий добавляется к заявке 35750.

---

### 7.3. Пример 3: Обнаружение дублей (duplicate_detected)

**Request:**

```json
{
  "action": "syncCommands",
  "batch_id": "batch_1761234569_def456",
  "commands": [
    {
      "command_uuid": "cmd_200",
      "command_type": "CreateTicket",
      "offline_uuid": "offline_dup_001",
      "payload": {
        "offline_author_id": 3,
        "offline_author_name": "Иванов И.",
        "city_id": 1, "street_id": 2, "home_id": 3, "object_id": 11,
        "fullAddress": "...",
        "group_id": "5", "request_id": "3", "department_id": "22",
        "repair_time": 1761220800,
        "details": "Не горит свет в кабине",
        "staff_id": 3
      }
    }
  ]
}
```

**Response (первая попытка):**

```json
{
  "status": "ok",
  "data": {
    "batch_id": "batch_1761234569_def456",
    "results": [
      {
        "command_uuid": "cmd_200",
        "status": "duplicate_detected",
        "offline_uuid": "offline_dup_001",
        "reason": "duplicate_detected",
        "message": "На этот лифт уже есть открытая заявка №35732 (Застревание пассажира) от 02.11.2026. Вы уверены, что хотите создать новую?",
        "existing_tickets": [
          {
            "call_id": 35732,
            "details": "Застревание пассажира",
            "date": 1761214200,
            "group": "1.Застревание",
            "request": "Срочная"
          }
        ]
      }
    ],
    "summary": {
      "success": 0,
      "archived": 0,
      "ignored": 0,
      "failed": 0,
      "duplicate_detected": 1
    }
  }
}
```

**Поведение клиента:**
1. Показать модалку: «На этот лифт уже есть открытая заявка №35732 (Застревание пассажира). Создать новую?»
2. При подтверждении → повторить запрос с `force_create: true`.

**Повторный Request (с force_create):**

```json
{
  "action": "syncCommands",
  "batch_id": "batch_1761234570_ghi789",
  "commands": [
    {
      "command_uuid": "cmd_201",
      "command_type": "CreateTicket",
      "offline_uuid": "offline_dup_001",
      "force_create": true,
      "payload": {
        "offline_author_id": 3,
        "offline_author_name": "Иванов И.",
        "city_id": 1, "street_id": 2, "home_id": 3, "object_id": 11,
        "fullAddress": "...",
        "group_id": "5", "request_id": "3", "department_id": "22",
        "repair_time": 1761220800,
        "details": "Не горит свет в кабине",
        "staff_id": 3
      }
    }
  ]
}
```

**Response (повторный):**

```json
{
  "status": "ok",
  "data": {
    "batch_id": "batch_1761234570_ghi789",
    "results": [
      {
        "command_uuid": "cmd_201",
        "status": "success",
        "ticket_id": 35760,
        "offline_uuid": "offline_dup_001",
        "message": "Заявка создана (дубликаты подтверждены)"
      }
    ],
    "summary": { "success": 1, "archived": 0, "ignored": 0, "failed": 0, "duplicate_detected": 0 },
    "created_tickets": { "offline_dup_001": 35760 }
  }
}
```

---

### 7.4. Пример 4: Нет прав (архивация)

**Request** (механик пытается редактировать):

```json
{
  "action": "syncCommands",
  "batch_id": "batch_1761234571_jkl012",
  "commands": [
    {
      "command_uuid": "cmd_300",
      "command_type": "EditTicket",
      "ticket_id": 35732,
      "payload": {
        "description_delta": "Попытка редактирования механиком"
      }
    }
  ]
}
```

**Response:**

```json
{
  "status": "ok",
  "data": {
    "batch_id": "batch_1761234571_jkl012",
    "results": [
      {
        "command_uuid": "cmd_300",
        "status": "archived",
        "ticket_id": 35732,
        "reason": "no_rights",
        "message": "У вас нет прав на редактирование заявок. Действие сохранено в архив.",
        "archive_id": 1043
      }
    ],
    "summary": {
      "success": 0,
      "archived": 1,
      "ignored": 0,
      "failed": 0,
      "duplicate_detected": 0
    }
  }
}
```

---

### 7.5. Пример 5: `AcceptTicket` с уже уведомлённым

**Request:**

```json
{
  "action": "syncCommands",
  "batch_id": "batch_1761234572_mno345",
  "commands": [
    {
      "command_uuid": "cmd_400",
      "command_type": "AcceptTicket",
      "ticket_id": 35732,
      "payload": {
        "accepted_at": 1761234567
      }
    }
  ]
}
```

**Response** (если `call_staff_status = 2`):

```json
{
  "status": "ok",
  "data": {
    "batch_id": "batch_1761234572_mno345",
    "results": [
      {
        "command_uuid": "cmd_400",
        "status": "ignored",
        "ticket_id": 35732,
        "reason": "already_notified",
        "message": "Ответственный уже уведомлён. Статус не изменён.",
        "current_status": 2
      }
    ],
    "summary": {
      "success": 0,
      "archived": 0,
      "ignored": 1,
      "failed": 0,
      "duplicate_detected": 0
    }
  }
}
```

---

### 7.6. Пример 6: Заявка не найдена (архивация)

**Request** (заявка была удалена):

```json
{
  "action": "syncCommands",
  "batch_id": "batch_1761234573_pqr678",
  "commands": [
    {
      "command_uuid": "cmd_500",
      "command_type": "CloseTicket",
      "ticket_id": 99999,
      "payload": {
        "solution": "Попытка закрыть удалённую заявку"
      }
    }
  ]
}
```

**Response:**

```json
{
  "status": "ok",
  "data": {
    "batch_id": "batch_1761234573_pqr678",
    "results": [
      {
        "command_uuid": "cmd_500",
        "status": "archived",
        "ticket_id": 99999,
        "reason": "ticket_not_found",
        "message": "Заявка не найдена (возможно, удалена или архивирована). Действие отменено.",
        "archive_id": 1044
      }
    ],
    "summary": {
      "success": 0,
      "archived": 1,
      "ignored": 0,
      "failed": 0,
      "duplicate_detected": 0
    }
  }
}
```

**Важно:** Статус `archived` (не `failed`), чтобы избежать бесконечных retry. Фронтенд удалит команду из outbox и покажет уведомление.

---

### 7.7. Пример 7: Полная ошибка валидации верхнего уровня

**Request** (некорректный `action`):

```json
{
  "action": "syncCommands",
  "batch_id": "batch_1761234574_stu901",
  "commands": []
}
```

**Response:**

```json
{
  "status": "error",
  "error": {
    "code": "invalid_input",
    "message": "Массив commands не может быть пустым",
    "details": {
      "field": "commands",
      "rule": "min_length_1"
    }
  }
}
```

---

## 8. Обработка ошибок

### 8.1. Двухуровневая система ошибок

| Уровень | Код в ответе | Поведение клиента |
|---------|--------------|-------------------|
| **Уровень пачки** (валидация верхнего уровня) | `status: "error"` | Показать общую ошибку, не удалять из outbox |
| **Уровень команды** (бизнес-логика) | `status: "ok"` + `results[].status` | Обрабатывать каждую команду отдельно |

### 8.2. Ошибки уровня пачки (HTTP 200, но `status: error`)

| Код ошибки | Условие | HTTP-эквивалент |
|------------|---------|:---------------:|
| `invalid_action` | `action !== "syncCommands"` | 400 |
| `invalid_batch_id` | `batch_id` пустой / длинный | 400 |
| `commands_empty` | `commands.length < 1` | 400 |
| `commands_too_many` | `commands.length > 20` | 400 |
| `duplicate_command_uuid` | Повтор `command_uuid` в пачке | 400 |
| `invalid_command_structure` | Неверная структура элемента | 400 |
| `tenant_not_resolved` | Тенант не определён | 401 |
| `tenant_suspended` | Тенант приостановлен | 403 |
| `token_revoked` | Токен отозван | 401 |
| `rate_limited` | Превышен rate-limit | 429 |

**Формат:**

```json
{
  "status": "error",
  "error": {
    "code": "invalid_input",
    "message": "Массив commands не может быть пустым",
    "details": { "field": "commands", "rule": "min_length_1" }
  }
}
```

**Поведение клиента:** Вся пачка остаётся в `outbox`, retry через backoff.

### 8.3. Ошибки уровня команды

Обрабатываются через статусы `results[].status`:

| Статус | Поведение |
|--------|-----------|
| `archived` | Удалить из outbox, показать уведомление с причиной |
| `ignored` | Удалить из outbox, без уведомления |
| `failed` | Оставить в outbox, retry |
| `duplicate_detected` | Показать модалку, повторить с `force_create: true` |

---

## 9. Идемпотентность

### 9.1. Два уровня защиты

#### Уровень 1: `batch_id` (пачка)

- `UNIQUE` в `offline_sync_log`.
- При повторном `POST` с тем же `batch_id` → возврат сохранённого результата из лога.
- **Без повторного выполнения команд.**

**Пример:**
```
POST с batch_id = batch_123 → ответ А
Повторный POST с тем же batch_id = batch_123 → тот же ответ А (из кэша)
```

#### Уровень 2: `command_uuid` (команда)

- Проверяется в `offline_command_log` и `offline_actions_archive`.
- Если команда уже была обработана → `status: ignored` с `reason: already_processed`.

**Пример:**
```
Пачка с cmd_001, cmd_002 → обе success
Повторная пачка с cmd_001, cmd_003:
  - cmd_001 → ignored (already_processed)
  - cmd_003 → success (новая)
```

### 9.2. Генерация UUID на клиенте

```javascript
// UUID для пачки
function generateBatchId() {
  return `batch_${Date.now()}_${crypto.randomUUID().slice(0, 8)}`;
}

// UUID для команды
function generateCommandUuid() {
  return `cmd_${Date.now()}_${Math.random().toString(36).slice(2, 10)}`;
}

// UUID для CreateTicket (уникальный для заявки)
function generateOfflineUuid() {
  return `offline_${Date.now()}_${Math.random().toString(36).slice(2, 10)}`;
}
```

### 9.3. Что делать при retry

| Ситуация | Поведение |
|----------|-----------|
| Сеть оборвалась после ответа сервера, но до обработки клиентом | Повтор с тем же `batch_id` → возврат из кэша |
| Клиент пересоздал `batch_id` (баг) | `command_uuid` спасёт от дублирования |
| Некоторые команды успели выполниться | `command_uuid` пропустит выполненные, выполнит только новые |

---

## 10. Intra-batch mapping (связывание команд в пачке)

### 10.1. Назначение

Позволяет командам в одной пачке ссылаться друг на друга, даже если `ticket_id` ещё не известен на клиенте.

**Типичный сценарий:**
1. Диспетчер в офлайне создаёт заявку → `CreateTicket` с `offline_uuid = X`.
2. Сразу пишет к ней комментарий → `AddComment` с `offline_uuid = X` (но `ticket_id` ещё нет).
3. При синхронизации сервер связывает их.

### 10.2. Алгоритм на сервере

```php
// Локальный словарь для маппинга внутри пачки
$uuidToIdMap = [];

foreach ($commands as $command) {
    // 1. Резолвим ticket_id
    $ticketId = $command['ticket_id'] ?? null;
    
    if ($ticketId === null && !empty($command['offline_uuid'])) {
        // Ищем в словаре (создана в этой пачке)
        $ticketId = $uuidToIdMap[$command['offline_uuid']] ?? null;
        
        // Fallback: ищем в БД (старая заявка)
        if ($ticketId === null) {
            $existing = $this->callRepo->findByOfflineUuid($command['offline_uuid']);
            if ($existing) {
                $ticketId = (int) $existing['call_id'];
            }
        }
    }
    
    // 2. Обрабатываем команду
    $result = $this->processCommand($command, $user, $ticketId);
    
    // 3. Если это CreateTicket и успех — сохраняем в словарь
    if ($command['command_type'] === 'CreateTicket' 
        && $result['status'] === 'success') {
        $uuidToIdMap[$command['offline_uuid']] = $result['ticket_id'];
    }
}
```

### 10.3. Ограничения

- `offline_uuid` должен быть уникальным в пределах пачки.
- Нельзя ссылаться на `offline_uuid` из другой пачки (используйте `ticket_id`).
- Если `CreateTicket` не удался → все ссылающиеся на него команды вернут `failed` с `reason: missing_ticket_id`.
- Если `CreateTicket` получил `duplicate_detected` и пользователь подтвердил создание, фронтенд формирует **новый `batch_id`**, оставляет прежними `command_uuid` для всех зависимых команд и отправляет пачку с `force_create: true` для команды создания.

### 10.4. Сборка пачки по весу (Frontend)

Фронтенд не просто берет первые 20 команд, а собирает пачку, контролируя её вес:

```javascript
function buildBatch(commands) {
    const MAX_BATCH_WEIGHT = 3.5 * 1024 * 1024; // 3.5 МБ
    const batch = [];
    let currentWeight = 0;
    
    for (const cmd of commands) {
        const cmdWeight = JSON.stringify(cmd).length;
        
        // Если пачка уже не пуста и добавление команды превысит лимит — останавливаемся
        if (batch.length > 0 && currentWeight + cmdWeight > MAX_BATCH_WEIGHT) {
            break; 
        }
        
        batch.push(cmd);
        currentWeight += cmdWeight;
    }
    
    return batch;
}
```

---

## 11. Rate-limiting

### 11.1. Лимиты

| Параметр | Лимит | Период |
|----------|-------|--------|
| Запросов на пользователя | 60 | минута |
| Пачек на пользователя | 10 | минута |
| Команд в пачке | 20 | — |
| Размер запроса | 10 MB (Nginx `client_max_body_size`) | — |
| Вес пачки (JSON) | 3.5 MB | — |

### 11.2. Заголовки ответа

```http
X-RateLimit-Limit: 60
X-RateLimit-Remaining: 55
X-RateLimit-Reset: 1761234600
```

### 11.3. При превышении

```json
{
  "status": "error",
  "error": {
    "code": "rate_limited",
    "message": "Превышен лимит запросов. Повторите через 60 секунд.",
    "details": {
      "retry_after": 60,
      "limit": 60,
      "window": "1m"
    }
  }
}
```

### 11.4. Сжатие фото на клиенте

**Обязательная логика фронтенда:**

Перед добавлением команды `AddComment` в `outbox`, фронтенд обязан:

1. Прочитать файл фото.
2. Отрисовать его в `<canvas>` с ограничением:
   - Максимальный размер: **1280×1280 px** (сохраняя пропорции)
   - Формат: `image/jpeg`
   - Качество: **0.7** (70%)
3. Получить `dataURL` и извлечь base64-часть.
4. Проверить размер декодированных данных. Если > 500 КБ — повторить с меньшим качеством (0.5) или меньшим разрешением.
5. При невозможности сжать до 500 КБ — показать пользователю: «Фото слишком большое. Выберите другое или сделайте новый снимок.»

**Пример кода:**

```javascript
async function compressPhoto(file, maxSizeBytes = 500 * 1024) {
  const img = await createImageBitmap(file);
  const canvas = document.createElement('canvas');
  const MAX_DIM = 1280;
  const scale = Math.min(MAX_DIM / img.width, MAX_DIM / img.height, 1);
  canvas.width = img.width * scale;
  canvas.height = img.height * scale;
  
  const ctx = canvas.getContext('2d');
  ctx.drawImage(img, 0, 0, canvas.width, canvas.height);
  
  let quality = 0.7;
  let dataUrl;
  do {
    dataUrl = canvas.toDataURL('image/jpeg', quality);
    const base64 = dataUrl.split(',')[1];
    const sizeBytes = (base64.length * 3) / 4;
    if (sizeBytes <= maxSizeBytes) return dataUrl;
    quality -= 0.1;
  } while (quality >= 0.3);
  
  throw new Error('Не удалось сжать фото до 500 КБ');
}
```

---

## 12. Полная таблица кодов ошибок

### 12.1. Ошибки верхнего уровня (пачки)

| Код | HTTP (в теле) | Описание |
|-----|:-------------:|----------|
| `invalid_action` | 200 | Неверный `action` |
| `invalid_input` | 200 | Ошибка валидации payload |
| `invalid_batch_id` | 200 | Некорректный `batch_id` |
| `commands_empty` | 200 | Пустой массив `commands` |
| `commands_too_many` | 200 | Больше 20 команд |
| `duplicate_command_uuid` | 200 | Повтор `command_uuid` в пачке |
| `tenant_not_resolved` | 200 | Тенант не определён |
| `tenant_suspended` | 200 | Тенант приостановлен |
| `token_revoked` | 200 | Токен отозван |
| `rate_limited` | 200 | Превышен rate-limit |
| `unauthorized` | 200 | Нет/неверный Bearer-токен |

### 12.2. Ошибки уровня команды (через `results[].reason`)

| Код | Статус | Описание |
|-----|:------:|----------|
| `no_rights` | `archived` | Нет прав на действие |
| `ticket_already_closed` | `archived` | Заявка уже закрыта |
| `contract_terminated` | `archived` | Лифт скрыт (`vis=0`) |
| `photo_limit_exceeded` | `archived` | Лимит фото (2 шт.) превышен |
| `validation_error` | `archived` | Ошибка валидации payload |
| `ticket_not_found` | `archived` ✅ | Заявка не найдена (удалена/архивирована) |
| `duplicate_uuid` | `ignored` | `offline_uuid` уже существует |
| `already_processed` | `ignored` | Идемпотентность |
| `already_notified` | `ignored` | Уже уведомлён |
| `missing_ticket_id` | `failed` | Не удалось определить `ticket_id` |
| `duplicate_detected` | `duplicate_detected` | Активная заявка на объект уже есть |
| `server_error` | `failed` | Внутренняя ошибка сервера |

### 12.3. Матрица обработки клиентом

| Статус `results[].status` | Действие клиента | UI-индикатор |
|:-------------------------:|------------------|:--------------:|
| `success` | Удалить из outbox. Обновить `tickets_cache` из `created_tickets`. | ✅ Тост "Синхронизировано" |
| `archived` | Удалить из outbox. Показать уведомление с `reason` и `message`. | ⚠️ Жёлтый тост |
| `ignored` | Удалить из outbox. Без уведомления. | — (без тоста) |
| `failed` | Оставить в outbox. Инкремент `retry_count`. Retry через backoff. | 🔴 Красный индикатор |
| `duplicate_detected` | Показать модалку с `existing_tickets`. При подтверждении — повтор с `force_create: true`. | 💬 Диалог |

---

## 13. История API

`syncCommands` (v4.2) — это **первый production-ready эндпоинт** для офлайн-синхронизации в системе Lift-Calls.

Предыдущие экспериментальные наработки (`callNewOffline` из v4.1) не были выведены в продакшен и были заменены на более гибкую архитектуру `syncCommands` в v4.2, которая поддерживает не только создание заявок, но и их редактирование, закрытие, комментирование и принятие в работу.

---

## 📋 Чек-лист для реализации

### Бэкенд

- [ ] Создать `SyncCommandsController` с маршрутизацией `POST /calls/syncCommands`
- [ ] Создать `SyncCommandsService` с методами `handleCreateTicket`, `handleEditTicket`, `handleCloseTicket`, `handleAddComment`, `handleAcceptTicket`
- [ ] Реализовать `IntraBatchMapper` для связывания `offline_uuid` → `ticket_id`
- [ ] Создать таблицу `offline_actions_archive` (SQL из `OFFLINE_PROTOCOL.md`)
- [ ] Создать таблицу `offline_command_log`
- [ ] Создать таблицу `offline_sync_log`
- [ ] Обновить `CallService::callClose()` для сериализации комментариев в `call_full_note_history`
- [ ] Добавить поле `is_offline` в `lift_notes`
- [ ] Добавить поле `source` в `lift_history`
- [ ] Добавить поле `source` в `audit_log`
- [ ] Реализовать cron-задачи для очистки архива (30 дней)
- [ ] Добавить индекс `idx_calls_active_object` для проверки дублей
- [ ] Настроить rate-limiting (60 req/min)
- [ ] Настроить Nginx: `client_max_body_size 10M` для `/calls/syncCommands`

### Фронтенд (Desktop + Mobile)

- [ ] Обновить `offline-db.js` под новую схему `outbox` (с `command_type`, `payload`)
- [ ] Переписать `SyncManager` для работы с `syncCommands`
- [ ] Реализовать Snapshot Store + Optimistic UI
- [ ] Добавить экран «Очередь»
- [ ] Реализовать модалку `duplicate_detected` с `force_create`
- [ ] Реализовать retry-стратегию с backoff
- [ ] Добавить UI-индикаторы (🟢🟡🔴)
- [ ] Реализовать `compressPhoto()` для сжатия фото до 500 КБ
- [ ] Реализовать `buildBatch()` с контролем веса 3.5 MB

### Тестирование

- [ ] Unit-тесты для `SyncCommandsService` (все 5 типов команд)
- [ ] Тесты идемпотентности (`batch_id`, `command_uuid`, `offline_uuid`)
- [ ] Тесты Intra-batch mapping (`CreateTicket` + `AddComment`)
- [ ] Тесты Soft Merge (`EditTicket` с разными условиями)
- [ ] Тесты архивации (`no_rights`, `ticket_already_closed`, `photo_limit_exceeded`, `ticket_not_found`)
- [ ] E2E сценарии: обрыв связи, двойное закрытие, конфликт прав
- [ ] Нагрузочное тестирование: 20 команд в пачке, 60 req/min

---

**Конец `API_syncCommands.md` (v4.2).**
```

---
