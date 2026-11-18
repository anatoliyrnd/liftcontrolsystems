```markdown
# 📘 Техническая спецификация: Модуль отчетов (Backend)

**Проект:** API лифтовой службы (offline-first архитектура)  
**Версия протокола:** v6.1 (финальная, после архитектурного ревью)  
**Дата:** 19.11.2026

## 🏗 1. Архитектурные принципы

### 1.1. Слоистость
```

ApiController::handle()
↓ match (action)
ReportsController (новый)
↓
ReportsService
↓
ReportsQueryBuilder ← ReportsRepository
↓
DB (PDO)

```

### 1.2. Единый конструктор фильтров
Логика построения `WHERE` вынесена в `ReportsQueryBuilder`, который переиспользуется в трех action'ах:
- `reports_stats` (агрегаты)
- `reports_list` (пагинация)
- `reports_export` (полная выгрузка до 2000 строк)

**Принцип:** все три endpoint'а работают с идентичной выборкой — отличается только агрегация/пагинация.

### 1.3. Без кэша
Файловый кэш не реализуется. Отчёты — не hot path, запросы раз в минуту. Оптимизация через индексы даёт больше, чем кэш. Если нагрузка станет проблемой — добавить APCu позже.

## 🗄 2. Структура БД (релевантная для отчетов)

### 2.1. `lift_calls` (основная таблица заявок)
| Поле | Тип | Назначение |
|---|---|---|
| call_id | int PK | Номер заявки |
| call_status | int | 0=открыта, 1=закрыта |
| call_date | int | Timestamp создания |
| call_date2 | int | Timestamp закрытия (0 если открыта) |
| call_department | int FK | Отдел (из lift_types) |
| call_group | int FK | Тип неисправности (type=3) |
| call_request | int FK | Тип запроса (type=2) |
| call_staff / call_staff2 / call_staff3 | int FK | Ответственные (до 3) |
| call_staff_status / _status2 / _status3 | int | Статус уведомления |
| call_staff_date / _date2 / _date3 | int | Дата уведомления |
| call_details | text | Описание |
| call_solution | text | Решение (для закрытых) |
| call_adres | varchar | Полный адрес строкой |
| address_city / _street / _home / _lift | int FK | ID адресных сущностей |
| call_first_name | varchar | Создатель |
| call_last_name | varchar | Кто закрыл |
| alert_level | int | Уровень тревоги (1-3) |
| expected_repair_time | int | Ожидаемый срок ремонта |
| repair_time_is_default | int | 1=назначен сервером, 0=диспетчером |

### 2.2. `lift_users` (справочник сотрудников)
| Поле | Тип | Назначение |
|---|---|---|
| user_id | int PK | ID сотрудника |
| user_name | varchar | ФИО |
| user_phone | varchar | Телефон |
| user_position | varchar(50) | Должность: admin, dispatcher, foreman, mechanic, guest |
| vis | tinyint | Активен (1) или в архиве (0) |

### 2.3. Справочник типов `lift_types`
- Поле `type` определяет группу типа (1=отдел, 2=запрос, 3=группа)
- Поле `type_report` определяет аварийность (0=аварийная заявка)
- Поле `vis` — видимость в UI

### 2.4. Адресная иерархия
```

lift_city (id, city_name, vis)
└─ lift_street (id, street_name, city_id, vis)
└─ lift_home (id, home_name, street_id, vis)
└─ lift_object (id, object_name, home_id, group_id, vis)

````

## 🔑 3. Ролевая модель для отчетов

**Поля в JWT/пользователе:**
- `role` (legacy): `administrator` | `dispatcher` | `engineer` | `guest`
- `position` (новая): `admin` | `dispatcher` | `foreman` | `mechanic` | `guest`

**Правила доступа к отчетам:**
- **Полный доступ к сводке** (`reports_stats`): все роли (кроме `guest`)
- **Доступ к списку** (`reports_list`): все роли с фильтрацией по своим заявкам для `mechanic`
- **Фильтр `staff_id` в UI:** виден только ролям `dispatcher`, `admin`, `foreman` (проверка по `user_position`)
- **Экспорт** (`reports_export`): те же права, что и `reports_list`

## 📡 4. API-контракты

**Все запросы:** `POST /api.php` с `Authorization: Bearer <token>`

### 4.1. `action: reports_filters_data`
**Назначение:** Справочники для UI (отделы, сотрудники, города).

**Запрос:**
```json
{
  "action": "reports_filters_data"
}
````

**Ответ:**

```json
{
  "status": "ok",
  "data": {
    "departments": [{ "id": "22", "name": "Электромеханики" }],
    "staff": [{ "id": 1, "name": "Иванов", "position": "dispatcher" }],
    "cities": [{ "id": 1, "name": "Москва" }]
  }
}
```

**Алгоритм:**

- Отделы: `SELECT type_id, type_name FROM lift_types WHERE type = 1 AND vis = 1 ORDER BY type_name`
- Сотрудники: `SELECT user_id, user_name, user_position FROM lift_users WHERE vis = 1 ORDER BY user_name`
- Города: `SELECT id, city_name FROM lift_city WHERE vis = 1 ORDER BY city_name`

---

### 4.2. `action: reports_stats`

**Назначение:** Сводка для графиков и карточек сверху.

**Запрос:**

```json
{
  "action": "reports_stats",
  "date_from": 1699000000,
  "date_to": 1699500000,
  "date_type": "created" | "closed",
  "city_id": 1,
  "street_id": null,
  "home_id": null,
  "object_id": null,
  "city_only": false,
  "department_ids": ["22", "23"],
  "status": "all",
  "details_text": "",
  "solution_text": "",
  "is_emergency": false,
  "staff_id": null
}
```

**Ответ:**

```json
{
  "status": "ok",
  "data": {
    "total": 100,
    "open": 20,
    "closed": 80,
    "emergency_tickets": 5,
    "avg_close_time_seconds": 3600,
    "by_department": [{ "id": "22", "name": "Электромеханики", "count": 50 }],
    "by_city": [{ "id": 1, "name": "Москва", "count": 30 }],
    "by_group": [{ "id": "9", "name": "Неисправность дверей", "count": 15 }],
    "by_request": [{ "id": "3", "name": "Плановый ремонт", "count": 40 }],
    "by_alert_level": [
      { "level": 1, "count": 60 },
      { "level": 2, "count": 30 },
      { "level": 3, "count": 10 }
    ],
    "avg_repair_time": {
      "default": 50,
      "custom": 50,
      "avg_default_seconds": 259200,
      "avg_custom_seconds": 172800
    }
  }
}
```

**Алгоритм построения WHERE (`ReportsQueryBuilder::buildWhere()`):**

| Фильтр                      | SQL-условие                                                                                                                |
| --------------------------- | -------------------------------------------------------------------------------------------------------------------------- |
| date_type = "created"       | `call_date >= :from AND call_date <= :to`                                                                                  |
| date_type = "closed"        | `call_date2 >= :from AND call_date2 <= :to AND call_status = 1`                                                            |
| city_only = true            | Игнорируем street_id, home_id, object_id                                                                                   |
| city_only = false           | Логика: если есть object_id → фильтр по нему, иначе если home_id → по дому, иначе если street_id → по улице, иначе city_id |
| department_ids (включающий) | `call_department IN (:ids)`                                                                                                |
| status = "open"             | `call_status = 0`                                                                                                          |
| status = "close"            | `call_status = 1`                                                                                                          |
| status = "all"              | Без условия                                                                                                                |
| details_text (≥6 символов)  | `call_details LIKE '%text%'` **только если задан home_id или object_id**                                                   |
| solution_text (≥6 символов) | `call_solution LIKE '%text%'` **только если задан home_id или object_id**                                                  |
| is_emergency = true         | `JOIN lift_types t ON t.type_id = call_department AND t.type = 1 AND t.type_report = 0`                                    |
| staff_id                    | `(call_staff = :id OR call_staff2 = :id OR call_staff3 = :id)`                                                             |

**SQL для агрегатов:**

```sql
SELECT
  COUNT(*) AS total,
  SUM(CASE WHEN call_status = 0 THEN 1 ELSE 0 END) AS open,
  SUM(CASE WHEN call_status = 1 THEN 1 ELSE 0 END) AS closed,
  SUM(CASE WHEN t.type_report = 0 THEN 1 ELSE 0 END) AS emergency_tickets,
  AVG(CASE WHEN call_status = 1 THEN call_date2 - call_date END) AS avg_close_time_seconds
FROM lift_calls c
LEFT JOIN lift_types t ON t.type_id = c.call_department AND t.type = 1
WHERE ... {фильтры} ...
```

**SQL для группировок (отдельные запросы):**

```sql
-- by_department
SELECT t.type_id AS id, t.type_name AS name, COUNT(*) AS count
FROM lift_calls c
LEFT JOIN lift_types t ON t.type_id = c.call_department AND t.type = 1
WHERE ...
GROUP BY t.type_id, t.type_name
ORDER BY count DESC

-- by_city
SELECT ci.id, ci.city_name AS name, COUNT(*) AS count
FROM lift_calls c
LEFT JOIN lift_city ci ON c.address_city = ci.id
WHERE ...
GROUP BY ci.id, ci.city_name
ORDER BY count DESC

-- by_group
SELECT g.type_id AS id, g.type_name AS name, COUNT(*) AS count
FROM lift_calls c
LEFT JOIN lift_types g ON g.type_id = c.call_group AND g.type = 3
WHERE ...
GROUP BY g.type_id, g.type_name
ORDER BY count DESC

-- by_request
SELECT r.type_id AS id, r.type_name AS name, COUNT(*) AS count
FROM lift_calls c
LEFT JOIN lift_types r ON r.type_id = c.call_request AND r.type = 2
WHERE ...
GROUP BY r.type_id, r.type_name
ORDER BY count DESC

-- by_alert_level
SELECT alert_level AS level, COUNT(*) AS count
FROM lift_calls c
WHERE ...
GROUP BY alert_level
ORDER BY alert_level

-- avg_repair_time
SELECT
  SUM(CASE WHEN repair_time_is_default = 1 THEN 1 ELSE 0 END) AS default,
  SUM(CASE WHEN repair_time_is_default = 0 THEN 1 ELSE 0 END) AS custom,
  AVG(CASE WHEN repair_time_is_default = 1 AND call_status = 1 THEN expected_repair_time - call_date END) AS avg_default_seconds,
  AVG(CASE WHEN repair_time_is_default = 0 AND call_status = 1 THEN expected_repair_time - call_date END) AS avg_custom_seconds
FROM lift_calls c
WHERE ...
```

**Валидация:**

- Если `date_from > date_to` → вернуть `null` в `data` (не исключение)
- Если `date_to > end_of_today` → вернуть `null` в `data`
- Если `date_to - date_from > 90 * 86400` → ошибка `date_range_too_long`
- Если `details_text` или `solution_text` заданы без `home_id`/`object_id` → игнорировать фильтры (не ошибка)
- Фронт сам показывает красную обводку и блокирует кнопку

---

### 4.3. `action: reports_list`

**Назначение:** Таблица с пагинацией.

**Запрос:**

```json
{
  "action": "reports_list",
  "date_from": 1699000000,
  "date_to": 1699500000,
  "date_type": "created" | "closed",
  "city_id": 1,
  "street_id": null,
  "home_id": null,
  "object_id": null,
  "city_only": false,
  "details_text": "",
  "solution_text": "",
  "status": "all",
  "department_ids": ["22", "23"],
  "is_emergency": false,
  "staff_id": null,
  "sort": "date" | "address" | "department",
  "page": 1,
  "limit": 50
}
```

**Ответ:**

```json
{
  "status": "ok",
  "data": {
    "items": [
      {
        "call_id": 123,
        "type": "open",
        "fullAddress": "Москва, Ленина, д.1, л.101",
        "details": "Описание проблемы",
        "date": 1699000000,
        "close_date": null,
        "department": "Электромеханики",
        "department_id": "22",
        "staff_name": "Иванов",
        "notify_status": 1,
        "notify_date": 1699000100,
        "is_emergency": false,
        "solution": "—",
        "close_name": "—"
      }
    ],
    "pagination": {
      "total_items": 150,
      "current_page": 1,
      "total_pages": 3,
      "limit": 50
    }
  }
}
```

**Алгоритм:**

- Использовать тот же `WHERE`, что и в `reports_stats` (через `ReportsQueryBuilder`)
- **Сортировка:** `ORDER BY {sort}, call_id DESC` (детерминированный ORDER BY)
  - `date` → `call_date DESC` (или `call_date2 DESC` для закрытых)
  - `address` → `call_adres ASC`
  - `department` → `call_department ASC`
  - дефолт: `call_id DESC`
- Пагинация: `LIMIT :limit OFFSET :offset`
- Счетчик: отдельный `SELECT COUNT(*)` с тем же `WHERE` (для `total_items`)

**SQL для списка:**

```sql
SELECT
  c.call_id, c.call_status, c.call_adres, c.call_details,
  c.call_date, c.call_date2, c.call_solution, c.call_last_name,
  c.address_city, c.address_street, c.address_home, c.address_lift,
  c.call_department, c.call_staff, c.call_staff2, c.call_staff3,
  c.call_staff_status, c.call_staff_status2, c.call_staff_status3,
  c.call_staff_date, c.call_staff_date2, c.call_staff_date3,
  COALESCE(t.type_report = 0, 0) AS is_emergency,
  d.type_name AS department,
  u1.user_name AS staff_name,
  u2.user_name AS staff_name2,
  u3.user_name AS staff_name3
FROM lift_calls c
LEFT JOIN lift_users u1 ON c.call_staff = u1.user_id
LEFT JOIN lift_users u2 ON c.call_staff2 = u2.user_id
LEFT JOIN lift_users u3 ON c.call_staff3 = u3.user_id
LEFT JOIN lift_types d ON c.call_department = d.type_id
LEFT JOIN lift_types t ON t.type_id = c.call_department AND t.type = 1
WHERE ... {фильтры} ...
ORDER BY {sort}, c.call_id DESC
LIMIT :limit OFFSET :offset
```

**Ограничения безопасности:**

- `limit` жестко ограничен сервером: `min(50, max(10, limit))` → дефолт 50, максимум 200
- `page` должен быть ≥ 1

---

### 4.4. `action: reports_export`

**Назначение:** Скачивание CSV.

**Запрос:**

```json
{
  "action": "reports_export",
  "format": "csv",
  "date_from": 1699000000,
  "date_to": 1699500000,
  ... (те же фильтры, что в reports_list, без page/limit)
}
```

**Ответ:**

```json
{
  "status": "ok",
  "data": {
    "file_base64": "SWQ70JHRg9C6...",
    "filename": "report_2026-11-10.csv",
    "mime_type": "text/csv",
    "rows_count": 150
  }
}
```

**Алгоритм:**

- Применить фильтры через `ReportsQueryBuilder`
- **Жесткий лимит: `LIMIT 2000`** на уровне SQL
- Если выборка > 2000 → ошибка `export_too_many_rows` с подсказкой "Сузьте период поиска"
- Сгенерировать CSV с UTF-8 BOM и разделителем `;` (русская локаль Excel)
- Закодировать результат в base64 и вернуть

**Структура CSV (одна строка на заявку с wrap text):**
| № | Заголовок | Содержимое (с переносами \n) |
|---|---|---|
| 1 | ID | 123 |
| 2 | Адрес | Москва, Ленина, д.1, л.101\n10.11.2026 15:30 · Иванов И.И. |
| 3 | Описание | Полный текст call_details |
| 4 | Закрытие | 10.11.2026 18:00\nПетров П.П. или — если открыта |
| 5 | Отв. 1 | Иванов И.И.\nСтатус: Доставлено · 10.11.2026 15:35 |
| 6 | Отв. 2 | (если есть) по аналогии с колонкой 5 |
| 7 | Отв. 3 | (если есть) по аналогии с колонкой 5 |

**Маппинг `notify_status` (для экспорта):**

```php
$statusMap = [
    0 => 'Не отправлено',
    1 => 'Отправлено',
    2 => 'Доставлено',
    3 => 'Прочитано',
];
```

**Обработка пустой выборки:**
Если `LIMIT 2000` вернул 0 строк → вернуть ответ:

```json
{
  "status": "ok",
  "data": null,
  "message": "По вашему запросу ничего не найдено"
}
```

**Rate limit:** 1 экспорт на пользователя в 30 секунд (через файловый флаг в `_reports_exports/`).

## 🔧 5. Ключевые классы

### 5.1. `ReportsQueryBuilder`

```php
final class ReportsQueryBuilder
{
    public function __construct(private array $filters) {}
    public function buildWhere(): array  // возвращает [$sql, $params]
    public function buildCountSql(): string
    public function buildListSql(int $limit, int $offset, string $sort): string
    public function buildStatsSql(): string
    public function buildGroupByDepartmentSql(): string
    public function buildGroupByCitySql(): string
    public function buildGroupByGroupSql(): string
    public function buildGroupByRequestSql(): string
    public function buildGroupByAlertLevelSql(): string
    public function buildAvgRepairTimeSql(): string
}
```

### 5.2. `ReportsRepository`

```php
final class ReportsRepository
{
    public function getFiltersData(): array
    public function getStats(array $filters): array
    public function getList(array $filters, int $limit, int $offset, string $sort): array
    public function getExportData(array $filters, int $limit = 2000): array
    public function countTotal(array $filters): int
}
```

### 5.3. `ReportsService`

```php
final class ReportsService
{
    public function getFiltersData(): array
    public function getStats(array $filters): ?array  // null при невалидных датах
    public function getList(array $filters): array
    public function export(array $filters, string $format): ?array
}
```

### 5.4. `ReportsExporter`

```php
final class ReportsExporter
{
    public function renderCsv(array $rows): string  // binary content с UTF-8 BOM
}
```

## ⚠️ 6. Тонкости и edge cases

### 6.1. Валидация дат на сервере

```php
private function validateDates(int $from, int $to): bool
{
    $todayEnd = strtotime('today 23:59:59');
    $delta = $to - $from;

    if ($from > $to || $to > $todayEnd || $from <= 0) {
        return false;
    }

    if ($delta > 90 * 86400) {
        throw new ApiException(
            ErrorCode::InvalidInput,
            'Период не может превышать 90 дней',
            reason: 'date_range_too_long'
        );
    }

    return true;
}
```

Если невалидны → `getStats()`/`getList()` возвращают `null`, контроллер отдает `{"status":"ok", "data": null}`.

### 6.2. Поиск LIKE с минимальной длиной и обязательным адресом

```php
if (mb_strlen($text) >= 6 && ($homeId > 0 || $liftId > 0)) {
    $where[] = 'call_details LIKE :details';
    $params['details'] = '%' . $text . '%';
}
```

Короче 6 символов или без адреса → фильтр игнорируется (защита от случайных коротких запросов и DoS).

### 6.3. Открытые заявки + фильтр по дате закрытия

Если пользователь выбрал `status: "open"` и `date_type: "closed"` → результат всегда будет пустым (у открытых `call_date2 = 0`). Сервер честно возвращает пустой список, без ошибок.

### 6.4. Поиск по ID — изолированная форма

Реализуется на фронтенде через `action: ticket` с `call_id`. Сервер не нуждается в отдельном endpoint. Если `ticket` вернет `data: null` — фронт показывает 404.

### 6.5. `avg_close_time_seconds` при отсутствии закрытых

Если за период нет ни одной закрытой заявки → возвращается `null` (не `0`, чтобы отличать от мгновенного закрытия).

### 6.6. Защита от пустого `department_ids`

Бизнес-правило на фронте: нельзя снять галочку с последнего отдела.
Серверная защита: если `department_ids` пришел пустым → использовать все видимые отделы (не возвращать ошибку, иначе API сломается от DevTools-запросов).

### 6.7. Экспорт > 2000 строк

Если выборка превышает 2000 строк → ошибка `export_too_many_rows` с подсказкой "Сузьте период поиска". Не обрезать молча — пользователь не узнает о потере данных.

### 6.8. Часовой пояс

Клиент строит `date_from`/`date_to` как Unix-секунды **по Москве** (00:00:00 и 23:59:59). Сервер не прибавляет 86399 — клиент уже это сделал.

## 🧪 7. Чек-лист тестирования

### 7.1. Контрактные тесты

- [ ] `reports_filters_data` возвращает все 3 справочника
- [ ] `reports_stats` с пустыми фильтрами → агрегат по всем заявкам
- [ ] `reports_stats` с невалидными датами → `data: null`
- [ ] `reports_stats` с периодом > 90 дней → ошибка `date_range_too_long`
- [ ] `reports_list` с `page=2, limit=10` → правильный `OFFSET 10`
- [ ] `reports_list` возвращает корректный `pagination.total_pages`
- [ ] `reports_export` с 2001 строкой → ошибка `export_too_many_rows`

### 7.2. Фильтры

- [ ] `date_type: "created"` vs `"closed"` работают отдельно
- [ ] `city_only: true` игнорирует street/home/object
- [ ] `department_ids` работает как включающий
- [ ] `details_text` < 6 символов игнорируется
- [ ] `details_text` без адреса игнорируется
- [ ] `is_emergency: true` дает только аварийные (type_report=0)
- [ ] `sort: "date"` vs `"address"` vs `"department"` дают разный порядок

### 7.3. Экспорт

- [ ] CSV открывается в Excel, кириллица читается корректно (UTF-8 BOM)
- [ ] Wrap text работает, автофильтр активен
- [ ] Rate limit срабатывает (2-й запрос подряд → ошибка `rate_limit_exceeded`)
- [ ] Файлы > 5MB отдаются корректно (base64 не обрывается)

## 📊 8. Оценка реализации

| Блок                               | Часы          |
| ---------------------------------- | ------------- |
| ReportsQueryBuilder                | 3             |
| ReportsRepository                  | 4             |
| ReportsService + валидация         | 2             |
| ApiController::handle (4 action'а) | 2             |
| ReportsExporter::renderCsv         | 2             |
| Тесты и отладка                    | 4             |
| **Итого**                          | **~17 часов** |

## 🚀 9. Порядок реализации (рекомендуется)

**День 1:** `ReportsQueryBuilder` + `ReportsRepository` + тесты SQL на моках  
**День 2:** `ReportsService` + `ApiController` (3 action'а без экспорта)  
**День 3:** `ReportsExporter::renderCsv` + интеграция  
**День 4:** Rate limit + e2e тесты

## 📎 10. Связь с существующими компонентами

| Существующий компонент  | Изменения                                                  |
| ----------------------- | ---------------------------------------------------------- |
| ApiController::handle() | Добавить 4 новых action в match                            |
| UserRepository          | Добавить `findActiveByPosition()` для reports_filters_data |
| lift_users таблица      | Уже имеет user_position — изменений не требует             |

**Конец документа.**

```

```
