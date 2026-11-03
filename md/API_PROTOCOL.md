# Обновлённый `API_PROTOCOL.md` (v4.1)

**Версия:** 4.1  
**Статус:** Актуально (согласовано)  
**Дата:** 01.11.2026  
**Изменения от v4.0:** добавлены actions для отчётов (`/reports/calls/*`), обновлён `get_org_users` (фильтр по `user_position`), добавлены параметры `include_hidden` / `is_hidden` / `suspended_at` для `loadAddress`, обновлён `callNewOffline` (только открытые заявки), добавлены коды ошибок `token_revoked`, `contract_terminated`, `call_already_closed`.

**Связанные документы:** AUTH_PROTOCOL.md, OFFLINE_PROTOCOL.md, TECHNICAL_DEBT.md, MASTER_PLAN.md, bisness.md

---

## 📑 Содержание

- [Глобальные параметры сетевого шлюза](#-глобальные-параметры-сетевого-шлюза)
- [Форматы данных](#-форматы-данных)
- [Перечень доступных Экшенов (Actions)](#-перечень-доступных-экшенов-actions)
- [Обработка ошибок](#-обработка-ошибок-сетевого-шлюза-error-handling)
- [Сводная таблица полей заявки](#-сводная-таблица-полей-заявки)
- [Профиль и настройки](#11-профиль-и-настройки-интерфейса)
- [Интеграция с ключом организации](#12-интеграция-с-ключом-организации)
- **13. Отчёты и поиск (новое)**
- **14. Мультитенантность (новое)**

---

## 🌐 Глобальные параметры сетевого шлюза

Соглашение о ключе запроса:

- Чтение данных (`config`, `open`, `close`, `loadAddress`, `notifications`, `get_user_settings`, `check_org_key`, `get_org_users`) — отправляются с ключом `"data"`.
- Команды и отправка данных (`callnew`, `calledit`, `callClose`, `callnote`, `callNewOffline`, `save_user_settings`) — отправляются с ключом `"action"`.

| Параметр | Значение |
|---|---|
| Рабочий шлюз (legacy) | `https://sh.e-rcs.ru` |
| Шлюз liftcs | `https://l3.liftcs.ru` (урезанный, Трек А) |
| Новый API (Трек Б) | `https://api.liftcs.ru` |
| Метод запроса | POST |
| Content-Type | `application/json; charset=utf-8` |
| Accept | `application/json` |
| Архитектурный стиль | RPC-over-POST |
| Таймаут фронтенда | 15 секунд (AbortController) |
| CORS | Разрешены предварительные OPTIONS-запросы, сервер возвращает 200 OK с заголовками разрешения |

**Мультитенантность:** новый API определяет тенант по заголовку `X-Tenant: <subdomain>`, JWT (`tenant_id`) или `org_key` в теле. Подробнее — раздел 14.

---

## 📅 Форматы данных

⚠️ **Важно:** Начиная с версии 4.0, все даты и время передаются как Unix timestamp (целое число секунд).

| Тип поля | Формат | Пример |
|---|---|---|
| Дата + время | Unix timestamp (секунды) | 1761214500 (23.10.2026@12:15) |
| Числовые ID | Integer | 35732 |
| `alert_level` | Integer 1–3 | 3 |
| Флаг заметок | String `"Есть заметки (N)"` | `"Есть заметки (3)"` |

### 🔔 Каналы уведомления (`notify_status`)

| Код | Канал | Суффикс |
|---|---|---|
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
  "menu_structure": [
    {
      "id": "create",
      "title": "Добавить заявку",
      "type": "icon-button",
      "icon_svg": "<svg ...>",
      "target_hash": "#/create",
      "required_permission": "can_add_ticket"
    },
    {
      "id": "open_tickets",
      "title": "Открытые заявки",
      "type": "nav-link",
      "target_hash": "#/",
      "is_default": true
    },
    {
      "id": "closed_tickets",
      "title": "Закрытые заявки",
      "type": "nav-link",
      "target_hash": "#/closed"
    },
    {
      "id": "reports",
      "title": "Отчёты",
      "type": "nav-link",
      "target_hash": "#/reports",
      "required_permission": "can_view_reports"
    }
  ],
  "staff_list": [
    { "id": 1, "name": "Иванов Иван", "phone": "+7 (900) 111-11-11" },
    { "id": 2, "name": "Степанов Степан", "phone": "+7 (900) 222-22-22" },
    { "id": 3, "name": "Сергеенко Сергей", "phone": null }
  ],
  "department": { "22": "1.Электромеханики", "23": "2.Аварийная служба" },
  "request": { "1": "1.Срочная", "2": "2.Обычная", "3": "3.Не срочная" },
  "group": {
    "4": "1.Застревание",
    "5": "2.Мелкая неисправность",
    "6": "3.Неисправность лифта",
    "7": "4.Дополнительные работы",
    "8": "5.Длительный ремонт",
    "24": "6.Неисправность дисп. об.",
    "9": "7.Прочее"
  },
  "elevator_groups": [
    { "id": 1, "name": "ЖК Солнечный" },
    { "id": 2, "name": "Дом Ленина 10" }
  ]
}
```

**Новое поле `user_permissions.user_position`** — должностной тип (для UI, фильтрации).

**Новое поле `user_permissions.can_manage_dispatchers`** — если `true`, пользователь может управлять диспетчерами (старший диспетчер).

**Новое поле `elevator_groups`** — список доступных пользователю групп лифтов (для фильтра и формы создания).

**Роли:**

| Роль | Описание |
|---|---|
| `administrator` | Полные права |
| `dispatcher` | Создаёт и редактирует заявки в своих группах |
| `engineer` | Механик. Видит закреплённые лифты и свои заявки |
| `guest` | Только чтение |
| `reserved` | Резерв |

---

### 2. Получение списка открытых заявок (`open`)

**Request:**
```json
{ "data": "open" }
```

**Response:** массив объектов (структура — см. сводную таблицу в конце).

**Новые поля в каждой заявке:**

- `elevator_group_id` — ID группы лифтов.
- `elevator_group_name` — название группы.
- `is_emergency` — заявка Аварийной службы (boolean).
- `can_close` — может ли текущий пользователь закрыть заявку (boolean, рассчитывается сервером).
- `can_edit` — может ли редактировать.
- `can_comment` — может ли комментировать.

---

### 3. Получение списка закрытых заявок (`close`)

**Request:**
```json
{ "data": "close", "period": "1" }
```

**Параметр `period`:** 1 / 2 / 3 / 7 (дней). Максимум 7 дней.

**Response:** структура идентична `open`, но `solution`, `close_name`, `close_date` заполнены.

---

### 4. Получение справочника адресов (`loadAddress`)

**Request:**
```json
{ "data": "loadAddress", "include_hidden": false }
```

**Новый параметр `include_hidden`** — если `true`, возвращаются скрытые лифты (`vis=0`) с полями `is_hidden`, `hidden_reason`, `suspended_at`.

**Response:**
```json
{
  "status": "ok",
  "action": "loadAddress",
  "message": {
    "city": [{ "id": 1, "city_name": "г. Ростов-на-Дону" }],
    "street": [{ "id": 2, "street_name": "ул. Ленина", "city_id": 1 }],
    "home": [{ "id": 5, "home_name": "5", "street_id": 2 }],
    "object": [
      {
        "id": 209,
        "object_name": "п.1 пасс.",
        "home_id": 5,
        "vis": 1,
        "is_hidden": false,
        "hidden_reason": null,
        "suspended_at": null,
        "group_id": 1,
        "contractor_id": 1,
        "object_kind": "real"
      },
      {
        "id": 210,
        "object_name": "п.2 груз.",
        "home_id": 5,
        "vis": 0,
        "is_hidden": true,
        "hidden_reason": "Договор расторгнут 01.09.2026",
        "suspended_at": 1756684800,
        "group_id": 1,
        "contractor_id": 1,
        "object_kind": "real"
      }
    ]
  }
}
```

---

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

**Проверка при создании:**

- Если `lift_object.vis = 0` и пользователь **не** Админ и **не** Прораб с `can_manage_contract_status` → ошибка `contract_terminated`.
- Проверка прав `CallPolicy::canCreate($user, $groupId)`.

**Response:**
```json
{ "status": "ok", "message": "Заявка успешно зарегистрирована.", "generated_id": 35733 }
```

---

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

**Response:**
```json
{ "status": "ok", "message": "Изменения по заявке №35732 успешно сохранены." }
```

**Новые коды ошибок:**

- `call_already_closed` — заявка уже закрыта.
- `forbidden` — нет прав.

---

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

**Response:**
```json
{ "status": "ok", "message": "Заявка №35732 успешно закрыта." }
```

**Новый код ошибки:** `call_already_closed` (409) — если заявка уже закрыта, с именем закрывшего и датой.

---

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

`photo_base64` — опционально. Лимит: **2 фото на всю заявку**.

**Response:**
```json
{ "status": "ok", "message": "Комментарий успешно добавлен к заявке №35732.", "note_id": 143 }
```

---

### 9. Синхронизация офлайн-пачки (`callNewOffline`)

**Request:**
```json
{
  "action": "callNewOffline",
  "batch_id": "uuid-...",
  "tickets": [
    {
      "offline_uuid": "offline_1714567890123_x7k2p",
      "offline_author_id": 3,
      "offline_author_name": "Сергеенко Сергей",
      "city_id": "1",
      "street_id": "2",
      "home_id": "3",
      "object_id": "11",
      "fullAddress": "...",
      "group_id": "8",
      "request_id": "2",
      "department_id": "22",
      "repair_time": 1761220800,
      "details": "...",
      "staff_id": 3
    }
  ]
}
```

**Особенности:**

- Максимум 10 заявок в пачке.
- Атомарность: либо вся пачка, либо ничего.
- Идемпотентность: `offline_uuid` UNIQUE.
- Если адрес не валидируется — сохраняется с `address_not_verified = 1`.

**Response:**
```json
{
  "status": "ok",
  "message": "Пачка из 10 заявок успешно синхронизирована.",
  "created": [35740, 35741, ...],
  "skipped": []
}
```

---

### 10. Получение событий-уведомлений (`notifications`)

**Request:**
```json
{
  "data": "notifications",
  "since_id": 142857,
  "versions": { "staff": 0, "dicts": 0 }
}
```

**Response:** массив событий (см. v4.0), + `last_id`, `versions`, `outdated`.

---

### 11. Профиль и настройки (`get_user_settings` / `save_user_settings`)

Без изменений от v4.0. См. полную структуру в исходном документе.

---

### 12. Интеграция с ключом организации (`check_org_key` / `get_org_users`)

#### 12.1. `check_org_key`

**Request:**
```json
{ "data": "check_org_key", "org_key": "XXXX-XXXX-XXXX" }
```

**Response:**
```json
{ "status": "ok", "message": "Ключ действителен" }
```

#### 12.2. `get_org_users`

**Request:**
```json
{ "data": "get_org_users", "org_key": "XXXX-XXXX-XXXX" }
```

**Response:**
```json
{
  "status": "ok",
  "users": [
    { "user_id": 3, "name": "Иванов Иван" },
    { "user_id": 4, "name": "Петров Петр" }
  ]
}
```

**⚠️ Критично:** сервер возвращает **только пользователей с `user_position = 'dispatcher'`** (старшие диспетчеры тоже попадают, так как у них `user_position = 'dispatcher'`).

Прораб, админ, механик, связист, инженер-электронщик, гость — **не попадают**.

---

### 13. Отчёты и поиск (новое в v4.1)

#### 13.1. Поиск заявок (`GET /reports/calls/search`)

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

**Response:**
```json
{
  "status": "ok",
  "data": {
    "calls": [
      {
        "id": 35732,
        "call_number": "35732",
        "type": "open",
        "fullAddress": "...",
        "object_id": 11,
        "home_id": 3,
        "details": "...",
        "staff_id": 3,
        "staff_name": "Сергеенко Сергей",
        "department": "1.Электромеханики",
        "group": "1-я группа",
        "request": "Застревание",
        "date": 1761214200,
        "repair_time": 1761220800,
        "solution": "—",
        "close_name": "—",
        "close_date": null,
        "alert_level": 3,
        "is_emergency": false
      }
    ],
    "total": 1,
    "page": 1,
    "per_page": 50,
    "pages": 1
  }
}
```

**Правила фильтрации:**

- `call_number` — частичное совпадение (`LIKE %...%`).
- `exclude_emergency = true` — исключить заявки с `is_emergency = true`.
- Механик видит только свои заявки (где `call_staff = user_id`).
- Диспетчер видит заявки своих групп.
- Админ — все.

**Ограничения:**

- Максимум 10 000 строк за запрос.
- `per_page` — от 1 до 500.

#### 13.2. Экспорт в PDF (`GET /reports/calls/export/pdf`)

**Request:** те же параметры, что и `search`, без `page` / `per_page` (либо с ними — экспортируется одна страница).

**Response:** `application/pdf` (бинарь) или `{ "status": "ok", "url": "..." }`, если экспорт асинхронный.

**Rate-limit:** 10 запросов в час на пользователя.

**Аудит:** `audit_log: report.export` с параметрами фильтров.

#### 13.3. Экспорт в Excel (`GET /reports/calls/export/excel`)

Аналогично PDF. `Content-Type: application/vnd.openxmlformats-officedocument.spreadsheetml.sheet`.

---

### 14. Мультитенантность (новое в v4.1)

#### 14.1. Определение тенанта

**Заголовок `X-Tenant`** (рекомендуется для legacy-совместимости):
```
X-Tenant: l3
```

**Или `org_key` в теле** (только для `login`, `check_org_key`, `get_org_users`):
```json
{ "data": "check_org_key", "org_key": "XXXX-XXXX-XXXX" }
```

**Или JWT `tenant_id`** (после логина, основной способ для нового API):
```json
// payload JWT
{ "user_id": 3, "tenant_id": 1, "role": "dispatcher", "position": "dispatcher" }
```

#### 14.2. Приоритет

1. JWT `tenant_id` (если токен есть).
2. `X-Tenant` (если токена нет — для `login`).
3. `org_key` (только для `check_org_key`, `get_org_users`, `login`).

Если ни один не определён → **401 `tenant_not_resolved`**.

#### 14.3. Login в мультитенантном сценарии

**Request:**
```json
{
  "login": "ivanov",
  "password": "...",
  "org_key": "l3",
  "device_fingerprint": "..."
}
```

**Response:**
```json
{
  "ok": true,
  "data": {
    "access_token": "eyJ...",
    "refresh_token": "abc...",
    "user": {
      "user_id": 3,
      "name": "Иванов И.И.",
      "role": "dispatcher",
      "position": "dispatcher",
      "tenant_id": 1
    }
  }
}
```

#### 14.4. Коды ошибок мультитенантности

| Код | HTTP | Когда |
|---|---|---|
| `tenant_not_resolved` | 401 | Тенант не определён по JWT / X-Tenant / org_key |
| `tenant_suspended` | 403 | Тенант в статусе `suspended` |
| `tenant_not_found` | 404 | Тенант не найден в master-реестре |

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

**Новые коды ошибок (v4.1):**

| Код | HTTP (факт. тело) | Когда |
|---|---|---|
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

**Поведение фронтенда при ошибках:**

| Ситуация | Поведение UI |
|---|---|
| Ошибка валидации / логическая | LED-индикатор красный, в блоке «История» текст `message` |
| `token_revoked` | Модалка «Права изменены», logout через 10 сек |
| `contract_terminated` | Плашка «Договор расторгнут», кнопка «Создать» скрыта |
| Таймаут (>15 сек) | LED-индикатор красный, сообщение «Превышено время ожидания» |
| Сбой сети | LED-индикатор красный, сообщение «Сбой сети» |

---

## 📎 Сводная таблица полей заявки (v4.1)

| Поле | Тип | open | close | Описание |
|---|---|---|---|---|
| `id` | integer | ✓ | ✓ | Уникальный ID заявки |
| `call_number` | string | ✓ | ✓ | Номер заявки (для поиска) |
| `type` | string | "open" | "close" | Режим отображения |
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
| `solution` | string | "—" | ✓ | Описание выполненных работ |
| `close_name` | string | "—" | ✓ | ФИО закрывшего |
| `close_date` | integer \| null | null | ✓ | Unix timestamp закрытия |
| `full_history` | string \| null | null | ✓ | Полная история |
| `alert_level` | integer | ✓ | ✓ | Уровень тревоги (1, 2, 3) |
| `is_emergency` | boolean | ✓ | ✓ | Заявка Аварийной службы |
| `other` | string | ✓ | ✓ | «Есть заметки (N)» или «—» |
| `note_num` | integer | ✓ | ✓ | Количество заметок |
| `note` | object | ✓ | ✓ | Комментарии |
| `closureallowed` | integer | ✓ | null | 1, если механик может закрыть |
| **`can_close`** | **boolean** | **✓** | **✓** | **Может ли текущий пользователь закрыть** |
| **`can_edit`** | **boolean** | **✓** | **✓** | **Может ли редактировать** |
| **`can_comment`** | **boolean** | **✓** | **✓** | **Может ли комментировать** |

---

**Конец `API_PROTOCOL.md` (v4.1).**

---
