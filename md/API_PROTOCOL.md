# Сообщение 1 из 3: `API_PROTOCOL.md` v4.2

```markdown
# 📋 API_PROTOCOL.md — v4.2

**Версия:** 4.2  
**Статус:** Актуально (согласовано)  
**Дата:** 03.11.2026  

**Изменения от v4.1:**
- ❌ Удалён `callNewOffline` (не был в продакшене, заменён на `syncCommands`)
- ✅ Добавлен `syncCommands` (универсальная офлайн-синхронизация, 5 типов команд)
- ✅ Обновлена сводная таблица полей заявки (`call_id` + `call_number`)
- ✅ Добавлен раздел «Синхронизация офлайн-команд»

**Связанные документы:** `AUTH_PROTOCOL.md`, `OFFLINE_PROTOCOL.md` v3.0, `API_syncCommands.md`, `TECHNICAL_DEBT.md`

---

## 📑 Содержание

1. [Глобальные параметры сетевого шлюза](#-глобальные-параметры-сетевого-шлюза)
2. [Форматы данных](#-форматы-данных)
3. [Перечень доступных Экшенов (Actions)](#-перечень-доступных-экшенов-actions)
4. [Синхронизация офлайн-команд (`syncCommands`)](#4-синхронизация-офлайн-команд-synccommands)
5. [Обработка ошибок](#-обработка-ошибок-сетевого-шлюза-error-handling)
6. [Сводная таблица полей заявки](#-сводная-таблица-полей-заявки)
7. [Профиль и настройки](#7-профиль-и-настройки)
8. [Интеграция с ключом организации](#8-интеграция-с-ключом-организации)
9. [Отчёты и поиск](#9-отчёты-и-поиск)
10. [Мультитенантность](#10-мультитенантность)

---

## 🌐 Глобальные параметры сетевого шлюза

### Соглашение о ключе запроса

| Ключ | Назначение | Примеры |
|------|-----------|---------|
| `"data"` | Чтение данных | `config`, `open`, `close`, `loadAddress`, `notifications`, `get_user_settings`, `check_org_key`, `get_org_users` |
| `"action"` | Команды и отправка данных | `callnew`, `calledit`, `callClose`, `callnote`, **`syncCommands`**, `save_user_settings` |

### Параметры соединения

| Параметр | Значение |
|----------|----------|
| Рабочий шлюз (legacy) | `https://sh.e-rcs.ru` |
| Шлюз liftcs | `https://l3.liftcs.ru` (урезанный, Трек А) |
| Новый API (Трек Б) | `https://api.liftcs.ru` |
| Метод запроса | `POST` |
| Content-Type | `application/json; charset=utf-8` |
| Accept | `application/json` |
| Архитектурный стиль | RPC-over-POST |
| Таймаут фронтенда | 15 секунд (AbortController) |
| CORS | Разрешены предварительные OPTIONS-запросы, сервер возвращает 200 OK |

**Мультитенантность:** новый API определяет тенант по заголовку `X-Tenant: <subdomain>`, JWT (`tenant_id`) или `org_key` в теле. Подробнее — раздел 10.

---

## 📅 Форматы данных

⚠️ **Важно:** Начиная с версии 4.0, все даты и время передаются как Unix timestamp (целое число секунд).

| Тип поля | Формат | Пример |
|----------|--------|--------|
| Дата + время | Unix timestamp (секунды) | `1761214500` (23.10.2026@12:15) |
| Числовые ID | Integer | `35732` |
| alert_level | Integer 1–3 | `3` |
| Флаг заметок | String `"Есть заметки (N)"` | `"Есть заметки (3)"` |

### 🔔 Каналы уведомления (`notify_status`)

| Код | Канал | Суффикс |
|-----|-------|---------|
| 0 | — (не уведомлён) | «Не уведомлен» |
| 1 | 📞 Телефон | « - по телефону» |
| 2 | 🖥 WEB | « - онлайн» |
| 3 | ✈️ Telegram | « - в телеграм» |
| 4 | 💬 Max | « - в макс» |
| 5 | 🔵 VK | « - в вк» |
| 6 | 📱 SMS | « - по смс» |
| 7 | ✉️ Email | « - по email» |

---

## 🛠️ Перечень доступных Экшенов (Actions)

### 1. Получение конфигурации и прав (`config`)

Вызывается при инициализации приложения.

**Request:**
```json
{ "data": "config" }
```

**Response:**
```json
{
  "user_permissions": {
    "role": "engineer",
    "user_id": 3,
    "user_position": "mechanic",
    "can_add_ticket": false,
    "can_view_reports": true,
    "can_view_settings": false,
    "can_manage_dispatchers": false
  },
  "menu_structure": [ ... ],
  "staff_list": [ ... ],
  "department": { "22": "1.Электромеханики", "23": "2.Аварийная служба" },
  "request": { "1": "1.Срочная", "2": "2.Обычная", "3": "3.Не срочная" },
  "group": { "4": "1.Застревание", ... },
  "elevator_groups": [ { "id": 1, "name": "ЖК Солнечный" }, ... ]
}
```

**Роли:**

| Роль | Описание |
|------|----------|
| `administrator` | Полные права |
| `dispatcher` | Создаёт и редактирует заявки в своих группах |
| `engineer` | Механик. Видит закреплённые лифты и свои заявки |
| `guest` | Только чтение |
| `reserved` | Резерв |

### 2. Получение списка открытых заявок (`open`)

**Request:**
```json
{ "data": "open" }
```

**Response:** массив объектов (структура — см. сводную таблицу в разделе 6).

### 3. Получение списка закрытых заявок (`close`)

**Request:**
```json
{ "data": "close", "period": "1" }
```

**Параметр `period`:** 1 / 2 / 3 / 7 (дней). Максимум 7 дней.

### 4. Получение справочника адресов (`loadAddress`)

**Request:**
```json
{ "data": "loadAddress", "include_hidden": false }
```

**Параметр `include_hidden`:** если `true`, возвращаются скрытые лифты (`vis=0`) с полями `is_hidden`, `hidden_reason`, `suspended_at`.

### 5. Регистрация новой заявки (`callnew`)

**Request:**
```json
{
  "action": "callnew",
  "city_id": "1",
  "street_id": "2",
  "home_id": "3",
  "object_id": "11",
  "fullAddress": "г. Ростов-на-Дону - Красноармейская ул. дом № 2 корп.2 - п. 1 прав.",
  "group_id": "8",
  "request_id": "2",
  "department_id": "22",
  "repair_time": 1761220800,
  "details": "Описание проблемы оператором диспетчерской службы",
  "staff_id": 3
}
```

**Проверки при создании:**
- Если `lift_object.vis = 0` и пользователь не Админ/Прораб с `can_manage_contract_status` → ошибка `contract_terminated`.
- Проверка прав `CallPolicy::canCreate($user, $groupId)`.

**Response:**
```json
{ "status": "ok", "message": "Заявка успешно зарегистрирована.", "generated_id": 35733 }
```

### 6. Частичное редактирование заявки (`calledit`)

**Request:**
```json
{
  "action": "calledit",
  "call_id": 35732,
  "staff_id": 3,
  "notify_status": 1,
  "staff_id2": 1,
  "notify_status2": 2,
  "group_id": "9",
  "repair_time": 1761230000
}
```

**Ограничения:**
- Адрес менять нельзя.
- Закрытие через `calledit` запрещено.
- За один запрос — одно назначение или снятие ответственного.

**Новые коды ошибок:**
- `call_already_closed` — заявка уже закрыта.
- `forbidden` — нет прав.

### 7. Закрытие заявки (`callClose`)

**Request:**
```json
{
  "action": "callClose",
  "call_id": 35732,
  "solution": "Произведена очистка контактов реле и замена предохранителя.",
  "user_id": 3
}
```

**Новый код ошибки:** `call_already_closed` (409) — если заявка уже закрыта, с именем закрывшего и датой.

### 8. Добавление комментария (`callnote`)

**Request:**
```json
{
  "action": "callnote",
  "call_id": 35732,
  "note": "Текст комментария, примечания или отчета мастера",
  "photo_base64": "data:image/jpeg;base64,..."
}
```

`photo_base64` — опционально. **Лимит: 2 фото на всю заявку.**

### 9. Получение событий-уведомлений (`notifications`)

**Request:**
```json
{
  "data": "notifications",
  "since_id": 142857,
  "versions": { "staff": 0, "dicts": 0 }
}
```

---

## 4. Синхронизация офлайн-команд (`syncCommands`)

⚠️ **Универсальный эндпоинт для пакетной синхронизации офлайн-действий.**

Поддерживает **5 типов команд**:
- `CreateTicket` — создание заявки (только диспетчер/админ)
- `EditTicket` — редактирование заявки (только диспетчер/админ, Soft Merge)
- `CloseTicket` — закрытие заявки (диспетчер + механик)
- `AddComment` — добавление комментария (диспетчер + механик)
- `AcceptTicket` — принятие в работу (диспетчер + механик)

**Полная спецификация:** см. отдельный документ **`API_syncCommands.md`**.

**Краткая сводка:**

| Параметр | Значение |
|----------|----------|
| Endpoint | `POST /calls/syncCommands` |
| Максимум команд в пачке | 20 |
| Максимальный вес пачки | 3.5 МБ (JSON) |
| Максимальный размер запроса | 10 MB (Nginx `client_max_body_size`) |
| Атомарность | Частичный успех (Partial Success) |
| Идемпотентность | `batch_id` + `command_uuid` |
| Таймаут клиента | 30 секунд |

---

## 🚫 Обработка ошибок сетевого шлюза (Error Handling)

⚠️ Все ответы сервера приходят с HTTP-статусом **200 OK** (Nginx перехватывает 4xx/5xx). Ошибки определяются по полю `status: "error"` и `code`.

**Формат:**
```json
{
  "status": "error",
  "code": "error_code",
  "message": "Текст ошибки для пользователя."
}
```

### Коды ошибок (v4.2)

| Код | HTTP (факт. тело) | Когда |
|-----|:-----------------:|-------|
| `token_revoked` | 200 | Токен отозван (смена прав, блокировка) |
| `forbidden` | 200 | Нет прав (Policy) |
| `contract_terminated` | 200 | Попытка работы со скрытым лифтом (`vis=0`) |
| `call_already_closed` | 200 | Заявка уже закрыта |
| `tenant_not_resolved` | 200 | Тенант не определён |
| `tenant_suspended` | 200 | Тенант приостановлен |
| `rate_limited` | 200 | Превышен rate-limit |
| `invalid_input` | 200 | Ошибка валидации |
| `invalid_key` | 200 | Неверный org_key |
| `invalid_password` | 200 | Неверный старый пароль |

### Поведение фронтенда при ошибках

| Ситуация | Поведение UI |
|----------|--------------|
| Ошибка валидации / логическая | LED-индикатор красный, в блоке «История» текст `message` |
| `token_revoked` | Модалка «Права изменены», logout через 10 сек |
| `contract_terminated` | Плашка «Договор расторгнут», кнопка «Создать» скрыта |
| Таймаут (>15 сек) | LED-индикатор красный, сообщение «Превышено время ожидания» |
| Сбой сети | LED-индикатор красный, сообщение «Сбой сети» |

---

## 📎 Сводная таблица полей заявки (v4.2)

| Поле | Тип | `open` | `close` | Описание |
|------|-----|:------:|:-------:|----------|
| `call_id` | integer | ✓ | ✓ | Уникальный ID заявки (он же номер для поиска) |
| `call_number` | string | ✓ | ✓ | Строковое представление ID (для UI и полнотекстового поиска) |
| `type` | string | ✓ | ✓ | `"open"` / `"close"` — режим отображения |
| `fullAddress` | string | ✓ | ✓ | Полный собранный адрес |
| `city_id` | integer \| null | ✓ | ✓ | ID города |
| `street_id` | integer \| null | ✓ | ✓ | ID улицы |
| `home_id` | integer \| null | ✓ | ✓ | ID дома |
| `object_id` | integer \| null | ✓ | ✓ | ID лифта |
| `details` | string | ✓ | ✓ | Описание неисправности |
| `staff_id` | integer \| null | ✓ | ✓ | ID 1-го ответственного |
| `staff_name` | string \| null | ✓ | ✓ | ФИО 1-го ответственного |
| `staff_phone` | string \| null | ✓ | ✓ | Телефон 1-го ответственного |
| `notify_status` | integer \| null | ✓ | ✓ | Канал уведомления 1-го |
| `notify_date` | integer \| null | ✓ | ✓ | Unix timestamp уведомления 1-го |
| `staff_id2` / `staff_id3` | integer \| null | ✓ | ✓ | 2-й / 3-й ответственный |
| `staff_name2` / `staff_name3` | string \| null | ✓ | ✓ | ФИО 2-го / 3-го |
| `staff_phone2` / `staff_phone3` | string \| null | ✓ | ✓ | Телефон 2-го / 3-го |
| `notify_status2` / `notify_status3` | integer \| null | ✓ | ✓ | Канал 2-го / 3-го |
| `notify_date2` / `notify_date3` | integer \| null | ✓ | ✓ | Дата уведомления 2-го / 3-го |
| `department` | string | ✓ | ✓ | Название отдела |
| `department_id` | string | ✓ | ✓ | ID отдела |
| `group` | string | ✓ | ✓ | Название группы лифтов |
| `group_id` | string | ✓ | ✓ | ID группы лифтов |
| `elevator_group_id` | integer \| null | ✓ | ✓ | ID новой группы лифтов |
| `elevator_group_name` | string \| null | ✓ | ✓ | Название новой группы |
| `request` | string | ✓ | ✓ | Тип неисправности |
| `request_id` | string | ✓ | ✓ | ID типа неисправности |
| `date` | integer | ✓ | ✓ | Unix timestamp регистрации |
| `repair_time` | integer | ✓ | ✓ | Unix timestamp планируемого устранения |
| `solution` | string | `"—"` | ✓ | Описание выполненных работ |
| `close_name` | string | `"—"` | ✓ | ФИО закрывшего |
| `close_date` | integer \| null | null | ✓ | Unix timestamp закрытия |
| `full_history` | string \| null | null | ✓ | Полная история |
| `alert_level` | integer | ✓ | ✓ | Уровень тревоги (1, 2, 3) |
| `is_emergency` | boolean | ✓ | ✓ | Заявка Аварийной службы |
| `other` | string | ✓ | ✓ | «Есть заметки (N)» или «—» |
| `note_num` | integer | ✓ | ✓ | Количество заметок |
| `note` | object | ✓ | ✓ | Комментарии |
| `closureallowed` | integer | ✓ | null | 1, если механик может закрыть |
| `can_close` | boolean | ✓ | ✓ | Может ли текущий пользователь закрыть |
| `can_edit` | boolean | ✓ | ✓ | Может ли редактировать |
| `can_comment` | boolean | ✓ | ✓ | Может ли комментировать |

---

## 7. Профиль и настройки

`get_user_settings` / `save_user_settings` — без изменений от v4.0.

---

## 8. Интеграция с ключом организации

### 8.1. `check_org_key`

**Request:**
```json
{ "data": "check_org_key", "org_key": "XXXX-XXXX-XXXX" }
```

### 8.2. `get_org_users`

**Request:**
```json
{ "data": "get_org_users", "org_key": "XXXX-XXXX-XXXX" }
```

⚠️ **Критично:** сервер возвращает только пользователей с `user_position = 'dispatcher'`.

---

## 9. Отчёты и поиск

### 9.1. Поиск заявок (`GET /reports/calls/search`)

**Request:**
```json
{
  "call_number": "357",
  "object_id": 11,
  "home_id": 3,
  "mechanic_id": 3,
  "date_from": 1761000000,
  "date_to": 1761300000,
  "status": "all",
  "exclude_emergency": true,
  "page": 1,
  "per_page": 50
}
```

**Правила фильтрации:**
- `call_number` — частичное совпадение (`LIKE %...%`)
- `exclude_emergency = true` — исключить заявки с `is_emergency = true`
- Механик видит только свои заявки (где `call_staff = user_id`)
- Диспетчер видит заявки своих групп
- Админ — все

**Ограничения:**
- Максимум 10 000 строк за запрос
- `per_page` — от 1 до 500

### 9.2. Экспорт в PDF (`GET /reports/calls/export/pdf`)

Rate-limit: 10 запросов в час на пользователя.  
Аудит: `audit_log: report.export` с параметрами фильтров.

### 9.3. Экспорт в Excel (`GET /reports/calls/export/excel`)

Аналогично PDF. `Content-Type: application/vnd.openxmlformats-officedocument.spreadsheetml.sheet`.

---

## 10. Мультитенантность

### 10.1. Определение тенанта

| Способ | Описание |
|--------|----------|
| `X-Tenant` (заголовок) | Рекомендуется для legacy-совместимости |
| JWT `tenant_id` | Основной способ после логина |
| `org_key` (в теле) | Только для `login`, `check_org_key`, `get_org_users` |

### 10.2. Приоритет

1. JWT `tenant_id` (если токен есть)
2. `X-Tenant` (если токена нет — для `login`)
3. `org_key` (только для `check_org_key`, `get_org_users`, `login`)

Если ни один не определён → 401 `tenant_not_resolved`.

### 10.3. Коды ошибок мультитенантности

| Код | HTTP | Когда |
|-----|:----:|-------|
| `tenant_not_resolved` | 401 | Тенант не определён |
| `tenant_suspended` | 403 | Тенант в статусе `suspended` |
| `tenant_not_found` | 404 | Тенант не найден в master-реестре |

---
