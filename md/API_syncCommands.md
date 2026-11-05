**v5.2**. Изменения от v5.1 помечены значком 🔄.

---

```markdown
# 📋 API_PROTOCOL.md — Приложение: Синхронизация офлайн-команд (`syncCommands`)

**Версия:** 5.2
**Статус:** Актуально (согласовано)
**Дата:** 06.11.2026
**База данных:** MariaDB 10.11+

**Изменения от v5.1:**

- 🔄 Q1: `force_create` — **только на уровне команды**, убран из «Опциональные поля payload» (§4.2)
- 🔄 Q2: Автокоррекция `opened_at > now + 1d` (защита от сбитых часов) (§4.2)
- 🔄 Q3: Автокоррекция `solution` без `closed_at` — `closed_at = now` + предупреждение (§4.2)
- 🔄 Q5: Объекты с `object.vis = 0` **не блокируют создание** офлайн-заявки — заявка создаётся, в историю пишется пометка «объект выведен из обслуживания» (§7.6)
- 🔄 Q8: `get_tenant_info` при неизвестном домене → `status: "error", code: "tenant_not_found"`
- 🔄 Q9: Кэширование `get_tenant_info` — фронт сам, `localStorage`, TTL 5 минут
- 🔄 Q10: Полная структура ответа `ticket` (§12.2)
- 🔄 §4.2: `contract_terminated` больше не используется при создании заявки (остаётся только для глобальных случаев — расторжение договора с организацией)
- ✅ Валидация `closed_at < opened_at` — автокоррекция (без изменений)
- ✅ Удалён `ticket_deleted` (без изменений)
- ✅ `AcceptTicket` → `reserved_for_mobile` (без изменений)
- ✅ `photo_base64` удалён из `AddComment` (без изменений)
- 🔄§7.7: отмена закрытия возможна только в процессе; после сохранения — точка, единственный путь — «Закрыть и создать новую».
  **Связанные документы:** `OFFLINE_PROTOCOL.md` v3.0, `API_PROTOCOL.md` v4.2, `AUTH_PROTOCOL.md` v2.0, `TECHNICAL_DEBT.md` v3.0

---

## 📑 Содержание

1. Обзор эндпоинта
2. Авторизация и мультитенантность
3. Request: общая структура
4. Типы команд и payload
5. Response: общая структура
6. Статусы результатов
7. Поведение офлайн-заявок
8. Обработка ошибок
9. Идемпотентность
10. Rate-limiting
11. Полная таблица кодов ошибок
12. Связанные эндпоинты
13. История API

---

## 1. Обзор эндпоинта

### 1.1. Endpoint
```

POST https://api.liftcs.ru/calls/syncCommands

````

**Назначение:** Универсальный эндпоинт для пакетной синхронизации офлайн-действий: создание, редактирование, закрытие, комментирование.

### 1.2. HTTP-характеристики

| Параметр | Значение |
|---|---|
| Метод | `POST` |
| Content-Type | `application/json; charset=utf-8` |
| Accept | `application/json` |
| Таймаут клиента | 30 секунд |
| Максимальный размер запроса | **10 MB** (Nginx `client_max_body_size`) |
| Максимальный вес пачки | **3.5 MB** (JSON) |
| Максимум команд в пачке | 20 |
| HTTP-статус | Всегда `200 OK` (ошибки в теле) |

### 1.3. Поддерживаемые типы команд

| Тип | Кто может отправлять | Статус |
|---|---|---|
| `CreateTicket` | Только `administrator` / `dispatcher` | ✅ Production |
| `EditTicket` | Только `administrator` / `dispatcher` | ✅ Production |
| `CloseTicket` | `administrator`, `dispatcher`, `engineer` | ✅ Production |
| `AddComment` | `administrator`, `dispatcher`, `engineer` | ✅ Production |
| `AcceptTicket` | — | ⚠️ `reserved_for_mobile` |

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
````

| Заголовок       | Обязательно | Описание                                    |
| --------------- | :---------: | ------------------------------------------- |
| `Authorization` |     ✅      | Bearer-токен (access)                       |
| `X-Tenant`      |     ⚠️      | Обязателен, если тенант не определён по JWT |
| `Content-Type`  |     ✅      | `application/json`                          |
| `Accept`        |     ✅      | `application/json`                          |

### 2.2. Роли и права

| Роль                 | `CreateTicket` | `EditTicket` | `CloseTicket` | `AddComment` |
| -------------------- | :------------: | :----------: | :-----------: | :----------: |
| `administrator`      |       ✅       |      ✅      |      ✅       |      ✅      |
| `dispatcher`         |       ✅       |      ✅      |      ✅       |      ✅      |
| `engineer` (механик) |       ❌       |      ❌      |      ✅       |      ✅      |
| `guest`              |       ❌       |      ❌      |      ❌       |      ❌      |

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
      "command_type": "CreateTicket | EditTicket | CloseTicket | AddComment",
      "ticket_id": "integer | null",
      "offline_uuid": "string | null",
      "payload": { ... },
      "force_create": "boolean (опционально, только для CreateTicket)"
    }
  ]
}
```

### 3.2. Обязательные поля верхнего уровня

| Поле       | Тип    | Обязательно | Описание                              |
| ---------- | ------ | :---------: | ------------------------------------- |
| `action`   | string |     ✅      | Всегда `"syncCommands"`               |
| `batch_id` | string |     ✅      | UUID v4 пачки (генерируется клиентом) |
| `commands` | array  |     ✅      | Массив команд (1–20 элементов)        |

### 3.3. Валидация верхнего уровня

| Условие                               | Ошибка                                  |
| ------------------------------------- | --------------------------------------- |
| `action !== "syncCommands"`           | `invalid_input: invalid_action`         |
| `batch_id` пустой или > 64 символов   | `invalid_input: invalid_batch_id`       |
| `commands.length < 1`                 | `invalid_input: commands_empty`         |
| `commands.length > 20`                | `invalid_input: commands_too_many`      |
| Дубликаты `command_uuid` внутри пачки | `invalid_input: duplicate_command_uuid` |

---

## 4. Типы команд и payload

### 4.1. Общие поля команды

| Поле           | Тип             | Обязательно | Описание                                                                                        |
| -------------- | --------------- | :---------: | ----------------------------------------------------------------------------------------------- |
| `command_uuid` | string          |     ✅      | Уникальный ID команды (`cmd_<ts>_<rand>`)                                                       |
| `command_type` | enum            |     ✅      | `CreateTicket` \| `EditTicket` \| `CloseTicket` \| `AddComment`                                 |
| `ticket_id`    | integer \| null |     ⚠️      | ID заявки с сервера. `null` для `CreateTicket`                                                  |
| `offline_uuid` | string \| null  |     ⚠️      | UUID заявки (для `CreateTicket`)                                                                |
| `payload`      | object          |     ✅      | Данные команды                                                                                  |
| `force_create` | boolean         |     ❌      | **Только на уровне команды** (не в payload). Только для `CreateTicket`. Обходит проверку дублей |

**Важно:** `force_create` — мета-флаг поведения сервера, **не часть данных заявки**. На уровне команды, не в `payload`.

---

### 4.2. `CreateTicket` (Создание заявки)

**Права:** Только `administrator` / `dispatcher`
**Особенности:** Использует `offline_uuid` вместо `ticket_id`. Поддерживает расширенный контракт для офлайн-заявок (§7).

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
  "opened_at": 1761219000,
  "comments": "⏳ [Офлайн-комментарии]\n[Иванов И., 02.11.2026 14:30]: Выехал на объект\n[Петров П., 02.11.2026 14:45]: На месте",
  "solution": "Заменён контактор",
  "closed_at": 1761234567,
  "closed_by_name": "Петров Пётр",
  "closed_by_id": 3
}
```

#### Обязательные поля payload

| Поле                  | Тип         | Обязательно | Описание                                             |
| --------------------- | ----------- | :---------: | ---------------------------------------------------- |
| `offline_author_id`   | int         |     ✅      | ID автора (с устройства)                             |
| `offline_author_name` | string      |     ✅      | ФИО автора                                           |
| `city_id`             | string\|int |     ✅      | ID города                                            |
| `street_id`           | string\|int |     ✅      | ID улицы                                             |
| `home_id`             | string\|int |     ✅      | ID дома                                              |
| `object_id`           | string\|int |     ✅      | ID лифта                                             |
| `fullAddress`         | string      |     ✅      | Полный адрес                                         |
| `group_id`            | string      |     ✅      | ID группы лифтов                                     |
| `request_id`          | string      |     ✅      | ID типа неисправности                                |
| `department_id`       | string      |     ✅      | ID отдела                                            |
| `repair_time`         | int         |     ✅      | Unix timestamp планируемого устранения               |
| `details`             | string      |     ✅      | Описание (мин. 6 символов)                           |
| `staff_id`            | int         |     ✅      | ID ответственного                                    |
| `opened_at`           | int         |     ✅      | Unix timestamp, когда пользователь нажал «Сохранить» |

#### Опциональные поля payload (расширение для офлайн-заявок)

| Поле              | Тип    | Описание                                                                                                                                                     |
| ----------------- | ------ | ------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| `comments`        | string | Единый текст офлайн-комментариев (`⏳ [Офлайн-комментарии]\n[Автор, дата]: текст\n...`). Сервер сохраняет как одну заметку в `lift_notes` с `is_offline = 1` |
| `solution`        | string | Текст решения, если заявка закрыта офлайн                                                                                                                    |
| `closed_at`       | int    | Unix timestamp закрытия если отсутствует то применяем автокерекцию                                                                                           |
| `closed_by_name`  | string | ФИО закрывшего (если закрыта офлайн)                                                                                                                         |
| `closed_by_id`    | int    | ID закрывшего (если закрыта офлайн)                                                                                                                          |
| `call_phone`      | string | Телефон заявителя                                                                                                                                            |
| `call_first_name` | string | Имя заявителя                                                                                                                                                |
| `call_last_name`  | string | Фамилия заявителя                                                                                                                                            |

**Убрано (по Q1):** `force_create` **не** передаётся в payload. Только на уровне команды.

#### Валидация payload

| Условие                          | Код ошибки / Поведение                                                                     |
| -------------------------------- | ------------------------------------------------------------------------------------------ |
| `details` < 6 символов           | `validation_error: details_too_short` → `archived`                                         |
| `repair_time` < `now`            | `validation_error: repair_time_in_past` → `archived`                                       |
| `staff_id` не существует         | `validation_error: staff_not_found` → `archived`                                           |
| `object_id` не существует        | `validation_error: object_not_found` → `archived`                                          |
| `group_id` вне доступа           | `forbidden: group_not_allowed` → `archived`                                                |
| `solution` есть, но < 6 символов | `validation_error: solution_too_short` → `archived`                                        |
| `solution` есть, `closed_at` нет | **Автокоррекция:** `closed_at = now` + предупреждение (см. ниже)                           |
| `closed_at < opened_at`          | **Автокоррекция:** `closed_at = opened_at` + предупреждение                                |
| `opened_at > now + 1 день`       | **Автокоррекция:** `opened_at = now` + предупреждение                                      |
| `object.vis = 0` (лифт выведен)  | **Заявка создаётся**, в `lift_history` пометка «объект выведен из обслуживания» (см. §7.6) |

#### 🔄 Автокоррекции (все три логируются)

**1. `opened_at > now + 1 день`** (защита от сбитых часов устройства):

- Сервер использует `now` вместо `opened_at` для поля `call_date`.
- В лог пишется: `opened_at is in the future (> now + 1d), auto-corrected to now`.
- В `comments` (или `call_details`, если `comments` пуст) добавляется строка:
  ```
  ⏳ [Автокоррекция даты] Исходная дата создания офлайн: 01.01.2030 12:00. Скорректировано на системную: 06.11.2026 15:30.
  ```

**2. `closed_at < opened_at`**:

- `closed_at = opened_at`.
- В лог: `closed_at < opened_at, auto-corrected`.
- Заявка создаётся как закрытая.

**3. `solution` есть, `closed_at` нет**:

- `closed_at = now`.
- В лог: `solution provided without closed_at, auto-corrected to now`.
- Заявка создаётся как закрытая.

**Обоснование:** пользователь не может исправить эти ошибки постфактум (команда уже в `outbox`), а отправка в архив лишает его результата работы.

#### Поведение сервера при наличии `solution` + `closed_at`

1. Создать заявку.
2. Установить `call_status = 1`, `call_solution = solution`, `call_close_date = closed_at`, `call_close_name = closed_by_name`.
3. Применить `comments` как одну заметку в `lift_notes` с `is_offline = 1`.
4. Записать событие в `lift_history` с `source = 'offline_sync'`.

---

### 4.3. `EditTicket` (Редактирование серверной заявки)

**Права:** Только `administrator` / `dispatcher`
**Особенности:** Soft Merge. **Используется только для серверных заявок.** Для офлайн-заявок правки сворачиваются в `CreateTicket` (§7).

#### Payload

```json
{
  "description_delta": "Текст дополнения к описанию",
  "staff_id": 5,
  "repair_time": 1761230000,
  "notify_status": 2
}
```

#### Поля payload (все опциональные, минимум одно обязательно)

| Поле                | Тип       | Soft Merge правило                                                                           |
| ------------------- | --------- | -------------------------------------------------------------------------------------------- |
| `description_delta` | string    | **Всегда применяется:** `call_details = CONCAT(old, '\n\n[Оффлайн <user> <date>]\n', delta)` |
| `staff_id`          | int       | Только если `call_staff = 0`                                                                 |
| `repair_time`       | int       | Только если `expected_repair_time = 0`                                                       |
| `notify_status`     | int (0-7) | Только если `call_staff_status = 0`                                                          |
| `group_id`          | string    | Только если `call_group = 0`                                                                 |
| `request_id`        | string    | Только если `call_request = 0`                                                               |

#### Валидация payload

| Условие                            | Код ошибки                                          |
| ---------------------------------- | --------------------------------------------------- |
| Все поля пустые                    | `validation_error: edit_payload_empty` → `archived` |
| `description_delta` < 6 символов   | `validation_error: delta_too_short` → `archived`    |
| Заявка закрыта (`call_status = 1`) | `ticket_already_closed` → `archived`                |

---

### 4.4. `CloseTicket` (Закрытие серверной заявки)

**Права:** `administrator`, `dispatcher`, `engineer`
**Особенности:** При закрытии все комментарии из `lift_notes` сериализуются в `call_full_note_history` (JSON) и удаляются из таблицы. **Используется только для серверных заявок.**

#### Payload

```json
{
  "solution": "Произведена очистка контактов реле и замена предохранителя.",
  "closed_at": 1761234567
}
```

#### Валидация payload

| Условие                 | Код ошибки                                          |
| ----------------------- | --------------------------------------------------- |
| `solution` < 6 символов | `validation_error: solution_too_short` → `archived` |
| Заявка закрыта          | `ticket_already_closed` → `archived`                |

---

### 4.5. `AddComment` (Добавление комментария к серверной заявке)

**Права:** `administrator`, `dispatcher`, `engineer`
**Особенности:** Фото — только онлайн, в офлайн-очередь не попадает.

#### Payload

```json
{
  "text": "Текст комментария, примечания или отчёта мастера",
  "created_at": 1761234500
}
```

#### Валидация payload

| Условие             | Код ошибки                                      |
| ------------------- | ----------------------------------------------- |
| `text` < 6 символов | `validation_error: text_too_short` → `archived` |
| Заявка закрыта      | `ticket_already_closed` → `archived`            |

**Фото:** если пользователь прикрепил фото при офлайне — UI показывает «Фото доступно только онлайн» и не отправляет команду. Фото-путь через `callnote` (онлайн) с `photo_base64` описан в `API_PROTOCOL.md v4.2`.

---

### 4.6. `AcceptTicket` — reserved_for_mobile

**Статус:** ❌ Не реализуется на десктопе. Зарезервировано для мобильного клиента.

#### Payload (когда будет реализовано)

```json
{
  "accepted_at": 1761234567
}
```

Правила: `call_staff_status` → `2` (WEB), только если текущий `0`. Если уже `!= 0` → `ignored` с `reason: already_notified`.

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

### 5.2. Поля `data`

| Поле              | Тип    | Описание                             |
| ----------------- | ------ | ------------------------------------ |
| `batch_id`        | string | ID пачки (из запроса)                |
| `results`         | array  | Массив результатов по каждой команде |
| `summary`         | object | Сводка по пачке                      |
| `created_tickets` | object | Маппинг `offline_uuid → server_id`   |

### 5.3. Структура элемента `results[]`

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
  "existing_tickets": [
    {
      "call_id": 35732,
      "details": "Не горит свет в кабине",
      "date": 1761214200
    }
  ]
}
```

---

## 6. Статусы результатов

### 6.1. Таблица статусов

| Статус               | Описание           | Действие клиента                                        |
| -------------------- | ------------------ | ------------------------------------------------------- |
| `success`            | Команда выполнена  | Удалить из `outbox`. Обновить `tickets_cache`. ✅ Тост  |
| `archived`           | Действие отброшено | Удалить из `outbox`. ⚠️ Жёлтый тост с `reason`          |
| `ignored`            | Идемпотентность    | Удалить из `outbox`. Без тоста                          |
| `failed`             | Критическая ошибка | Оставить в `outbox`. Retry. 🔴 Тост после `MAX_RETRIES` |
| `duplicate_detected` | Дубликат на объект | Модалка. При подтверждении — `force_create: true`       |

### 6.2. Матрица статусов по типам команд

| Команда                |           Успех            |                                  Архивация                                   | Игнорирование |     Ошибка     |
| ---------------------- | :------------------------: | :--------------------------------------------------------------------------: | :-----------: | :------------: |
| `CreateTicket`         |         ✅ создана         |    `no_rights`, `validation_error`, `duplicate_uuid`, `ticket_not_found`     |       —       | `server_error` |
| `EditTicket`           |        ✅ изменения        | `no_rights`, `ticket_already_closed`, `ticket_not_found`, `validation_error` |       —       | `server_error` |
| `CloseTicket`          |         ✅ закрыта         |                 `ticket_already_closed`, `ticket_not_found`                  |       —       | `server_error` |
| `AddComment`           |        ✅ добавлен         |       `ticket_already_closed`, `ticket_not_found`, `validation_error`        |       —       | `server_error` |
| `CreateTicket` (дубль) | ✅ создан (`force_create`) |                                      —                                       |       —       |       —        |

**Важно:** причина `contract_terminated` **не используется** для `CreateTicket` при `object.vis = 0`. Такая заявка создаётся (см. §7.6). `contract_terminated` остаётся только для случаев глобального расторжения договора с организацией (тенант заблокирован).

---

## 7. Поведение офлайн-заявок

### 7.1. Вариант А: всё офлайн-редактирование сворачивается в `CreateTicket`

**Логика фронта:**

Пользователь создал заявку офлайн (`offline_uuid = X`). Пока она не синхронизирована:

- **Редактирование** (описание, отдел, ответственный, время ремонта) → не создаёт `EditTicket`, а сливает `patch` в `payload` существующего `CreateTicket` в outbox.
- **Комментарий** → не создаёт `AddComment`, а дописывает строку в `payload.comments` (единый текст с автором, датой и иконкой ⏳).
- **Закрытие** → не создаёт `CloseTicket`, а добавляет в `payload` поля `solution`, `closed_at`, `closed_by_name`, `closed_by_id`.

**Итог:** на сервер уходит **один пакет `CreateTicket`** с финальным состоянием. Никаких промежуточных «висящих» команд.

### 7.2. Формат `payload.comments`

Фронт формирует единую строку:

```
⏳ [Офлайн-комментарии]
[Иванов И., 02.11.2026 14:30]: Выехал на объект
[Петров П., 02.11.2026 14:45]: На месте, работаю
[Иванов И., 02.11.2026 15:10]: Заявка закрыта. Решение: замена реле
```

**Сервер:**

- Если заявка открыта — сохраняет `comments` как одну заметку в `lift_notes` с `is_offline = 1`.
- Если закрыта — сохраняет как одну заметку перед закрытием, затем сериализует в `call_full_note_history`.

**Примечание:** единая строка выбрана как упрощение для десктопа. В будущем (мобильный клиент) возможен переход на массив объектов — бэк создаст отдельную заметку для каждого комментария.

### 7.3. Формат `payload.solution` + `closed_at` + `closed_by_name`

```json
{
  ...,
  "solution": "Заменён контактор",
  "closed_at": 1761234567,
  "closed_by_name": "Петров Пётр",
  "closed_by_id": 3
}
```

**Сервер:**

1. Создаёт заявку.
2. Устанавливает `call_status = 1`, `call_solution`, `call_close_date`, `call_close_name`.
3. Записывает событие в `lift_history` с `source = 'offline_sync'`.

### 7.4. Что остаётся в outbox

Только один `CreateTicket` с обновлённым `payload`. `EditTicket`, `AddComment`, `CloseTicket` для офлайн-заявки **не создаются**.

### 7.5. Intra-batch mapping (для будущего мобильного клиента)

Если мобильный клиент захочет отправлять `CreateTicket` + `AddComment` + `CloseTicket` отдельными командами — Intra-batch mapping остаётся в силе. Сервер связывает их через `offline_uuid` в одной пачке.

### 🔄 7.6. Объекты с `vis = 0` (выведены из обслуживания)

Если `object_id` указывает на лифт с `object.vis = 0` на момент синхронизации (лифт выведен из обслуживания между созданием офлайн и отправкой):

**Сервер:** создаёт заявку **без ошибки**, но:

- В `lift_history` записывает событие с `source = 'offline_sync'` и пометкой «объект выведен из обслуживания на момент синхронизации».
- Заявка попадает в открытые, её позже закроют вручную с пометкой «выведен из обслуживания».

**Обоснование:** данные офлайн-работы пользователя не теряются. Если объект уже не обслуживается — диспетчер закроет заявку с нужной пометкой.

Понял, полностью согласен. Термина «переоткрыть» в системе нет вообще. Есть только «Закрыть и создать новую для этого объекта» — и это **создание новой заявки**, а не возрождение старой.

Вот исправленный пункт:

---

### 🔄 7.7. Закрытая заявка (онлайн или офлайн) — финальное состояние

**Бизнес-правило Lift-Calls:** закрытая заявка не может быть переоткрыта. После применения закрытия (онлайн — ушло на сервер; офлайн — легло в `outbox`) заявка считается завершённой. Точка.

**Единственный способ продолжить работу по этому объекту** — закрыть текущую заявку с галочкой «**Закрыть и создать новую для этого объекта**». При этом:

1. Текущая заявка закрывается (как обычно).
2. Через `appState.pendingCreateAddress` открывается форма **создания новой заявки** с предзаполненным адресом (и ссылкой `from_ticket_id` на предыдущую).
3. Новая заявка — это **отдельная сущность** с новым `ticket_id`, новой историей, новыми комментариями. Она никак не связана с закрытой, кроме адреса.

**Это не «переоткрытие»** — это создание новой заявки. Термин «переоткрыть» в системе не используется и не должен использоваться в документации, чтобы не путать.

**Офлайн-закрытая заявка** с точки зрения UI ведёт себя **идентично онлайн-закрытой**:

- Скрыта кнопка «✏️ Редактировать».
- Скрыта кнопка «🔒 Закрыть заявку».
- Показан статус закрытия.

**Единственное отличие в отображении:** до синхронизации вместо «ЗАКРЫТА» — «⏳ ЗАКРЫТА ЛОКАЛЬНО» + баннер «Ожидает синхронизации». Это чисто информационное различие, никакой разницы в правах или действиях.

**Галочка «Закрыть и создать новую»** работает в офлайне так же, как в онлайне: закрытие кладётся в `outbox` (сворачивается в `CreateTicket.payload` по §7), а `appState.pendingCreateAddress` заполняется для формы создания. Никаких дополнительных полей в `CreateTicket` для этого не нужно — связь между заявками только через `from_ticket_id` в `appState` (это UI-состояние, не данные).

---

## 8. Обработка ошибок

### 8.1. Двухуровневая система

| Уровень         | Код в ответе                        | Поведение клиента                         |
| --------------- | ----------------------------------- | ----------------------------------------- |
| Уровень пачки   | `status: "error"`                   | Общая ошибка, не удалять из outbox, retry |
| Уровень команды | `status: "ok"` + `results[].status` | Обрабатывать каждую команду отдельно      |

### 8.2. Ошибки уровня пачки

| Код                      | Условие                       |
| ------------------------ | ----------------------------- |
| `invalid_action`         | `action !== "syncCommands"`   |
| `invalid_input`          | Ошибка валидации payload      |
| `invalid_batch_id`       | `batch_id` пустой / длинный   |
| `commands_empty`         | `commands.length < 1`         |
| `commands_too_many`      | `commands.length > 20`        |
| `duplicate_command_uuid` | Повтор `command_uuid` в пачке |
| `tenant_not_resolved`    | Тенант не определён           |
| `tenant_suspended`       | Тенант приостановлен          |
| `token_revoked`          | Токен отозван                 |
| `rate_limited`           | Превышен rate-limit           |

### 8.3. Ошибки уровня команды

| Статус               | Поведение клиента                         |
| -------------------- | ----------------------------------------- |
| `archived`           | Удалить из outbox, жёлтый тост с `reason` |
| `ignored`            | Удалить из outbox, без тоста              |
| `failed`             | Оставить в outbox, retry с backoff        |
| `duplicate_detected` | Модалка, повторить с `force_create: true` |

---

## 9. Идемпотентность

### 9.1. Два уровня защиты

**Уровень 1: `batch_id` (пачка)** — `UNIQUE` в `offline_sync_log`. При повторном POST с тем же `batch_id` → возврат сохранённого результата из лога. Без повторного выполнения команд.

**Уровень 2: `command_uuid` (команда)** — проверяется в `offline_command_log` и `offline_actions_archive`. Если команда уже обработана → `status: ignored` с `reason: already_processed`.

### 9.2. TTL (по Q7)

| Таблица                   | TTL     | Обоснование                                                          |
| ------------------------- | ------- | -------------------------------------------------------------------- |
| `offline_command_log`     | 7 дней  | Защита от дублей в пределах разумного retry-периода                  |
| `offline_sync_log`        | 30 дней | Retry может прийти позже (пользователь был офлайн), нужен кэш ответа |
| `offline_actions_archive` | 30 дней | Просмотр истории архивированных действий (UI)                        |

Cron-задачи чистят таблицы раз в сутки.

### 9.3. Генерация UUID на клиенте

```javascript
function generateBatchId() {
  return `batch_${Date.now()}_${crypto.randomUUID().slice(0, 8)}`;
}
function generateCommandUuid() {
  return `cmd_${Date.now()}_${Math.random().toString(36).slice(2, 10)}`;
}
function generateOfflineUuid() {
  return `offline_${Date.now()}_${Math.random().toString(36).slice(2, 10)}`;
}
```

Фронт уже реализует это в `utils/uuid.js`.

### 9.4. Что делать при retry

| Ситуация                                      | Поведение                             |
| --------------------------------------------- | ------------------------------------- |
| Сеть оборвалась после ответа, но до обработки | Повтор с тем же `batch_id` → кэш      |
| Клиент пересоздал `batch_id`                  | `command_uuid` спасёт от дублирования |
| Некоторые команды выполнились                 | `command_uuid` пропустит выполненные  |

Фронт уже реализует это: `_getOrCreateBatchId` в `sync-manager.js`.

---

## 10. Rate-limiting

### 10.1. Лимиты

| Параметр                 | Лимит  | Период |
| ------------------------ | ------ | ------ |
| Запросов на пользователя | 60     | минута |
| Пачек на пользователя    | 10     | минута |
| Команд в пачке           | 20     | —      |
| Размер запроса           | 10 MB  | —      |
| Вес пачки (JSON)         | 3.5 MB | —      |

### 10.2. При превышении

```json
{
  "status": "error",
  "error": {
    "code": "rate_limited",
    "message": "Превышен лимит запросов. Повторите через 60 секунд.",
    "details": { "retry_after": 60, "limit": 60, "window": "1m" }
  }
}
```

Фронт уже обрабатывает: `rate_limited` → `cooldownUntil` + `notify.syncError`.

---

## 11. Полная таблица кодов ошибок

### 11.1. Ошибки верхнего уровня (пачки)

| Код                      | Описание                  |
| ------------------------ | ------------------------- |
| `invalid_action`         | Неверный `action`         |
| `invalid_input`          | Ошибка валидации payload  |
| `invalid_batch_id`       | Некорректный `batch_id`   |
| `commands_empty`         | Пустой массив             |
| `commands_too_many`      | Больше 20 команд          |
| `duplicate_command_uuid` | Повтор `command_uuid`     |
| `tenant_not_resolved`    | Тенант не определён       |
| `tenant_suspended`       | Тенант приостановлен      |
| `token_revoked`          | Токен отозван             |
| `rate_limited`           | Превышен rate-limit       |
| `unauthorized`           | Нет/неверный Bearer-токен |

### 11.2. Ошибки уровня команды (`results[].reason`)

| Код                     |        Статус        | Описание                                                                                                  |
| ----------------------- | :------------------: | --------------------------------------------------------------------------------------------------------- |
| `no_rights`             |      `archived`      | Нет прав на действие                                                                                      |
| `ticket_already_closed` |      `archived`      | Заявка уже закрыта                                                                                        |
| `ticket_not_found`      |      `archived`      | Заявка не найдена                                                                                         |
| `contract_terminated`   |      `archived`      | Расторгнут договор с организацией (тенант заблокирован). **НЕ применяется** к `object.vis = 0` (см. §7.6) |
| `validation_error`      |      `archived`      | Ошибка валидации payload                                                                                  |
| `duplicate_uuid`        |      `ignored`       | `offline_uuid` уже существует                                                                             |
| `already_processed`     |      `ignored`       | Идемпотентность                                                                                           |
| `duplicate_detected`    | `duplicate_detected` | Активная заявка на объект есть                                                                            |
| `missing_ticket_id`     |       `failed`       | Не удалось определить `ticket_id`                                                                         |
| `server_error`          |       `failed`       | Внутренняя ошибка сервера                                                                                 |

**Примечание:** `ticket_deleted` не используется — при удалении/архивации заявки сервер возвращает `ticket_not_found` → `archived`.

### 11.3. Матрица обработки клиентом

|        Статус        | Действие                                           |          UI          |
| :------------------: | -------------------------------------------------- | :------------------: |
|      `success`       | Удалить из outbox. Обновить `tickets_cache`.       |       ✅ Тост        |
|      `archived`      | Удалить из outbox. Показать `reason` и `message`.  |    ⚠️ Жёлтый тост    |
|      `ignored`       | Удалить из outbox. Без уведомления.                |          —           |
|       `failed`       | Оставить в outbox. Инкремент `retry_count`.        | 🔴 Красный индикатор |
| `duplicate_detected` | Модалка. При подтверждении — `force_create: true`. |      💬 Диалог       |

---

## 12. Связанные эндпоинты

### 🔄 12.1. `get_tenant_info` (Публичный, без авторизации)

Вызывается на этапе загрузки SPA (страница логина, шапка) до авторизации. Тенант определяется по заголовку `Host`.

**Request:**

```json
POST /api.php
Content-Type: application/json

{ "action": "get_tenant_info" }
```

**Response (успех):**

```json
{
  "status": "ok",
  "data": {
    "org_name": "ООО «Лифт-Сервис»"
  }
}
```

**Response (домен не привязан к организации):**

```json
{
  "status": "error",
  "code": "tenant_not_found",
  "message": "Организация для этого домена не найдена"
}
```

Страница логина в этом случае показывает «Сервис недоступен для этого домена».

**Кэширование (по Q9):** Фронт сам кэширует в `localStorage` с TTL 5 минут. При старте SPA: сначала показать из кэша (мгновенно), параллельно обновить с сервера.

### 🔄 12.2. `ticket` (Запрос одной заявки)

**Request:**

```json
{ "data": "ticket", "call_id": 35732 }
```

**Response:**

```json
{
  "status": "ok",
  "data": {
    "call_id": 35732,
    "call_number": "35732",
    "type": "open",
    "fullAddress": "...",
    "city_id": 1,
    "street_id": 2,
    "home_id": 3,
    "object_id": 11,
    "details": "...",
    "date": 1761214200,
    "repair_time": 1761220800,
    "department": "Электромеханики",
    "department_id": "22",
    "group": "1.Застревание",
    "group_id": "8",
    "elevator_group_id": null,
    "elevator_group_name": null,
    "request": "Срочная",
    "request_id": "2",
    "alert_level": 1,
    "is_emergency": false,
    "other": "Есть заметки (2)",
    "note_num": 2,

    "staff_id": 3,
    "staff_name": "Иванов И.",
    "staff_phone": "+7...",
    "notify_status": 1,
    "notify_date": 1761215000,
    "staff_id2": null,
    "staff_name2": null,
    "staff_phone2": null,
    "notify_status2": null,
    "notify_date2": null,
    "staff_id3": null,
    "staff_name3": null,
    "staff_phone3": null,
    "notify_status3": null,
    "notify_date3": null,

    "solution": "—",
    "close_name": "—",
    "close_date": null,
    "full_history": null,

    "note": [
      {
        "id": 144,
        "user": "Петров П.",
        "body": "Выехал",
        "date": 1761214500,
        "type": 0
      }
    ],

    "can_edit": true,
    "can_close": true,
    "can_comment": true,
    "closureallowed": 0
  }
}
```

**Важно:**

- `type` — `"open"` или `"close"` (не `call_status`).
- `note` — **массив**, не объект с числовыми ключами.
- `full_history` — **plain text**, не HTML.
- `closureallowed` — **число** (0 или 1), не булево.
- `staff_id`, `staff_id2`, `staff_id3` — числа или `null`, не строки.

**Особые случаи:**

- Заявка не найдена → `{ "status": "ok", "data": null }`
- Нет прав на просмотр → `{ "status": "ok", "data": null }`
- `ticketId` начинается с `offline_` → **фронт не отправляет запрос на сервер**, берёт из `offlineDB`.

### 12.3. `get_report` (Этап 2)

Формирование отчёта с динамическими колонками. Сервер возвращает массив `columns` — единственный источник правды о том, какие поля показывать.

**Ключевые принципы:**

- `columns` определяет порядок, видимость и форматирование.
- `type`: `"timestamp"` → `formatTs()`, `"number"` → выравнивание вправо, `"string"` → как есть.
- `is_truncated: true` — сервер вернул только первые 500 записей.

**Подробная спецификация:** отдельный документ на 2-м этапе.

---

## 13. История API

- **v5.2** — учтены ответы на вопросы Q1–Q10: `force_create` только на уровне команды, три автокоррекции (`opened_at` в будущем, `closed_at < opened_at`, `solution` без `closed_at`), `vis = 0` не блокирует создание, полная структура `ticket`, `get_tenant_info` с ошибкой `tenant_not_found`, кэширование на фронте, UI-ограничение на переоткрытие офлайн-закрытой заявки.
- **v5.1** — убран `ticket_deleted`, автокоррекция `closed_at < opened_at`, формат `comments` единой строкой, раздел связанных эндпоинтов.
- **v5.0** — production-ready с вариантом А (всё офлайн-редактирование сворачивается в `CreateTicket`).
- **v4.2** — базовая версия (Partial Success, Soft Merge, Intra-batch mapping).

---

## 📋 Чек-лист для реализации

### Бэкенд

- [ ] Расширить `SyncCommandsService::handleCreateTicket`:
  - [ ] Принимать `opened_at` (обязательно) с автокоррекцией `> now + 1d`
  - [ ] Принимать `comments` → сохранять как одну заметку в `lift_notes` с `is_offline = 1`
  - [ ] Принимать `solution`, `closed_at`, `closed_by_name`, `closed_by_id` → устанавливать `call_status = 1`, `call_solution`, `call_close_date`, `call_close_name`
  - [ ] Автокоррекция `solution` без `closed_at` → `closed_at = now`
  - [ ] Автокоррекция `closed_at < opened_at` → `closed_at = opened_at`
  - [ ] Записывать в `lift_history` с `source = 'offline_sync'`
- [ ] `object.vis = 0` **не блокирует** `CreateTicket` (см. §7.6): заявка создаётся, в `lift_history` пометка «объект выведен из обслуживания»
- [ ] `force_create` обрабатывать **только на уровне команды**, не искать в payload
- [ ] Удалить `contract_terminated` из проверок при создании (оставить только для глобального `tenant_suspended`)
- [ ] Удалить `ticket_deleted` из кодов ошибок
- [ ] Удалить `AcceptTicket` из production-роутинга (оставить в коде как `reserved_for_mobile`)
- [ ] Удалить обработку `photo_base64` из `handleAddComment`
- [ ] Создать таблицы `offline_actions_archive`, `offline_command_log`, `offline_sync_log`
- [ ] TTL: `offline_command_log` — 7 дней, `offline_sync_log` — 30 дней, `offline_actions_archive` — 30 дней (cron)
- [ ] Добавить поле `source` в `lift_history`
- [ ] Добавить индекс `idx_calls_active_object` для проверки дублей
- [ ] Rate-limiting: 60 req/min на пользователя, 10 пачек/min
- [ ] Nginx: `client_max_body_size 10M` для `/calls/syncCommands`
- [ ] Публичный `get_tenant_info` без авторизации, по `Host`, возвращать `status: "error", code: "tenant_not_found"` при неизвестном домене
- [ ] Доработать экшен `ticket`: возврат `data: null` при отсутствии заявки или нехватке прав
- [ ] Проверить структуру ответа `ticket` (§12.2)

### Фронтенд

- [x] `SyncManager` — частичный успех (уже реализовано)
- [x] `SyncManager` — идемпотентность `batch_id` (уже реализовано)
- [x] `SyncManager` — маппинг `created_tickets` (уже реализовано)
- [x] `batch-builder` — сборка по весу 3.5 МБ и лимиту 20 команд (уже реализовано)
- [x] `withSyncLock` / `withIdbWriteLock` (уже реализовано)
- [x] `visibilitychange` (уже реализовано в `SyncManager`)
- [x] `_applyCreatedTickets` (уже реализовано)
- [ ] `batch-builder.buildCommand`: для `CreateTicket` копировать `offline_author_id` и `offline_author_name` в `payload` (сейчас уходят только на уровне outbox-записи, а сервер ждёт их в `payload`)
- [ ] `outbox-queue.enqueueCreate`: добавить `opened_at: nowTs()` в `payload`
- [ ] `outbox-queue.enqueueEdit`: если `ticketId` начинается с `offline_` → найти `CreateTicket` по `offline_uuid` и слить `patch` в его `payload`, не создавать `EditTicket`
- [ ] `outbox-queue.enqueueComment`: если `ticketId` начинается с `offline_` → найти `CreateTicket` и дописать строку `[Автор, дата]: текст` в `payload.comments` (инициализировать заголовком `⏳ [Офлайн-комментарии]` при первом)
- [ ] `outbox-queue.enqueueClose`: если `ticketId` начинается с `offline_` → найти `CreateTicket` и добавить `solution`, `closed_at`, `closed_by_name`, `closed_by_id`
- [ ] `ticket-repository.fetchById`: если `ticketId` начинается с `offline_` → читать из `offlineDB`, не отправлять запрос на сервер
- [ ] `details-controller.mount`: удалить блок `if (String(ticketId).startsWith("offline_"))` (переносится в `ticket-repository`)
- [ ] `pending-overlay.js`: учитывать `payload.comments`, `payload.solution`, `payload.closed_at`, `payload.closed_by_name` для офлайн-заявок
- [ ] `details-controller`: скрывать кнопки «Редактировать» / «Открыть заново» для офлайн-закрытых заявок (§7.7)
- [ ] `get_tenant_info`: кэширование в `localStorage` (TTL 5 минут), показ из кэша при старте

### Тестирование

- [ ] Unit-тесты `SyncCommandsService`:
  - [ ] `CreateTicket` с `comments`
  - [ ] `CreateTicket` с `solution` + `closed_at`
  - [ ] `CreateTicket` с дублем (`force_create`)
  - [ ] `CreateTicket` с `closed_at < opened_at` (автокоррекция)
  - [ ] `CreateTicket` с `opened_at > now + 1d` (автокоррекция)
  - [ ] `CreateTicket` с `solution` без `closed_at` (автокоррекция)
  - [ ] `CreateTicket` с `object.vis = 0` (создаётся + пометка в истории)
  - [ ] `EditTicket` Soft Merge
  - [ ] `CloseTicket`
  - [ ] `AddComment`
- [ ] Тесты идемпотентности (`batch_id`, `command_uuid`, `offline_uuid`)
- [ ] Тесты `archived` / `ignored` / `failed`
- [ ] E2E: обрыв связи, двойное закрытие, конфликт прав
- [ ] Тест `get_tenant_info`: известный домен, неизвестный домен (`tenant_not_found`)
- [ ] Тест `ticket`: существующая заявка, несуществующая, нет прав, офлайн (без запроса на сервер)

---

**Конец `API_syncCommands.md` (v5.2).**

```

---

## Что изменилось (сводка)

**Документ:**
1. `force_create` — только на уровне команды.
2. Три автокоррекции в `CreateTicket` (`opened_at` future, `closed_at < opened_at`, `solution` без `closed_at`).
3. `object.vis = 0` не блокирует создание (§7.6).
4. `contract_terminated` только для глобального расторжения тенанта.
5. Офлайн-закрытая заявка не переоткрывается (§7.7).
6. `get_tenant_info` → `tenant_not_found` при неизвестном домене + кэш на фронте.
7. Полная структура `ticket` (§12.2) из твоего файла Q10.
8. TTL таблиц идемпотентности (Q7).
9. `closed_by_*` и `offline_author_*` — независимые поля (Q6).

```
