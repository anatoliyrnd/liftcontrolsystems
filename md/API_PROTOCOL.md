
# 📋 API_PROTOCOL.md — v4.3

**Версия:** 4.3
**Дата:** 12.11.2026
**Статус:** согласовано, приведено к фактической реализации
**Область:** новый API (`api.php`, `auth.php`). Легаси вне области — занимается прокси.
**Связанные документы:** `API_syncCommands.md` v5.3, `TECHNICAL_DEBT.md`

## Изменения от v4.2

| # | Изменение | Причина |
|---|---|---|
| 1 | Добавлен раздел «Соглашения о форме ответа» | `Response::ok` делает плоское слияние, обёртки `data` в большинстве экшенов нет |
| 2 | `config`: убраны `user_position`, `can_manage_dispatchers`, `elevator_groups` из фактических; добавлены `staff`, `repair_time` | не возвращаются / возвращаются, но не были описаны |
| 3 | `config`: добавлен `user_position` как обязательный к внедрению | нужен для правила «прораб фильтрует отчёты по ответственному» |
| 4 | `loadAddress`: убран `include_hidden` и поля скрытых лифтов | не реализовано |
| 5 | `callnew`: `generated_id` → `call_id`; `vis=0` не блокирует создание | фактическое поведение |
| 6 | Добавлено правило UTC для `repair_time` | Unix-метка абсолютна, серверных конвертаций нет |
| 7 | Ошибки: таблица приведена к 15 фактическим кодам; убрана обёртка `error`/`details`; добавлено поле `reason` | 9 документированных кодов не существуют |
| 8 | Сводная таблица: добавлен `id`; `note` — массив; уточнены отсутствующие поля | списки и карточка отдавали разные идентификаторы |
| 9 | Профиль: `column_settings` в разрезе scope | per-user настройки для трёх экранов |
| 10 | Отчёты: новый контракт на основе `reportsfront.md` + `columns` | три несовместимых контракта сведены к одному |
| 11 | Мультитенантность: только `Host` | `X-Tenant`, JWT `tenant_id`, `org_key` в резолве не участвуют |
| 12 | Добавлен раздел «Аутентификация» | ранее вынесен в отдельный документ, не соответствовал коду |
| 13 | Легаси (`is_legacy`, `nav`) вынесен в приложение | вне области нового API |

---

## 0. Соглашения

### 0.1. Ключ запроса

| Ключ | Назначение | Примеры |
|---|---|---|
| `data` | чтение | `config`, `open`, `close`, `ticket`, `loadAddress`, `notifications`, `get_user_settings`, `check_org_key`, `get_org_users` |
| `action` | команды | `callnew`, `calledit`, `callClose`, `callnote`, `syncCommands`, `save_user_settings`, `reports_*` |

Оба ключа равнозначны для маршрутизации: `Request` берёт `action ?? data`.

### 0.2. Соединение

| Параметр | Значение |
|---|---|
| Метод | `POST` |
| Content-Type | `application/json; charset=utf-8` |
| Accept | `application/json` |
| HTTP-статус | **всегда 200**, ошибки в теле |
| Таймаут клиента | 15 с (`AbortController`); для `syncCommands` — 30 с |
| Авторизация | `Authorization: Bearer <access_token>` |
| Cookie | `lift_refresh` — HttpOnly, Secure, SameSite=Strict, path=/ |

### 0.3. Форма ответа ✅

`Response::ok($payload)` выполняет `['status' => 'ok'] + $payload` — **плоское слияние ключей**. Обёртка `data` появляется только там, где она передана явно.

| Тип | Форма | Пример |
|---|---|---|
| Списки | голый массив, без `status` | `[ {...}, {...} ]` |
| Одиночная сущность | `{status, data}` | `ticket`, `get_tenant_info` |
| Команды | `{status, ...поля}` | `{status:"ok", call_id:35733, message:"..."}` |
| Конфигурация | `{status, ...поля}` | `config`, `loadAddress`, `notifications` |
| Пачка команд | `{status, data:{...}}` | `syncCommands` ⚠️ сейчас плоско |
| Отчёты | `{status, data:{...}}` | `reports_*` 🆕 |
| Ошибка | `{status:"error", code, message, reason?}` | без обёртки `error` |

**Правило:** обёртка `data` — для одиночной сущности, результата пачки и отчётов. Остальное плоско.

### 0.4. Публичные экшены

Без авторизации: `get_tenant_info`. Все остальные требуют валидный Bearer.

---

## 1. Форматы данных

### 1.1. Даты и время

Все даты — **Unix timestamp, целое число секунд**.

| Тип поля | Формат | Пример |
|---|---|---|
| Дата + время | Unix timestamp (с) | `1761214500` |
| Числовые ID | Integer | `35732` |
| `alert_level` | Integer 1–3 | `3` |
| Флаг заметок | String | `"Есть заметки (3)"` или `"—"` |

### 1.2. Правило часового пояса

**Unix-метка абсолютна и не имеет часового пояса.** Локальность учитывается клиентом в момент построения метки:

1. Пользователь выбирает стенное время «17:00» в своей зоне.
2. Клиент строит `new Date(y, m-1, d, hh, mm)` — конструктор трактует значения как локальные.
3. `Math.floor(date.getTime() / 1000)` даёт абсолютную метку (для MSK это 14:00 UTC).
4. Сервер сохраняет метку **как есть, без сдвигов**.
5. Любой клиент, рендеря метку в локальной зоне, получает исходные стенные 17:00.

**Запрещено:** прибавлять/вычитать смещение зоны к метке на любой стороне.

**Серверное форматирование в строку** (`lift_history`, `full_history`, пометки автокоррекции) выполняется в единой бизнес-зоне, задаваемой явно в `bootstrap.php`. ⚠️ Сейчас используется PHP TZ по умолчанию, что даёт расхождение с UI.

**Сравнения** (`repair_time < time()`, `expires_at > NOW()`) выполняются в абсолютных величинах. Для DATETIME-колонок запись идёт через `FROM_UNIXTIME()`, чтобы конвертация и сравнение происходили в одной зоне MySQL. ⚠️ Сейчас запись через `date()` в PHP TZ.

### 1.3. Каналы уведомления (`notify_status`)

| Код | Канал | Суффикс в UI |
|---|---|---|
| 0 | не уведомлён | «Не уведомлен» |
| 1 | 📞 Телефон | « - по телефону» |
| 2 | 🖥 WEB | « - онлайн» |
| 3 | ✈️ Telegram | « - в телеграм» |
| 4 | 💬 Max | « - в макс» |
| 5 | 🔵 VK | « - в вк» |
| 6 | 📱 SMS | « - по смс» |
| 7 | ✉️ Email | « - по email» |

---

## 2. `config` — конфигурация и права

**Request:** `{ "data": "config" }`

**Response ✅ (фактический):**

```json
{
  "status": "ok",
  "user_permissions": {
    "role": "engineer",
    "user_id": 3,
    "can_add_ticket": false,
    "can_view_reports": false,
    "can_view_settings": false
  },
  "menu_structure": [],
  "staff_list": [
    { "id": 3, "name": "Сергеенко Сергей", "phone": "+7...", "role": "engineer", "position": "mechanic" }
  ],
  "department": { "22": "1.Электромеханики", "23": "2.Аварийная служба" },
  "request":    { "1": "1.Срочная", "2": "2.Обычная" },
  "group":      { "4": "1.Застревание", "8": "5.Длительный ремонт" },
  "staff":      { "31": "..." },
  "repair_time": ["не указан","30 мин","Сегодня","Завтра","Три дня","7 дней","10 дней","15 дней","1 месяц","3 месяца"]
}
```

### 2.1. `user_permissions`

| Поле | Тип | Правило | Статус |
|---|---|---|---|
| `role` | string | из `AuthService::formatUser`, см. §19.5 | ⚠️ требует нормализации |
| `user_id` | int | ID текущего пользователя | ✅ |
| `user_position` | string \| null | `lift_users.user_position` | 🆕 обязательно |
| `can_add_ticket` | bool | `admin \|\| dispatcher \|\| user_add_call` | ⚠️ см. 2.2 |
| `can_view_reports` | bool | `admin \|\| dispatcher` | ✅ |
| `can_view_settings` | bool | `admin` | ✅ |
| `can_manage_dispatchers` | bool | `admin` | 🆕 опционально |

**`user_position` обязателен к внедрению:** правило отчётов «фильтр по ответственному доступен dispatcher / admin / foreman» опирается на `position`, а не на `role`. Без этого поля прораб на фронте не отличим от диспетчера.

### 2.2. Конфликт `can_add_ticket` ⚠️

Флаг `user_add_call` даёт `can_add_ticket: true` любому пользователю, включая `engineer`. Но `syncCommands` разрешает `CreateTicket` только `administrator` / `dispatcher`.

Следствие: инженер с этим флагом создаёт заявку офлайн → команда уходит в `archived` с `no_rights` → работа потеряна.

**Требуется согласование:** либо `user_add_call` даёт право создания и в sync-пути, либо `can_add_ticket` не учитывает этот флаг для `engineer`.

### 2.3. Роли

| Роль | Описание |
|---|---|
| `administrator` | полные права |
| `dispatcher` | создаёт и редактирует заявки, закрывает, комментирует |
| `engineer` | механик; видит свои заявки, закрывает и комментирует их |
| `guest` | только чтение |
| `reserved` | резерв, права гостя |

**Допустимы только эти пять значений.** Клиент нормализует всё неизвестное в `guest`.

⚠️ В БД встречается `user_role = 'mechanic'` (используется в отборе `staff_list`) и `user_position = 'foreman'`. Требуется нормализация на сервере: `mechanic → engineer`, `foreman → dispatcher`.

### 2.4. `menu_structure` ✅

| id | target_hash | Условие | Роут на фронте |
|---|---|---|---|
| `create` | `#/create` | `can_add_ticket` | ✅ |
| `open_tickets` | `#/` | всегда | ✅ |
| `closed_tickets` | `#/closed` | всегда | ✅ |
| `reports` | `#/reports` | admin / dispatcher | 🆕 в разработке |
| `addresses` | `#/addresses` | admin / dispatcher | ⚠️ не зарегистрирован |
| `settings` | `#/settings` | admin | ✅ |
| `more` | `#/more` | всегда | ⚠️ не зарегистрирован |

Элемент: `{ id, title, type: "nav-link"|"icon-button", target_hash, icon_svg?, required_permission?, is_default? }`.

⚠️ Пункты без зарегистрированного роута дают 404. До реализации экранов `addresses` и `more` должны быть скрыты.

### 2.5. `staff_list` ✅

Отбор: `(user_role IN ('mechanic','engineer') OR user_position = 'foreman') AND user_block <> 1`, сортировка по `user_name`.

Диспетчеры в список не попадают и не могут быть назначены ответственными.

| Поле | Тип |
|---|---|
| `id` | int |
| `name` | string |
| `phone` | string \| null |
| `role` | string \| null |
| `position` | string \| null |

`position` — для подписи должности, `role` — для прав. Словарь подписей на клиенте: `mechanic` → Механик, `foreman` → Прораб, `signalman` → Связист, `electronic-engineer` → Инженер-наладчик, `director` → Директор, `dispatcher` → Диспетчер, `admin` → Администратор, `auditor` → Аудитор. Неизвестное → «Сотрудник».

### 2.6. Справочники ✅

`department` (type=1), `request` (type=2), `group` (type=3) — ассоциативные объекты `{"id": "name"}`, сортировка по `type_name`.

`staff` (type=5) — служебный словарь, клиентом не используется. Кандидат на удаление.

`repair_time` — 10 строковых пресетов. Клиент использует собственный набор в `repair-time-picker.js`. Требуется решение: использовать серверный список или убрать поле.

### 2.7. Планируется 🆕

`elevator_groups` — массив `[{id, name}]` из таблицы `elevator_groups`. Таблица существует, в ответ не отдаётся.

---

## 3. `open` — открытые заявки

**Request:** `{ "data": "open" }`

**Response:** голый массив объектов (см. §17).

**Фильтрация ✅:** `call_status = 0`. Для `administrator` / `dispatcher` — все заявки. Для остальных — только где `call_staff`, `call_staff2` или `call_staff3` равны `user_id`. Сортировка `call_id DESC`.

---

## 4. `close` — закрытые заявки

**Request:** `{ "data": "close", "period": "1" }`

| `period` | Период |
|---|---|
| `"1"` | 24 часа |
| `"2"` | 2 дня |
| `"3"` | 3 дня |
| `"7"` | 7 дней |

Максимум 7 дней, значение ограничивается сервером.

**Response:** голый массив. Фильтр `call_status = 1 AND call_date2 >= :date_close`, права как в `open`, сортировка `call_date2 DESC`.

**Тело заметок в списке закрытых не отдаётся** ⚠️ — при закрытии они сериализуются в `call_full_note_history` и удаляются из `lift_notes`. Список содержит только `note_num` и `other`, вычисленные из слепка. Полные заметки — через `ticket` (§5).

---

## 5. `ticket` — одна заявка

**Request:** `{ "data": "ticket", "call_id": 35732 }`

**Response:**

```json
{
  "status": "ok",
  "data": {
    "id": 35732,
    "call_id": 35732,
    "call_number": "35732",
    "type": "open",
    "fullAddress": "г. Ростов-на-Дону, ул. Ленина, д.5, п.1 пасс.",
    "city_id": 1, "street_id": 2, "home_id": 3, "object_id": 11,
    "details": "Застревание пассажира",
    "date": 1761214200,
    "repair_time": 1761220800,
    "department": "1.Электромеханики", "department_id": "22",
    "group": "1.Застревание", "group_id": "4",
    "request": "1.Срочная", "request_id": "1",
    "elevator_group_id": null, "elevator_group_name": null,
    "alert_level": 3, "is_emergency": true,
    "other": "Есть заметки (2)", "note_num": 2,
    "staff_id": 3, "staff_name": "Сергеенко Сергей", "staff_phone": "+7...",
    "notify_status": 1, "notify_date": 1761215000,
    "staff_id2": null, "staff_name2": null, "staff_phone2": null,
    "notify_status2": null, "notify_date2": null,
    "staff_id3": null, "staff_name3": null, "staff_phone3": null,
    "notify_status3": null, "notify_date3": null,
    "solution": "—", "close_name": "—", "close_date": null,
    "full_history": "[02.11.2026 14:30] Заявка создана пользователем Иванов И.",
    "note": [
      { "id": 144, "user": "Петров П.", "body": "Выехал", "date": 1761214500, "type": 0, "is_offline": 0 }
    ],
    "can_edit": true, "can_close": true, "can_comment": true,
    "closureallowed": 0
  }
}
```

### 5.1. Идентификатор ⚠️

**Обязательны все три поля: `id` (int), `call_id` (int), `call_number` (string)** — с одинаковым значением.

Сейчас карточка отдаёт только `call_id` + `call_number`, а списки — только `id`. Клиент читает `id`, поэтому карточка, открытая по прямой ссылке, не показывает номер и не может сохранить изменения.

### 5.2. Заметки

`note` — **массив**, не объект с числовыми ключами. Для открытых читается из `lift_notes`, для закрытых — из `call_full_note_history`.

Элемент: `{ id, user, body, date, type, is_offline }`. `is_offline: 1` — заметка создана офлайн, клиент рисует маркер ⏳.

### 5.3. История

`full_history` — **plain text**, строки вида `[dd.mm.yyyy hh:mm] [Офлайн] текст`, разделённые `\n`. Источник `offline_sync` помечается префиксом `[Офлайн]`.

### 5.4. Права ⚠️

| Поле | Правило (целевое) |
|---|---|
| `can_edit` | `type = open` И (`admin` ИЛИ `dispatcher`) |
| `can_close` | `type = open` И (`admin` ИЛИ `dispatcher` ИЛИ (`engineer` И назначен)) |
| `can_comment` | `type = open` И (`admin` ИЛИ `dispatcher` ИЛИ (`engineer` И назначен)) |
| `closureallowed` | определить судьбу: отдавать осмысленно или удалить |

Сейчас `can_close` разрешает любому `engineer` без назначенности, `can_edit` — назначенному `engineer`. Both расходятся с матрицей `API_syncCommands.md` §2.2. `closureallowed` захардкожен в 0.

**Права вычисляются той же логикой, что и серверная проверка при выполнении действия** — один источник истины.

### 5.5. Особые случаи ✅

| Ситуация | Ответ |
|---|---|
| Заявка не найдена | `{status:"ok", data:null}` |
| Нет прав на просмотр | `{status:"ok", data:null}` |
| `call_id = 0` или отсутствует | `{status:"ok", data:null}` |
| ID начинается с `offline_` | клиент не отправляет запрос, читает из `offlineDB` |

---

## 6. `loadAddress` — справочник адресов

**Request:** `{ "data": "loadAddress" }`

**Response ✅:**

```json
{
  "status": "ok",
  "action": "loadAddress",
  "message": {
    "city":   [{ "id": 1, "city_name": "г. Ростов-на-Дону" }],
    "street": [{ "id": 2, "street_name": "ул. Ленина", "city_id": 1 }],
    "home":   [{ "id": 5, "home_name": "5", "street_id": 2 }],
    "object": [{ "id": 209, "object_name": "п.1 пасс.", "home_id": 5, "group_id": 1 }]
  }
}
```

Все четыре выборки фильтруются по `vis = 1`. Скрытые объекты не отдаются.

**`include_hidden` не поддержан** ⚠️ — параметр и поля `is_hidden` / `hidden_reason` / `suspended_at` из v4.2 удалены как нереализованные.

**Примечание:** если город, улица или дом скрыты, а лифт видим — лифт отбрасывается клиентом при сплющивании (не находит родителя). Целостность справочника — на стороне данных.

Клиент кэширует результат в IndexedDB (`address_flat`) и использует как источник для выбора адреса, **включая экран отчётов** — запрет на `offlineDB` в отчётах касается только `outbox`, не кэша справочников.

---

## 7. `callnew` — создание заявки

**Request:**

```json
{
  "action": "callnew",
  "city_id": 1, "street_id": 2, "home_id": 3, "object_id": 11,
  "fullAddress": "г. Ростов-на-Дону, ул. Ленина, д.5, п.1 пасс.",
  "group_id": "4", "request_id": "1", "department_id": "22",
  "repair_time": 1761220800,
  "details": "Застревание пассажира. Кабина на 3 этаже.",
  "staff_id": 3,
  "force_create": false
}
```

| Поле | Обязательность | Примечание |
|---|---|---|
| `city_id`, `street_id`, `home_id`, `object_id` | ✅ | адрес должен разрешаться одним JOIN |
| `fullAddress` | ✅ | текст для отображения |
| `group_id`, `request_id`, `department_id` | ✅ | ID из справочников |
| `details` | ✅ | минимум 6 символов |
| `repair_time` | ✅ | Unix timestamp, не в прошлом |
| `staff_id` | ❌ | 0 / отсутствует = не назначен |
| `force_create` | ❌ | обход проверки дублей после подтверждения |

### 7.1. `repair_time` ⚠️

Значение клиента сохраняется в `expected_repair_time` **без сдвигов** (см. §1.2).

Сейчас значение валидируется, но выбрасывается — в БД всегда уходит `time() + 3 дня`. Требуется исправить.

Для офлайн-создания (`syncCommands`) поле **игнорируется**, сервер ставит `time()` на момент синхронизации — см. `API_syncCommands.md` §4.2.

### 7.2. Проверки ✅

| Условие | Результат |
|---|---|
| `details` < 6 символов | `invalid_input`, reason `details_too_short` |
| `repair_time` > 0 и < `time()` | `invalid_input`, reason `repair_time_in_past` |
| Адрес не разрешается | `not_found`, reason `object_not_found` |
| Активная заявка на тот же объект **и отдел**, без `force_create` | `invalid_input`, reason `duplicate_detected` + список |
| Роль без права создания | `forbidden` ⚠️ проверка не реализована |

**`object.vis = 0` не блокирует создание.** Заявка создаётся, в `lift_history` пишется пометка «объект выведен из обслуживания на момент синхронизации». Код `contract_terminated` для этого случая не используется.

### 7.3. Дубликаты ✅

Дубликатом считается активная заявка (`call_status = 0`) на том же `address_lift` **и** в том же `call_department`. Группа в фильтр не входит осознанно.

Список снимается **до** INSERT. При `force_create = true` заявка создаётся, а номера существующих дубликатов попадают в `lift_history` как аудит-пометка.

Форма ответа при отказе:

```json
{
  "status": "error",
  "code": "invalid_input",
  "reason": "duplicate_detected",
  "message": "На объект уже есть активная заявка",
  "existing_tickets": [
    { "ticket_id": 35732, "details": "Не горит свет", "date": 1761214200 }
  ]
}
```

### 7.4. Вычисляемые поля ✅

| Поле | Правило |
|---|---|
| `alert_level` | `department_id = 23` → 3; `request_id = 1` → 2; иначе 1 |
| `call_date` | `time()` |
| `call_status` | 0 |
| `call_user` | ID создателя |
| `call_first_name` | имя создателя |

**Response ⚠️:**

```json
{ "status": "ok", "call_id": 35733, "message": "Заявка успешно создана." }
```

Поле `generated_id` из v4.2 заменено на `call_id` — фактическое имя.

---

## 8. `calledit` — редактирование

**Request:**

```json
{
  "action": "calledit",
  "call_id": 35732,
  "staff_id": 3, "notify_status": 1,
  "staff_id2": 1, "notify_status2": 2,
  "group_id": "9", "department_id": "23", "request_id": "2",
  "repair_time": 1761230000,
  "details": "Дополнение к описанию"
}
```

Передаются только изменённые поля.

### 8.1. Ограничения

| Правило | Статус |
|---|---|
| Адрес менять нельзя | ✅ |
| Закрытие через `calledit` запрещено | ✅ |
| Заявка закрыта → отказ | ✅ `closed`, reason `ticket_already_closed` |
| Одно назначение или снятие ответственного за запрос | 🆕 не реализовано |
| Проверка роли | ⚠️ не реализована |

### 8.2. Поведение полей ✅

`details` — **дополнение**, не замена: `call_details = old + "\n\n" + delta`.

`notify_status` — при установке ненулевого значения одновременно пишется `call_staff_date = time()`; при обнулении — `call_staff_date = 0`.

Онлайн перезаписывает значения независимо от текущих. Мягкое слияние («только если поле пусто») применяется **исключительно** в офлайн-пути — см. `API_syncCommands.md` §4.3.

**Response:** `{ "status": "ok", "message": "Изменения по заявке №35732 сохранены." }`

---

## 9. `callClose` — закрытие

**Request:** `{ "action": "callClose", "call_id": 35732, "solution": "...", "user_id": 3 }`

`solution` — минимум 6 символов. `user_id` — для логирования.

### 9.1. Поведение ✅

1. Все заметки из `lift_notes` сериализуются в `call_full_note_history` (JSON).
2. Заметки удаляются из `lift_notes`.
3. Устанавливаются `call_status = 1`, `call_date2 = closed_at`, `call_solution`, `call_last_name`.
4. Запись в `lift_history`, инкремент версии заявок, событие `ticket_closed`.

**Колонки БД:** дата закрытия — `call_date2`, имя закрывшего — `call_last_name`. Имена `call_close_date` / `call_close_name` из прежних документов ошибочны.

### 9.2. Закрытие финально

Закрытая заявка **не переоткрывается**. Единственный путь продолжить работу по объекту — «Закрыть и создать новую для этого объекта»: создаётся отдельная заявка с новым ID, связанная с предыдущей только адресом.

**Response:** `{ "status": "ok", "message": "Заявка №35732 успешно закрыта." }`

**Ошибки:** `closed` (reason `ticket_already_closed`), `not_found`, `invalid_input` (reason `solution_too_short`), `forbidden` ⚠️.

---

## 10. `callnote` — комментарий

**Request:** `{ "action": "callnote", "call_id": 35732, "note": "Текст", "photo_base64": "data:image/jpeg;base64,..." }`

`note` — минимум 6 символов. Принимается также алиас `text`.

**`photo_base64` игнорируется** ⚠️ — поле документируется, но не обрабатывается. Требуется решение: реализовать приём (в БД есть `lift_notes.img_name` и таблица `lift_upload`, лимит 2 фото на заявку) либо убрать из протокола и из UI.

**Response:** `{ "status": "ok", "message": "Комментарий добавлен к заявке №35732." }`

**Ошибки:** `closed`, `not_found`, `invalid_input` (reason `text_too_short`), `forbidden` ⚠️.

---

## 11. `notifications` — события и версии

**Request:**

```json
{
  "data": "notifications",
  "since_id": 142857,
  "versions": { "staff": 15, "dicts": 8, "addresses": 3, "open_tickets": 42, "closed_tickets": 17 }
}
```

**Response:**

```json
{
  "status": "ok",
  "notifications": [
    {
      "id": 142859,
      "event_type": "emergency",
      "ticket_id": 35732,
      "actor_id": 5,
      "text": "Аварийная заявка №35732",
      "sound": true,
      "timeout": 15000,
      "created_at": 1761215710
    }
  ],
  "last_id": 142859,
  "versions": { "staff": 15, "dicts": 8, "addresses": 3, "open_tickets": 42, "closed_tickets": 17 },
  "outdated": []
}
```

### 11.1. Поля события

| Поле | Тип | Статус |
|---|---|---|
| `id` | int | ✅ |
| `event_type` | string | ⚠️ см. 11.2 |
| `ticket_id` | int \| null | ✅ |
| `actor_id` | int | ⚠️ **не отдаётся** — колонка `user_id` не выбрана |
| `text` | string | ✅ |
| `sound` | bool | ✅ |
| `timeout` | int \| null | ✅ |
| `created_at` | int | ⚠️ не отдаётся |

**`actor_id` критичен:** клиент фильтрует собственные действия по нему. Без поля фильтрация не работает, и пользователь получает тосты о своих же операциях, включая звуковые.

### 11.2. Типы событий ⚠️

| Генерируется | Ожидается клиентом |
|---|---|
| `ticket_created` | ✅ совпадает |
| `ticket_closed` | ✅ совпадает |
| `ticket_edited` | нет в словаре клиента |
| `ticket_note` | `note_added` |

Типы `ticket_reassigned`, `staff_accepted`, `ticket_overdue`, `emergency`, `staff_unassigned` описаны, но не генерируются. Требуется синхронизация словаря.

### 11.3. Версии слоёв ⚠️

Сервер отдаёт числовые версии слоёв данных. Клиент передаёт свои; сервер возвращает `outdated` — список слоёв, где серверная версия больше клиентской.

| Ключ | Инкремент при |
|---|---|
| `staff` | изменении справочника сотрудников |
| `dicts` | изменении отделов / типов / групп |
| `addresses` | изменении адресного справочника |
| `open_tickets` | `callnew` (открытая), `calledit`, `callnote`, `callClose` |
| `closed_tickets` | `callnew` (сразу закрытая), `callClose` |

**Сейчас существует единственный ключ `tickets`**, а клиент отправляет `open_tickets`. Сравнение всегда идёт с нулём → `outdated` непустой на каждом ответе → полный список открытых перезапрашивается каждые 120 секунд независимо от изменений.

Требуется завести оба ключа и расставить инкременты по таблице. Инкремент — строго после успешного коммита.

**Правило клиента:** в запрос отправляются версии **применённых** данных, а не полученных. Отметка «применено» ставится после успешной записи, что делает потерянное обновление самовосстанавливающимся на следующем тике.

### 11.4. Прочее

Окно свежести событий — 30 минут, чистка вероятностная при создании события. Лимит выборки по умолчанию 50 ⚠️ (протокол предполагал 10–20; при массовых операциях клиент получает лавину тостов).

---

## 12. `syncCommands` — офлайн-пачка

Универсальный эндпоинт офлайн-синхронизации. Полная спецификация — `API_syncCommands.md` v5.3.

| Параметр | Значение |
|---|---|
| Максимум команд в пачке | 20 |
| Максимальный вес пачки | 3.5 МБ (JSON) |
| Максимальный размер запроса | 10 МБ |
| Атомарность | частичный успех |
| Идемпотентность | `batch_id` + `command_uuid` |
| Таймаут клиента | 30 с |

Типы команд: `CreateTicket`, `EditTicket`, `CloseTicket`, `AddComment`. `AcceptTicket` зарезервирован для мобильного клиента.

**Форма ответа ⚠️:**

```json
{
  "status": "ok",
  "data": {
    "batch_id": "batch_1761234567_xyz789",
    "results": [],
    "summary": { "success": 0, "archived": 0, "ignored": 0, "failed": 0, "duplicate_detected": 0 },
    "created_tickets": {}
  }
}
```

Сейчас поля лежат плоско, рядом со `status`. Требуется вложить под `data` для единообразия с `ticket`. Клиент поддерживает оба варианта.

**Гарантия полноты:** на каждую отправленную команду возвращается ровно один элемент `results` с тем же `command_uuid`. Единственное исключение — `status: "error"` верхнего уровня, когда пачка отклонена целиком.

---

## 13. Профиль и настройки 🆕

Экшены `get_user_settings` и `save_user_settings` **не реализованы** — запросы уходят в `unknown_action`. Профиль и настройки колонок на клиенте не сохраняются.

### 13.1. `get_user_settings`

**Request:** `{ "data": "get_user_settings" }`

**Response:**

```json
{
  "status": "ok",
  "profile": {
    "id": 3,
    "surname": "Иванов",
    "name": "Иван",
    "patronymic": "Иванович",
    "role": "dispatcher"
  },
  "column_settings": {
    "open":   { "order": ["id","address","details","staff_name"], "hidden": ["staff_name2"] },
    "close":  { "order": ["id","address","solution","close_date"], "hidden": [] },
    "report": { "order": ["id","address","department"], "hidden": ["other"] }
  }
}
```

### 13.2. `save_user_settings`

**Request:**

```json
{
  "action": "save_user_settings",
  "profile": { "surname": "Иванов", "name": "Иван", "patronymic": "Иванович" },
  "password": { "old": "old_pass", "new": "new_pass" },
  "column_settings": {
    "open":  { "order": ["id","address"], "hidden": [] },
    "close": { "order": ["id","address"], "hidden": [] }
  }
}
```

`password` — `null` или отсутствует = пароль не меняется. При передаче требует оба поля.

**Response:** `{ "status": "ok", "message": "Настройки профиля успешно сохранены." }`

**Ошибки:** `invalid_input` с reason `invalid_password` (неверный текущий), `invalid_input` с reason `password_too_short` (менее 6 символов), `invalid_input` с reason `invalid_profile`.

### 13.3. Разрез по scope

`scope` ∈ `open` | `close` | `report`. На сервере хранятся **только `order` и `hidden`**.

Локально на клиенте (ключ обязательно содержит `user_id`): ширины колонок, колонка и направление сортировки, период закрытых, фильтры городов. Эти настройки устройство-специфичны и на сервер не уходят.

**Обратная совместимость:** плоский `{order, hidden}` трактуется как `open`; при следующем сохранении пишется структура с разрезом. Отдельная миграция не требуется.

### 13.4. Раздельное ФИО ⚠️

`AuthService::formatUser` возвращает `surname: null` и `patronymic: null` hardcoded. Сохранённое раздельное ФИО не восстанавливается после перезагрузки.

Требуется: добавить колонки `user_surname`, `user_patronymic` в `lift_users`, писать их в `save_user_settings`, возвращать в `formatUser` и `get_user_settings`. Поле `user_name` остаётся отображаемым именем.

---

## 14. Ключ организации 🆕

Экшены `check_org_key` и `get_org_users` **не реализованы**.

`org_key` — секрет уровня тенанта. **В резолве тенанта не участвует** (тенант определяется по `Host`, см. §18), проверяется в рамках уже определённого тенанта.

### 14.1. `check_org_key`

**Request:** `{ "data": "check_org_key", "org_key": "XXXX-XXXX-XXXX" }`

**Response:** `{ "status": "ok", "message": "Ключ действителен" }`

**Ошибки:** `invalid_input` reason `invalid_input` (ключ не передан), `invalid_input` reason `invalid_key` (не найден).

### 14.2. `get_org_users`

**Request:** `{ "data": "get_org_users", "org_key": "XXXX-XXXX-XXXX" }`

**Response:** `{ "status": "ok", "users": [ { "user_id": 3, "name": "Иванов Иван" } ] }`

**Отбор:** только пользователи с `user_position = 'dispatcher'`, не заблокированные. Используется для списка быстрого входа на странице логина.

---

## 15. Отчёты 🆕

Все запросы — `POST`, экшен в поле `action`. Ответ под `data`.

### 15.1. Общие фильтры

| Поле | Тип | Примечание |
|---|---|---|
| `date_from`, `date_to` | int | обязательны, Unix timestamp |
| `date_type` | `"created"` \| `"closed"` | по какой дате фильтровать |
| `city_id`, `street_id`, `home_id`, `object_id` | int \| null | адресный фильтр |
| `department_ids` | string[] | **включающий** фильтр, минимум один |
| `status` | `"all"` \| `"open"` \| `"close"` | |
| `is_emergency` | bool | только аварийные |
| `staff_id` | int \| null | фильтр по ответственному |
| `details_text`, `solution_text` | string | поиск по описанию / решению, AND |

Комбинация `date_type = "closed"` + `status = "open"` даёт пустой результат — у открытых нет даты закрытия.

### 15.2. `reports_filters_data`

**Response:** `{ "status": "ok", "data": { "departments": [{id, name}], "staff": [{id, name}] } }`

Адресный фильтр использует кэш `loadAddress` (§6) — отдельный эндпоинт не нужен.

### 15.3. `reports_stats`

**Response:**

```json
{
  "status": "ok",
  "data": {
    "total": 100, "open": 20, "closed": 80,
    "emergency_tickets": 5,
    "avg_close_time_seconds": 3600,
    "by_department": [{ "name": "1.Электромеханики", "count": 50 }],
    "by_city": [{ "name": "г. Ростов-на-Дону", "count": 70 }]
  }
}
```

### 15.4. `reports_list`

Дополнительно к общим фильтрам: `sort_by` (id колонки), `sort_dir` (`asc`|`desc`), `page` (от 1), `limit` (1–500, по умолчанию 50).

**Response:**

```json
{
  "status": "ok",
  "data": {
    "columns": [
      { "id": "id", "name": "№", "type": "number", "sortable": true, "default_visible": true },
      { "id": "address", "name": "Адрес", "type": "string", "sortable": true, "default_visible": true },
      { "id": "close_date", "name": "Дата закрытия", "type": "timestamp", "sortable": true, "default_visible": true }
    ],
    "items": [],
    "pagination": { "total_items": 150, "current_page": 1, "total_pages": 3 }
  }
}
```

**`columns` — единственный источник правды** о наборе, порядке и форматировании полей. `type`: `timestamp` → форматирование даты, `number` → выравнивание вправо, `string` → как есть.

Клиентские per-user настройки для scope `report` хранят `order` и `hidden` относительно этого массива. Новое поле на сервере появляется в отчёте без правки клиента.

**Сортировка и пагинация — только серверные.** Клиентская сортировка отсортирует лишь текущую страницу.

### 15.5. `reports_export`

Те же фильтры без `page` / `limit`, плюс `format`: `"xlsx"` | `"pdf"`.

**Response:** `{ "status": "ok", "data": { "file_base64": "...", "filename": "report.xlsx", "mime": "application/vnd..." } }`

Лимит выгрузки — 10 000 строк. Rate-limit — 10 запросов в час на пользователя. Аудит: запись с параметрами фильтров.

Для PDF требуются кириллические шрифты на сервере — проверить до реализации.

### 15.6. Права

| Роль / позиция | Видимость | Фильтр по ответственному |
|---|---|---|
| `administrator` | все заявки | ✅ |
| `dispatcher` | заявки своих групп | ✅ |
| `position = foreman` | заявки своих групп | ✅ |
| `engineer` | только свои (`call_staff*`) | ❌ |
| `guest` | доступа нет | ❌ |

Правило для прораба требует `user_position` в `config` (§2.1).

### 15.7. Офлайн

Отчёты работают **только онлайн**. При `navigator.onLine === false` клиент показывает заглушку и блокирует запросы. Обращений к `outbox` нет; кэш справочников использовать разрешено.

---

## 16. Обработка ошибок

### 16.1. Форма ⚠️

```json
{
  "status": "error",
  "code": "invalid_input",
  "reason": "details_too_short",
  "message": "Описание слишком короткое"
}
```

Обёртки `error` и объекта `details` **нет**. Поле `reason` — опциональное, содержит машиночитаемую конкретику. ⚠️ Сейчас конкретика передаётся только внутри `message` в формате `<reason>: <detail>`, что вынуждает клиента разбирать текст.

Для `rate_limited` поле `retry_after` передаётся **плоско на верхнем уровне**.

### 16.2. Коды (`ErrorCode`, 15 значений) ✅

| code | Когда | Обработка клиентом |
|---|---|---|
| `invalid_input` | валидация payload / параметров | показывает `message` |
| `forbidden` | нет прав | показывает `message` |
| `not_found` | сущность не найдена | 404-экран или `message` |
| `closed` | заявка уже закрыта | `message` |
| `token_expired` | access истёк | refresh → повтор запроса |
| `missing_token` | токен не передан | refresh → повтор запроса |
| `token_invalid` | токен недействителен | refresh → повтор запроса |
| `device_mismatch` | см. 16.4 | `auth:lost` → логин |
| `user_blocked` | учётная запись заблокирована | `auth:lost` → логин |
| `invalid_credentials` | неверный логин / пароль | текст на форме входа |
| `internal_error` | внутренняя ошибка | generic |
| `unknown_action` | неизвестный экшен | generic |
| `method_not_allowed` | не-POST | generic |
| `tenant_not_found` | домен не привязан к организации | заглушка на логине |
| `rate_limited` | превышен лимит | cooldown по `retry_after` |

### 16.3. Коды из v4.2, отсутствующие в реализации

| Документировался | Фактически |
|---|---|
| `call_already_closed` | `code: "closed"`, reason `ticket_already_closed` |
| `invalid_key`, `invalid_password`, `invalid_batch_id`, `commands_empty`, `commands_too_many`, `duplicate_command_uuid`, `invalid_action` | `code: "invalid_input"`, конкретика в `reason` |
| `unauthorized` | `code: "missing_token"` |
| `token_revoked` | не выдаётся |
| `contract_terminated` | не выдаётся; для `object.vis = 0` не применяется |
| `tenant_not_resolved`, `tenant_suspended` | не выдаются |

### 16.4. Известные пробелы ⚠️

**`device_mismatch` — мёртвый код.** Проверка устройства отсутствует и в `AuthService::validate`, и в `UserRepository`. Отпечаток `webgl` сохраняется, но не сравнивается. Требуется реализовать или убрать код и ветку на клиенте.

**Неизвестный домен даёт `internal_error`.** `Tenant::fromRequest` бросает `RuntimeException`, который перехватывается как `Throwable` → `internal_error`. Публичный `get_tenant_info` в тех же случаях корректно возвращает `tenant_not_found`. Требуется бросать `ApiException(TenantNotFound)`.

**`mapErrorCodeToReason` в sync-пути** возвращает `not_found` и `ticket_closed` вместо протокольных `ticket_not_found` и `ticket_already_closed`. Клиент не находит перевод и показывает сырой код.

### 16.5. Поведение клиента

| Ситуация | UI |
|---|---|
| `status: "error"` (кроме auth-кодов) | LED красный, строка в «Истории» с `message` |
| `token_expired` / `missing_token` / `token_invalid` | мьютекс-refresh, повтор; при неудаче `auth:lost` → логин |
| `device_mismatch` / `user_blocked` | `auth:lost` немедленно |
| Таймаут > 15 с | LED красный, «Превышено время ожидания» |
| Ответ не JSON | `invalid_response`, признак offline, cooldown синхронизации |
| Сеть недоступна | `network_error`, признак offline |

При ошибке загрузки уже отображённые данные **не очищаются** — пользователь продолжает видеть последнее успешное состояние.

---

## 17. Сводная таблица полей заявки

| Поле | Тип | open | close | ticket | Статус |
|---|---|---|---|---|---|
| `id` | int | ✓ | ✓ | ✓ | ⚠️ нет в ticket |
| `call_id` | int | ✓ | ✓ | ✓ | ⚠️ нет в списках |
| `call_number` | string | ✓ | ✓ | ✓ | ⚠️ нет в списках |
| `type` | `"open"` \| `"close"` | ✓ | ✓ | ✓ | ✅ |
| `fullAddress` | string | ✓ | ✓ | ✓ | ✅ |
| `city_id` / `street_id` / `home_id` / `object_id` | int | ✓ | ✓ | ✓ | ✅ |
| `details` | string | ✓ | ✓ | ✓ | ✅ |
| `staff_id` | int \| null | ✓ | ✓ | ✓ | ✅ |
| `staff_name` | string \| null | ✓ | ✓ | ✓ | ✅ |
| `staff_phone` | string \| null | ✓ | ✓ | ✓ | ⚠️ нет в списках |
| `notify_status` | int \| null | ✓ | ✓ | ✓ | ✅ |
| `notify_date` | int \| null | ✓ | ✓ | ✓ | ✅ |
| `staff_id2` / `staff_id3` | int \| null | ✓ | ✓ | ✓ | ⚠️ нет в списках |
| `staff_name2` / `staff_name3` | string \| null | ✓ | ✓ | ✓ | ⚠️ нет в списках |
| `staff_phone2` / `staff_phone3` | string \| null | ✓ | ✓ | ✓ | ⚠️ нет в списках |
| `notify_status2` / `notify_status3` | int \| null | ✓ | ✓ | ✓ | ⚠️ нет в списках |
| `notify_date2` / `notify_date3` | int \| null | ✓ | ✓ | ✓ | ⚠️ нет в списках |
| `department` / `department_id` | string | ✓ | ✓ | ✓ | ✅ |
| `group` / `group_id` | string | ✓ | ✓ | ✓ | ✅ |
| `request` / `request_id` | string | ✓ | ✓ | ✓ | ✅ |
| `elevator_group_id` / `elevator_group_name` | int \| null / string \| null | ✓ | ✓ | ✓ | 🆕 заглушки |
| `date` | int | ✓ | ✓ | ✓ | ✅ |
| `repair_time` | int \| null | ✓ | ✓ | ✓ | ⚠️ см. §7.1 |
| `solution` | string | `"—"` | ✓ | ✓ | ✅ |
| `close_name` | string | `"—"` | ✓ | ✓ | ✅ |
| `close_date` | int \| null | null | ✓ | ✓ | ✅ |
| `full_history` | string \| null | null | ✓ | ✓ | ✅ |
| `alert_level` | int 1–3 | ✓ | ✓ | ✓ | ✅ |
| `is_emergency` | bool | ✓ | ✓ | ✓ | ✅ |
| `other` | string | ✓ | ✓ | ✓ | ⚠️ для close всегда «—» |
| `note_num` | int | ✓ | ✓ | ✓ | ⚠️ для close всегда 0 |
| `note` | **array** | ✓ | пусто | ✓ | ⚠️ списки отдают объект |
| `can_edit` / `can_close` / `can_comment` | bool | ✓ | ✓ | ✓ | ⚠️ нет в списках |
| `closureallowed` | int 0 \| 1 | ✓ | — | ✓ | ⚠️ захардкожен 0 |

**Отсутствие `staff_id2` / `staff_id3` в списках — функциональный баг:** клиент проверяет назначенность по всем трём слотам. Механик, назначенный вторым или третьим, видит заявку (SQL-фильтр пропускает), но кнопки «Закрыть» и «Комментировать» скрыты.

**`note` — массив везде.** Объект с числовыми ключами объявляется deprecated; клиент нормализует оба формата, но новые интеграции должны опираться на массив.

---

## 18. Мультитенантность

### 18.1. Определение тенанта ✅

**Единственный способ — заголовок `Host`.** Ни `X-Tenant`, ни JWT `tenant_id`, ни `org_key` в резолве не участвуют.

Алгоритм:
1. `HTTP_HOST`, отбросить порт, привести к нижнему регистру.
2. Разделить по `.`, требуется не менее трёх частей.
3. Поддомен = первая часть.
4. Не входит в зарезервированные: `www`, `api`, `admin`, `mail`, `test`, `dev`, `staging`, `docs`, `cp`, `ftp`, `mysql`, `ns1`, `ns2`, `org`.
5. Соответствует `/^[a-z0-9][a-z0-9-]{0,30}$/`.
6. Поиск в master-реестре по поддомену.

Каждый тенант — **отдельная БД**. Соединение устанавливается через `DB::forTenant`.

### 18.2. Ошибки

| Ситуация | Код | Статус |
|---|---|---|
| Неверный формат домена | `tenant_not_found` | ⚠️ сейчас `internal_error` |
| Зарезервированный поддомен | `tenant_not_found` | ⚠️ сейчас `internal_error` |
| Организация не найдена | `tenant_not_found` | ⚠️ сейчас `internal_error` |
| Публичный `get_tenant_info`, те же случаи | `tenant_not_found` | ✅ |

### 18.3. `get_tenant_info` ✅

Публичный, без авторизации. Вызывается при загрузке SPA до логина.

**Request:** `{ "action": "get_tenant_info" }`

**Response:** `{ "status": "ok", "data": { "org_name": "ООО «Лифт-Сервис»" } }`

**Rate-limit:** 10 секунд между запросами, через cookie `tenant_info_last`. ⚠️ Cookie-лимит обходится неотправкой cookie; для реальной защиты нужен лимит по IP.

Клиент кэширует `org_name` в `localStorage` с TTL 5 минут: сначала показывает из кэша, параллельно обновляет с сервера.

---

## 19. Аутентификация

Точка входа `/auth.php`, экшен в query: `?action=login|refresh|logout|validate`.

### 19.1. `login` ✅

**Request:** `POST /auth.php?action=login`

```json
{ "name": "dispatcher", "pname": "123456", "webGL": "<fingerprint>", "user_id": 3, "autoLogin": true }
```

`user_id` опционален: при передаче поиск по ID, иначе по `name`. Если `name` содержит `@` — поиск по `user_email`, иначе по `user_login`. Пароль обязателен.

`autoLogin` принимается, но на срок жизни токенов не влияет.

**Response:**

```json
{
  "status": "ok",
  "access_token": "<64 hex>",
  "expires_at": 1761221700,
  "user": { "id": 3, "name": "Иванов Иван", "surname": null, "patronymic": null, "role": "dispatcher" }
}
```

**Побочные эффекты:** cookie `lift_refresh` (30 дней, Secure, HttpOnly, SameSite=Strict, path=/); запись в `lift_access_tokens`.

**Автомиграция пароля:** при успешном входе устаревший хэш перезаписывается на bcrypt.

**Ошибки:** `invalid_input` (пустой пароль), `invalid_credentials`, `user_blocked`.

⚠️ Ограничение попыток входа отсутствует — перебор не блокируется.

### 19.2. `refresh` ✅

**Request:** `POST /auth.php?action=refresh`, тело `{}`, cookie `lift_refresh`.

**Response:** идентичен `login`.

**Ошибки:** `missing_token` (нет cookie), `token_expired` (refresh не найден или истёк).

### 19.3. Критический дефект срока жизни ⚠️

`findByAccessToken` возвращает `u.*` — то есть `api_token_expires` из **старой колонки** `lift_users`, а не `expires_at` из `lift_access_tokens`. `AuthService::validate` сравнивает эту колонку с `time()`.

Колонку пишет только `updateApiToken`, вызываемый **один раз при логине**. В `handleRefresh` вызов закомментирован.

| Момент | `lift_users.api_token_expires` | `lift_access_tokens.expires_at` | Результат |
|---|---|---|---|
| логин, t=0 | 7200 | t0+7200 | ok |
| refresh, t=7000 | 7200 | t0+14000 | ok |
| refresh, t=7300 | 7200 | t0+14300 | **TokenExpired** |

**Через 2 часа после логина любой refresh падает**, несмотря на валидный 30-дневный refresh-токен. Пользователь вынужден входить заново каждые 2 часа.

**Исправление:** убрать избыточную проверку в `validate` — SQL уже фильтрует `expires_at > NOW()`. Либо выбирать `UNIX_TIMESTAMP(a.expires_at) AS api_token_expires`.

### 19.4. Прочие дефекты ⚠️

| Дефект | Следствие |
|---|---|
| Refresh не ротируется | украденный токен действует 30 дней, повторное использование не обнаруживается |
| Logout не отзывает access-токены | токен работает до 2 часов после выхода |
| Двойная генерация access в `login` и `refresh` | лишний токен в БД, мусорный код |
| DATETIME через `date()` vs `NOW()` | срок сдвигается при расхождении PHP TZ и MySQL TZ |
| `surname` / `patronymic` = null | ФИО не восстанавливается после перезагрузки |

### 19.5. Вычисление роли ⚠️

Берётся `user_role`. Если пуст или `guest`, применяется fallback:

| Условие | Роль |
|---|---|
| `user_localadmin` истинно или `user_level = 0` | `administrator` |
| `user_disppermission` истинно или `user_level = 3` | `dispatcher` |
| `user_level = 2` | `engineer` |
| иначе | `guest` |

**Требуется:**
- нормализация `mechanic → engineer`, `foreman → dispatcher`;
- убрать `user_level = 0 → administrator` (необнулённый уровень даёт админа);
- возвращать реальные `surname` / `patronymic`.

### 19.6. `logout` ✅

**Request:** `POST /auth.php?action=logout`, тело `{}`, cookie `lift_refresh`.

**Response:** `{ "status": "ok", "message": "Вы вышли из системы" }`

Удаляет запись refresh, очищает cookie. ⚠️ Access-токены не отзываются.

### 19.7. `validate` ✅

**Request:** `POST /auth.php?action=validate`, заголовок `Authorization: Bearer <access>`.

**Response:** `{ "status": "ok", "user": {...} }`

### 19.8. Сроки жизни

| Сущность | TTL | Хранение |
|---|---|---|
| access | 7200 с (2 ч) | `lift_access_tokens`; на клиенте только в памяти |
| refresh | 30 дней | `lift_refresh_tokens` + HttpOnly cookie |

Клиент не хранит access в `localStorage`. При перезагрузке сессия восстанавливается через `refresh`.

---

## 20. Технический долг

| Пункт | Раздел |
|---|---|
| Проверка прав в online-пути отсутствует | §7–10 |
| `can_*` мягче матрицы прав | §5.4 |
| `device_mismatch` не реализован | §16.4 |
| Фото в `callnote` игнорируется | §10 |
| Rate-limiting не реализован | §16.1, §18.3 |
| `elevator_group_*` — заглушки | §17 |
| `results[].changes` и `archive_id` не возвращаются | §12 |
| Ограничение попыток входа отсутствует | §19.1 |
| Одно назначение/снятие за запрос не проверяется | §8.1 |
| `include_hidden` не поддержан | §6 |

---

## Приложение A. Легаси (вне области)

При `Tenant::legacyCompat` в ответ `config` добавляются:

- `is_legacy: true`
- `nav` — массив из 9 элементов: `user_id`, `read_all`, `edit_call`, `close_call`, `note_call`, `add_call`, `edit_user`, `edit_obj`, `local_admin`

Новый SPA эти поля не использует. Совместимость обеспечивается прокси-слоем.

---

**Конец `API_PROTOCOL.md` v4.3.**

---
