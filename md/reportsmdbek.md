# 📘 Техническая спецификация: Модуль отчетов

**Проект**: API лифтовой службы (offline-first архитектура)
**Версия протокола**: v6.0 (расширение v5.2)
**Дата**: 10.11.2026

---

## 🏗 1. Архитектурные принципы

### 1.1. Слоистость (сохраняется от v5.2)
```
ApiController::handle()
    ↓ match (action)
ReportsController (новый) / CallService (существующий)
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
- `reports_export` (полная выгрузка до 500 строк)

**Принцип**: все три endpoint'а работают с **идентичной** выборкой — отличается только агрегация/пагинация.

### 1.3. Файловый кэш с инвалидацией
- Папка: `/tmp/reports_cache/` (или `./cache/reports/`)
- TTL: 5 минут
- Ключ: `md5(json_encode($filters))`
- Инвалидация: при создании/закрытии/редактировании заявки (через `ReportsCache::invalidateAll()`) + ночной cron
- Опциональный APCu-слой поверх (если модуль установлен на хостинге)

---

## 🗄 2. Структура БД (релевантная для отчетов)

### 2.1. `lift_calls` (основная таблица заявок)
| Поле | Тип | Назначение |
|------|-----|------------|
| `call_id` | int PK | Номер заявки |
| `call_status` | int | 0=открыта, 1=закрыта |
| `call_date` | int | Timestamp создания |
| `call_date2` | int | Timestamp закрытия (0 если открыта) |
| `call_department` | int FK | Отдел (из `lift_types`) |
| `call_group` | int FK | Группа |
| `call_request` | int FK | Тип запроса |
| `call_staff` / `call_staff2` / `call_staff3` | int FK | Ответственные (до 3) |
| `call_staff_status` / `_status2` / `_status3` | int | Статус уведомления |
| `call_staff_date` / `_date2` / `_date3` | int | Дата уведомления |
| `call_details` | text | Описание |
| `call_solution` | text | Решение (для закрытых) |
| `call_adres` | varchar | Полный адрес строкой |
| `address_city` / `_street` / `_home` / `_lift` | int FK | ID адресных сущностей |
| `call_first_name` | varchar | Создатель |
| `call_last_name` | varchar | Кто закрыл |

### 2.2. `lift_users` (справочник сотрудников)
| Поле | Тип | Назначение |
|------|-----|------------|
| `user_id` | int PK | ID сотрудника |
| `user_name` | varchar | ФИО |
| `user_phone` | varchar | Телефон |
| `user_position` | varchar(50) | **Должность**: `admin`, `dispatcher`, `foreman`, `mechanic`, `guest` |
| `vis` | tinyint | Активен (1) или в архиве (0) |

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
```

---

## 🔑 3. Ролевая модель для отчетов

**Поля в JWT/пользователе:**
- `role` (legacy): `administrator` | `dispatcher` | `engineer` | `guest`
- `position` (новая): `admin` | `dispatcher` | `foreman` | `mechanic` | `guest`

**Правила доступа к отчетам:**
- Полный доступ к сводке (`reports_stats`): **все роли** (кроме `guest`)
- Доступ к списку (`reports_list`): **все роли** с фильтрацией по своим заявкам для `mechanic`
- Фильтр `staff_id` в UI: виден только ролям `dispatcher`, `admin`, `foreman` (проверка по `user_position`)
- Экспорт (`reports_export`): те же права, что и `reports_list`

**Примечание**: матрица прав по группам будет реализована позже; пока читаем `user_position` напрямую из БД.

---

## 📡 4. API-контракты

Все запросы: `POST /api.php` с `Authorization: Bearer <token>`

### 4.1. `action: reports_filters_data`

**Назначение**: Справочники для UI (отделы, сотрудники, города).

**Запрос**:
```json
{
  "action": "reports_filters_data"
}
```

**Ответ**:
```json
{
  "status": "ok",
  "data": {
    "departments": [
      {"id": "22", "name": "Электромеханики"}
    ],
    "staff": [
      {"id": 1, "name": "Иванов", "position": "dispatcher"}
    ],
    "cities": [
      {"id": 1, "name": "Москва"}
    ]
  }
}
```

**Алгоритм**:
1. Отделы: `SELECT type_id, type_name FROM lift_types WHERE type = 1 AND vis = 1 ORDER BY type_name`
2. Сотрудники: `SELECT user_id, user_name, user_position FROM lift_users WHERE vis = 1 ORDER BY user_name`
3. Города: `SELECT id, city_name FROM lift_city WHERE vis = 1 ORDER BY city_name`

**Кэш**: Файловый, TTL 1 час (справочники редко меняются).

---

### 4.2. `action: reports_stats`

**Назначение**: Сводка для графиков и карточек сверху.

**Запрос**:
```json
{
  "action": "reports_stats",
  "date_from": 1699000000,
  "date_to": 1699500000,
  "date_type": "created",
  "city_id": 1,
  "street_id": null,
  "home_id": null,
  "object_id": null,
  "department_ids": ["22", "23"],
  "status": "all",
  "details_text": "",
  "solution_text": "",
  "is_emergency": false,
  "staff_id": null
}
```

**Ответ**:
```json
{
  "status": "ok",
  "data": {
    "total": 100,
    "open": 20,
    "closed": 80,
    "emergency_tickets": 5,
    "avg_close_time_seconds": 3600,
    "by_department": [
      {"id": "22", "name": "Электромеханики", "count": 50}
    ],
    "by_city": [
      {"id": 1, "name": "Москва", "count": 30}
    ]
  }
}
```

**Алгоритм построения WHERE** (`ReportsQueryBuilder::buildWhere()`):

| Фильтр | SQL-условие |
|--------|-------------|
| `date_type = "created"` | `call_date >= :from AND call_date <= :to_end` |
| `date_type = "closed"` | `call_date2 >= :from AND call_date2 <= :to_end AND call_status = 1` |
| `date_to_end` | `= date_to + 86399` (включить весь последний день) |
| `city_only = true` | Игнорируем `street_id`, `home_id`, `object_id` |
| `city_only = false` | Логика: если есть `object_id` → фильтр по нему, иначе если `home_id` → по дому, иначе если `street_id` → по улице, иначе `city_id` |
| `department_ids` (включающий) | `call_department IN (:ids)` |
| `status = "open"` | `call_status = 0` |
| `status = "close"` | `call_status = 1` |
| `status = "all"` | Без условия |
| `details_text` (≥6 символов) | `call_details LIKE '%text%'` |
| `solution_text` (≥6 символов) | `call_solution LIKE '%text%'` |
| `is_emergency = true` | JOIN `lift_types t ON t.type_id = call_department AND t.type = 1 AND t.type_report = 0` |
| `staff_id` | `(call_staff = :id OR call_staff2 = :id OR call_staff3 = :id)` |

**SQL для агрегатов (один запрос с подзапросами)**:
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

**SQL для `by_department` и `by_city`** (отдельные запросы или UNION):
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
```

**Валидация дат**:
- Если `date_from > date_to` → вернуть `null` в `data` (не исключение)
- Если `date_to > end_of_today` → вернуть `null` в `data`
- Фронт сам показывает красную обводку и блокирует кнопку

---

### 4.3. `action: reports_list`

**Назначение**: Таблица с пагинацией.

**Запрос**:
```json
{
  "action": "reports_list",
  "date_from": 1699000000,
  "date_to": 1699500000,
  "date_type": "created",
  "city_id": 1,
  "street_id": null,
  "home_id": null,
  "object_id": null,
  "details_text": "",
  "solution_text": "",
  "status": "all",
  "department_ids": ["22", "23"],
  "is_emergency": false,
  "staff_id": null,
  "page": 1,
  "limit": 50
}
```

**Ответ**:
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

**Алгоритм**:
1. Использовать тот же `WHERE`, что и в `reports_stats` (через `ReportsQueryBuilder`)
2. **Сортировка**: `ORDER BY call_id DESC` (фиксировано)
3. **Пагинация**: `LIMIT :limit OFFSET :offset`
4. **Счетчик**: отдельный `SELECT COUNT(*)` с тем же `WHERE` (для `total_items`)
5. Для каждого элемента в `items` — базовый JOIN с `lift_users` (до 3 сотрудников) и `lift_types`

**SQL для списка**:
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
ORDER BY c.call_id DESC
LIMIT :limit OFFSET :offset
```

**Ограничения безопасности**:
- `limit` жестко ограничен сервером: `min(50, max(10, limit))` → дефолт 50, максимум 100
- `page` должен быть ≥ 1

---

### 4.4. `action: reports_export`

**Назначение**: Скачивание PDF и XLSX.

**Запрос**:
```json
{
  "action": "reports_export",
  "format": "pdf",
  "date_from": 1699000000,
  "date_to": 1699500000,
  ... (те же фильтры, что в reports_list, без page/limit)
}
```

**Ответ**:
```json
{
  "status": "ok",
  "data": {
    "file_base64": "JVBERi0xLjQKJeLjz9MKN...",
    "filename": "report_2026-11-10.pdf",
    "mime_type": "application/pdf",
    "rows_count": 150
  }
}
```

**Алгоритм**:
1. Применить фильтры через `ReportsQueryBuilder`
2. **Жесткий лимит**: `LIMIT 500` на уровне SQL (игнорируем любые значения от клиента)
3. Сгенерировать массив данных
4. Передать в `ReportsExporter::renderPdf()` или `::renderXlsx()`
5. Закодировать результат в base64 и вернуть

**Rate limit**: 1 экспорт на пользователя в 30 секунд (через таблицу `export_rate_limits` или файловый флаг).

---

## 📄 5. Структура экспорта

### 5.1. Вариант Б (согласовано): одна строка на заявку с wrap text

**Колонки (слева направо)**:

| № | Заголовок | Содержимое (с переносами `\n`) |
|---|-----------|--------------------------------|
| 1 | ID | `123` |
| 2 | Адрес | `Москва, Ленина, д.1, л.101\n10.11.2026 15:30 · Иванов И.И.` |
| 3 | Описание | Полный текст `call_details` |
| 4 | Закрытие | `10.11.2026 18:00\nПетров П.П.` или `—` если открыта |
| 5 | Отв. 1 | `Иванов И.И.\nСтатус: Доставлено · 10.11.2026 15:35` |
| 6 | Отв. 2 | (если есть) по аналогии с колонкой 5 |
| 7 | Отв. 3 | (если есть) по аналогии с колонкой 5 |

### 5.2. Библиотеки
- **XLSX**: `phpoffice/phpspreadsheet` — wrap text, автовысота строк, автофильтр на заголовках, жирный шрифт для первой строки в многострочных ячейках
- **PDF**: `mpdf/mpdf` или `dompdf/dompdf` — рендер через HTML-шаблон таблицы

### 5.3. Маппинг `notify_status` (для экспорта)
```php
$statusMap = [
    0 => 'Не отправлено',
    1 => 'Отправлено',
    2 => 'Доставлено',
    3 => 'Прочитано',
];
```

### 5.4. Обработка пустой выборки
Если `LIMIT 500` вернул 0 строк → вернуть ответ:
```json
{
  "status": "ok",
  "data": null,
  "message": "По вашему запросу ничего не найдено"
}
```

---

## 🗂 6. Кэширование

### 6.1. Класс `ReportsCache`

```php
final class ReportsCache
{
    private string $cacheDir;
    
    public function __construct(string $cacheDir = '/tmp/reports_cache')
    {
        $this->cacheDir = $cacheDir;
        if (!is_dir($cacheDir)) mkdir($cacheDir, 0755, true);
    }
    
    public function get(string $key): ?array
    {
        $file = $this->cacheDir . '/' . $key . '.cache';
        
        // Приоритет: APCu → файл
        if (function_exists('apcu_fetch')) {
            $data = apcu_fetch($key);
            if ($data !== false) return $data;
        }
        
        if (file_exists($file) && filemtime($file) > time()) {
            return json_decode(file_get_contents($file), true);
        }
        return null;
    }
    
    public function set(string $key, array $data, int $ttl = 300): void
    {
        $file = $this->cacheDir . '/' . $key . '.cache';
        file_put_contents($file, json_encode($data, JSON_UNESCAPED_UNICODE));
        touch($file, time() + $ttl);
        
        if (function_exists('apcu_store')) {
            apcu_store($key, $data, $ttl);
        }
    }
    
    public function invalidateAll(): void
    {
        foreach (glob($this->cacheDir . '/*.cache') as $file) {
            unlink($file);
        }
        if (function_exists('apcu_clear_cache')) {
            apcu_clear_cache();
        }
    }
}
```

### 6.2. Точки инвалидации
В существующем `CallService` добавить вызов `ReportsCache::invalidateAll()` после:
- `callnew()` — создание заявки
- `callClose()` — закрытие заявки
- `calledit()` — редактирование (если изменился `call_department`, `call_staff*` или `call_status`)

### 6.3. Cron (ночная очистка)
```
0 3 * * * find /tmp/reports_cache -type f -name "*.cache" -mtime +1 -delete
```
Защита от накопления просроченных файлов.

---

## 🔧 7. Ключевые классы

### 7.1. `ReportsQueryBuilder`
```php
final class ReportsQueryBuilder
{
    public function __construct(private array $filters) {}
    
    public function buildWhere(): array  // возвращает [$sql, $params]
    public function buildCountSql(): string
    public function buildListSql(int $limit, int $offset): string
    public function buildStatsSql(): string
    public function buildGroupByDepartmentSql(): string
    public function buildGroupByCitySql(): string
}
```

### 7.2. `ReportsRepository`
```php
final class ReportsRepository
{
    public function getFiltersData(): array
    public function getStats(array $filters): array
    public function getList(array $filters, int $limit, int $offset): array
    public function getExportData(array $filters, int $limit = 500): array
    public function countTotal(array $filters): int
}
```

### 7.3. `ReportsService`
```php
final class ReportsService
{
    public function getFiltersData(): array
    public function getStats(array $filters): ?array  // null при невалидных датах
    public function getList(array $filters): array
    public function export(array $filters, string $format): ?array
}
```

### 7.4. `ReportsExporter`
```php
final class ReportsExporter
{
    public function renderXlsx(array $rows): string  // binary content
    public function renderPdf(array $rows): string   // binary content
}
```

---

## ⚠️ 8. Тонкости и edge cases

### 8.1. Валидация дат на сервере
```php
private function validateDates(int $from, int $to): bool
{
    $todayEnd = strtotime('today 23:59:59');
    return $from <= $to && $to <= $todayEnd && $from > 0;
}
```
Если невалидны → `getStats()`/`getList()` возвращают `null`, контроллер отдает `{"status":"ok", "data": null}`.

### 8.2. Поиск LIKE с минимальной длиной
```php
if (mb_strlen($text) >= 6) {
    $where[] = 'call_details LIKE :details';
    $params['details'] = '%' . $text . '%';
}
```
Короче 6 символов → фильтр игнорируется (защита от случайных коротких запросов и DoS).

### 8.3. Открытые заявки + фильтр по дате закрытия
Если пользователь выбрал `status: "open"` и `date_type: "closed"` → результат всегда будет пустым (у открытых `call_date2 = 0`). Сервер честно возвращает пустой список, без ошибок.

### 8.4. Поиск по ID — изолированная форма
Реализуется **на фронтенде** через `action: ticket` с `call_id`. Сервер не нуждается в отдельном endpoint. Если `ticket` вернет `data: null` — фронт показывает 404.

### 8.5. `avg_close_time_seconds` при отсутствии закрытых
Если за период нет ни одной закрытой заявки → возвращается `null` (не `0`, чтобы отличать от мгновенного закрытия).

### 8.6. Защита от пустого `department_ids`
Бизнес-правило на фронте: нельзя снять галочку с последнего отдела.
Серверная защита: если `department_ids` пришел пустым → использовать **все видимые** отделы (не возвращать ошибку, иначе API сломается от DevTools-запросов).

### 8.7. Конкурентность
Файловый кэш на shared-хостинге:
- Не использовать `file_put_contents` без `LOCK_EX`
- Использовать `flock` при записи (опционально, но желательно)

### 8.8. Идемпотентность экспорта
Один и тот же набор фильтров в течение TTL (5 мин) вернет кэшированный файл. Это ок — отчеты не критичны к real-time данным.

---

## 🧪 9. Чек-лист тестирования

### 9.1. Контрактные тесты
- [ ] `reports_filters_data` возвращает все 3 справочника
- [ ] `reports_stats` с пустыми фильтрами → агрегат по всем заявкам
- [ ] `reports_stats` с невалидными датами → `data: null`
- [ ] `reports_list` с `page=2, limit=10` → правильный `OFFSET 10`
- [ ] `reports_list` возвращает корректный `pagination.total_pages`
- [ ] `reports_export` с 501 строкой → возвращает ровно 500

### 9.2. Фильтры
- [ ] `date_type: "created"` vs `"closed"` работают отдельно
- [ ] `city_only: true` игнорирует street/home/object
- [ ] `department_ids` работает как включающий
- [ ] `details_text` < 6 символов игнорируется
- [ ] `is_emergency: true` дает только аварийные (type_report=0)

### 9.3. Кэш
- [ ] Повторный запрос в течение 5 мин отдает кэш (проверить `X-Cache: HIT` заголовок если добавите)
- [ ] После создания заявки кэш инвалидируется
- [ ] Cron удаляет файлы старше 1 дня

### 9.4. Экспорт
- [ ] PDF открывается в Adobe Reader, все колонки на месте
- [ ] XLSX открывается в Excel, wrap text работает, автофильтр активен
- [ ] Rate limit срабатывает (2-й запрос подряд → ошибка `rate_limit_exceeded`)
- [ ] Файлы > 5MB отдаются корректно (base64 не обрывается)

---

## 📊 10. Оценка реализации

| Блок | Часы |
|------|------|
| `ReportsQueryBuilder` | 3 |
| `ReportsRepository` | 4 |
| `ReportsService` + валидация | 2 |
| `ReportsCache` (файлы + APCu) | 2 |
| `ApiController::handle` (4 action'а) | 2 |
| `ReportsExporter::renderXlsx` | 3 |
| `ReportsExporter::renderPdf` | 4 |
| Инвалидация в `CallService` | 1 |
| Cron-скрипт | 0.5 |
| Тесты и отладка | 4 |
| **Итого** | **~25.5 часов** |

---

## 📌 11. Зависимости для composer.json

```json
{
  "require": {
    "phpoffice/phpspreadsheet": "^1.29",
    "mpdf/mpdf": "^8.2"
  }
}
```

---

## 🚀 12. Порядок реализации (рекомендуется)

1. **День 1**: `ReportsQueryBuilder` + `ReportsRepository` + тесты SQL на моках
2. **День 2**: `ReportsService` + `ApiController` (3 action'а без экспорта) + кэш
3. **День 3**: `ReportsExporter::renderXlsx` (проще)
4. **День 4**: `ReportsExporter::renderPdf` + интеграция
5. **День 5**: Инвалидация в `CallService` + cron + e2e тесты

---

## 📎 13. Связь с существующими компонентами

| Существующий компонент | Изменения |
|------------------------|-----------|
| `ApiController::handle()` | Добавить 4 новых action в `match` |
| `CallService::callnew()` | Добавить `ReportsCache::invalidateAll()` после `cacheService->invalidateTickets()` |
| `CallService::callClose()` | То же |
| `CallService::calledit()` | То же (при изменении значимых полей) |
| `UserRepository` | Добавить `findActiveByPosition()` для `reports_filters_data` |
| `lift_users` таблица | Уже имеет `user_position` — изменений не требует |

---

**Конец документа.** Готов к передаче в новый чат для пошаговой реализации. При переносе рекомендуется сохранить все markdown-заголовки и таблицу в разделе 4.2 (фильтры WHERE) — это самый критичный для воспроизведения блок.