# ADDRESS_ADMIN — модуль управления адресным пространством

Основной контракт: транспорт, маршруты, форматы запросов/ответов, алгоритмы.
ТЗ бэка — `md/техзадания/adreesbak.md`, ТЗ фронта — `md/техзадания/adressfront.md`.

> Имена файлов ТЗ взяты дословно из твоего сообщения (`adreesbak.md`, `adressfront.md`).
> Если это опечатка — скажи, поправлю до создания файлов.

## 0. Статус документа

| Раздел                                                                                                                      | Статус                                                                                       |
| --------------------------------------------------------------------------------------------------------------------------- | -------------------------------------------------------------------------------------------- |
| Схема БД, объёмы, опции тенанта                                                                                             | **ПОДТВЕРЖДЕНО** `information_schema` + `SELECT` (25.11.2026, тенант `zamotaev_demo_liftcs`) |
| Владелец ключей `App\Support\Address`                                                                                       | **ПОДТВЕРЖДЕНО** полным исходником                                                           |
| `AddressCacheService`, `AddressRepository`, `Bootstrap`, `View`, `Container`, `Router`, `layout.php`, `company/setting.php` | **ПОДТВЕРЖДЕНО** `cat` на сервере                                                            |
| Приём XML СПульт (`sp.php`)                                                                                                 | **ПОДТВЕРЖДЕНО** исходником из репозитория `main`                                            |
| Guard «только админ», CSRF, JSON-ошибки                                                                                     | **НЕ ПОДТВЕРЖДЕНО** — нужны `SessionAuth.php`, `Position.php`, `Csrf.php`                    |
| Поведение `CallService::validateAddress`                                                                                    | **НЕ ПОДТВЕРЖДЕНО** — нужно чтение `App/Service/CallService.php:722+`                        |
| Все сценарии модуля                                                                                                         | **НЕ ПРОГНАТО** — кода модуля не существует                                                  |

### Границы волны 1

Входит: дерево город→улица→дом→объект, перенос трёх уровней, каскад `vis`, «показать скрытые», детали узла по клику, Ctrl+клик мультивыбор, поиск, полный лог + cron.

Не входит (отдельные волны): инфо-поля объекта и тип оборудования, группы (32, N:N, каскадное назначение), XML-анализатор/импорт СПульт, усечённое редактирование в SPA, матрица прав.

Не входит и **не проектируется спекулятивно**: ручное создание/удаление/переименование узлов вне переноса. Переименование в волне 1 существует только как автонумерация при конфликте переноса.

---

## 1. Подтверждённые факты

### 1.1 Схема (фактическая, тенант `zamotaev_demo_liftcs`)

**lift_city**

| Колонка   | Тип          | Null | Ключ                           |
| --------- | ------------ | ---- | ------------------------------ |
| id        | int(11)      | NO   | PRI, auto_increment            |
| city_name | varchar(256) | NO   |                                |
| city_type | varchar(10)  | NO   |                                |
| vis       | tinyint(1)   | NO   |                                |
| city_key  | varchar(190) | YES  | `idx_city_key` (**не** UNIQUE) |

**lift_street**

| Колонка     | Тип          | Null | Ключ                                                  |
| ----------- | ------------ | ---- | ----------------------------------------------------- |
| id          | int(11)      | NO   | PRI                                                   |
| street_name | varchar(255) | NO   | `street_name`                                         |
| street_type | varchar(20)  | YES  |                                                       |
| street_key  | varchar(190) | YES  |                                                       |
| city_id     | int(11)      | NO   | `idx_city_id`                                         |
| timestamp   | timestamp    | NO   |                                                       |
| vis         | tinyint(1)   | NO   |                                                       |
| —           | —            | —    | `idx_street_key(city_id, street_key)` (**не** UNIQUE) |

**lift_home**

| Колонка    | Тип                  | Null    | Ключ                                                |
| ---------- | -------------------- | ------- | --------------------------------------------------- |
| id         | int(11)              | NO      | PRI                                                 |
| home_name  | **varchar(64)**      | **YES** |                                                     |
| street_id  | int(11)              | NO      | `street_id`                                         |
| timestamp  | timestamp            | NO      |                                                     |
| vis        | tinyint(1)           | NO      |                                                     |
| home_key   | varchar(190)         | YES     |                                                     |
| year_built | smallint(5) unsigned | YES     |                                                     |
| —          | —                    | —       | `idx_home_key(street_id, home_key)` (**не** UNIQUE) |

**lift_object**

| Колонка          | Тип          | Null | Ключ                                                  |
| ---------------- | ------------ | ---- | ----------------------------------------------------- |
| id               | int(11)      | NO   | PRI                                                   |
| object_name      | varchar(255) | NO   |                                                       |
| home_id          | int(11)      | NO   | `idx_home_id`                                         |
| group_id         | int(11)      | NO   | `idx_objects_group`                                   |
| timestamp        | timestamp    | NO   |                                                       |
| vis              | tinyint(1)   | NO   | `idx_vis`                                             |
| abbreviated_name | varchar(255) | NO   |                                                       |
| guid             | **char(32)** | YES  | **`uq_object_guid` UNIQUE**                           |
| spult_id         | varchar(32)  | YES  | `idx_object_spult_id`                                 |
| object_key       | varchar(190) | YES  |                                                       |
| —                | —            | —    | `idx_object_key(home_id, object_key)` (**не** UNIQUE) |

Следствия, обязательные к учёту:

1. **`home_name` — 64 символа.** Автонумерация « (2)」 добавляет 4 символа. Переполнение при `sql_mode` без STRICT = молчаливая обрезка. Проверка длины в PHP обязательна.
2. **`*_key` — 190 символов**, а имена до 255/256. `token()` снимает пробелы и точки, но не сокращает буквы: имя из 255 букв даёт ключ длиннее 190 → обрезка. Проверка длины ключа в PHP обязательна.
3. **`home_name` NULLABLE**, `*_key` NULLABLE. Пустое имя дома допустимо схемой, но недопустимо модулем.
4. **`guid` — char(32), UNIQUE.** Единственная существующая защита от дублей во всём адресном слое.
5. `timestamp` есть у street/home/object, у city — нет. Для optimistic locking непригоден как единый механизм (см. §8.2).

### 1.2 Объёмы и распределение

| Таблица     | Всего | Максимум детей на родителя |
| ----------- | ----- | -------------------------- |
| lift_city   | 6     | 308 улиц (city_id=1)       |
| lift_street | 366   | 93 дома (street_id=202)    |
| lift_home   | 2645  | 29 объектов (home_id=641)  |
| lift_object | 7151  | —                          |

- `vis = 1` у **всех** записей всех четырёх уровней. Скрытых нет.
- `guid` непустой у **3** объектов из 7151.
- `group_id = 1` у **всех** 7151 объекта.

Следствия: ленивая загрузка по уровням обязательна, но один уровень целиком (≤308 узлов) помещается в ответ без пагинации. Сортировка в PHP на объёме уровня допустима.

### 1.3 Опции тенанта (`lift_options`)

| option_name             | Значение            | Что это значит                                      |
| ----------------------- | ------------------- | --------------------------------------------------- |
| city_default            | `г. Ростов-на-Дону` | город для сигналов СПульт по умолчанию              |
| city_separator          | `#`                 | разделитель «улица#город» в `STREET@Name`           |
| XML_add                 | `1`                 | **СПульт имеет право создавать записи справочника** |
| spult_organization_name | пусто               | проверка имени организации пропускается             |
| spult_verify_pult_guid  | `1`                 | проверка включена…                                  |
| spult_pult_guid         | пусто               | …но список пуст → проверка пропускается с логом     |

**Вывод: модуль — не единственный писатель адресного справочника.** Конкурент-писатель (`sp.php`) активен и создаёт записи. Это главный довод за UNIQUE-индексы (§3).

---

## 2. Владельцы логики: зовём, не копируем

| Что                            | Владелец                                                          | Правило для модуля                                               |
| ------------------------------ | ----------------------------------------------------------------- | ---------------------------------------------------------------- |
| Ключ города                    | `App\Support\Address::plainKey()`                                 | только вызов                                                     |
| Ключ улицы (тип входит в ключ) | `Address::streetKey()`                                            | только вызов                                                     |
| Ключ дома                      | `Address::homeKey()`                                              | только вызов                                                     |
| Ключ объекта                   | `Address::plainKey()`                                             | только вызов                                                     |
| Разбор типа/маркера            | `Address::parseCity/parseStreet/parseHome`                        | только вызов                                                     |
| Ключ сортировки                | `Address::sortKey()`                                              | только вызов, паритет с `frontend/js/utils/address-flattener.js` |
| Display-подпись                | `Address::formatDisplay()` / `formatCity/formatStreet/formatHome` | только вызов                                                     |
| Версия адресного слоя          | `App\Service\AddressCacheService::invalidateCache()`              | вызов после **каждой** успешной записи                           |
| Резолв адреса цепочкой         | `App\Repository\CallRepository::resolveAddress()`                 | не дублировать JOIN                                              |
| Формат GUID                    | `App\Repository\CallRepository::normalizeGuid()`                  | не трогать GUID в волне 1                                        |
| Сессия/доступ                  | `Company\Admin\Services\SessionAuth`                              | переиспользование                                                |

Запрещено: свой форматтер адреса, своя нормализация ключей, свой инкремент `lift_dict_versions`, своя сборка `fullAddress`.

**Известный дефект трека А (подтверждён `cat`):** `App\Repository\AddressRepository::createCity/createStreet/createHome/createObject` **не пишут `*_key`** и не зовут `Address::parse*`; `createObject` кладёт `$spultId` в `abbreviated_name`, тогда как `sp.php` пишет `spult_id` в `spult_id`. Это второй путь записи, создающий записи с пустыми ключами. Модуль **не использует** эти методы и не становится третьим путём. Фиксируется как техдолг (§12).

---

## 3. Блокирующие шаги до первого файла модуля

### Шаг 1. Долг №1 — `App\Database\DB.php`, сохранить `previous`

Подтверждено: 5 блоков `catch (PDOException $e)` (строки 33, 61, 78, 94, 110), ни одного `, 0, $e`. `DbException` теряeт причину.

Подтверждено также: `DbUserRepository.php:200` уже читает `$e->getPrevious()`. То есть **перевод 1062 в «Логин уже занят» уже написан, но мёртв** — `getPrevious()` всегда `null`. Закрытие долга №1 оживляет его без правок контроллера.

Без этого шага UNIQUE-индексы дадут 500 «Сервис временно недоступен» вместо разборного конфликта.

### Шаг 2. Преflight-проверки перед UNIQUE (обязательны, до ALTER)

Ключи NULLABLE и часть строк могла быть создана без ключей. UNIQUE допускает много `NULL`, но только **одну** пустую строку `''`.

```sql
-- 1. Сколько строк без ключа (NULL и пустая строка отдельно)
SELECT 'city'   AS lvl, SUM(city_key   IS NULL) AS null_key, SUM(city_key   = '') AS empty_key FROM lift_city
UNION ALL SELECT 'street', SUM(street_key IS NULL), SUM(street_key = '') FROM lift_street
UNION ALL SELECT 'home',   SUM(home_key   IS NULL), SUM(home_key   = '') FROM lift_home
UNION ALL SELECT 'object', SUM(object_key IS NULL), SUM(object_key = '') FROM lift_object;

-- 2. Существующие дубли ключей в области видимости родителя
SELECT city_key, COUNT(*) c FROM lift_city
 WHERE city_key IS NOT NULL AND city_key <> '' GROUP BY city_key HAVING c > 1;

SELECT city_id, street_key, COUNT(*) c FROM lift_street
 WHERE street_key IS NOT NULL AND street_key <> '' GROUP BY city_id, street_key HAVING c > 1;

SELECT street_id, home_key, COUNT(*) c FROM lift_home
 WHERE home_key IS NOT NULL AND home_key <> '' GROUP BY street_id, home_key HAVING c > 1;

SELECT home_id, object_key, COUNT(*) c FROM lift_object
 WHERE object_key IS NOT NULL AND object_key <> '' GROUP BY home_id, object_key HAVING c > 1;

-- 3. Приблизительная длина ключа (LOWER в SQL ≠ mb_strtolower, оценка грубая;
--    точная проверка — в PHP через Address::*Key)
SELECT 'street' lvl, MAX(CHAR_LENGTH(REPLACE(REPLACE(LOWER(street_name),' ',''),'.',''))) approx
  FROM lift_street
UNION ALL SELECT 'object', MAX(CHAR_LENGTH(REPLACE(REPLACE(LOWER(object_name),' ',''),'.',''))) FROM lift_object
UNION ALL SELECT 'home',   MAX(CHAR_LENGTH(REPLACE(REPLACE(LOWER(home_name),' ',''),'.','')))   FROM lift_home;

-- 4. Пустые/NULL имена домов (колонка NULLABLE)
SELECT COUNT(*) FROM lift_home WHERE home_name IS NULL OR TRIM(home_name) = '';

-- 5. DEFAULT у abbreviated_name (sp.php утверждает, что он есть — подтвердить)
SHOW COLUMNS FROM lift_object LIKE 'abbreviated_name';
```

**Правило: ALTER не выполняется, пока любой из запросов 1–4 даёт ненулевой результат.** Сначала бэкфилл ключей и разбор дублей — отдельным решением, с логом.

### Шаг 3. UNIQUE-индексы (решение «А», принято)

Только после шага 2 и бэкфилла:

```sql
ALTER TABLE lift_city   ADD UNIQUE uniq_city_key   (city_key);
ALTER TABLE lift_street ADD UNIQUE uniq_street_key (city_id, street_key);
ALTER TABLE lift_home   ADD UNIQUE uniq_home_key   (street_id, home_key);
ALTER TABLE lift_object ADD UNIQUE uniq_object_key (home_id, object_key);
```

После подтверждения `SHOW INDEX` — удалить избыточные неуникальные индексы, полностью покрытые новыми UNIQUE (прецедент: миграция 1.7, `idx_user_login`):

```sql
-- выполнять по одному, после сверки SHOW INDEX
ALTER TABLE lift_city   DROP INDEX idx_city_key;
ALTER TABLE lift_street DROP INDEX idx_street_key;
ALTER TABLE lift_home   DROP INDEX idx_home_key;
ALTER TABLE lift_object DROP INDEX idx_object_key;
```

`idx_city_id`, `street_id`, `idx_home_id`, `idx_vis`, `idx_objects_group`, `idx_object_spult_id`, `street_name` — **не трогать**: они не покрыты новыми ключами полностью либо используются другими запросами.

Миграции между тенантами не нужны: в прод уходит структура одной базы (решение владельца).

---

## 4. Точка входа, переиспользование, принятые решения

| №   | Решение                                                                                                          |
| --- | ---------------------------------------------------------------------------------------------------------------- |
| 1   | `View` параметризуется корнем вьюх (правка `company/admin/Support/View.php`, дефолт сохраняет текущее поведение) |
| 2   | В `View` добавляется JSON-ответ (`json()`), доступный обоим модулям                                              |
| 3   | `Csrf::check()` читает токен и из `$_POST['_csrf']`, и из заголовка `X-CSRF-Token`                               |
| 4   | Автозагрузчик — **общий** для обеих панелей                                                                      |
| 5   | Guard «только админ» — **централизованно**, в общем слое авторизации, а не в каждом модуле                       |
| 6   | У модуля свой `layout.php` (своя навигация, свои ассеты)                                                         |
| 7   | Один файл маршрутов `Config/routes.php`                                                                          |
| 8   | Таблица лога — `lift_address_changes_log` (префикс `lift_` по конвенции)                                         |

### 4.1 Размещение

```
company/address.php                  ← entry, define('APP_ENTRY_POINT', true)
company/autoload.php                 ← общий автозагрузчик панелей (placement на подтверждение)
company/address-admin/
├── Config/
│   ├── routes.php
│   └── flags.php
├── Controllers/
│   ├── BaseController.php          extends Company\Admin\Controllers\BaseController
│   ├── TreeController.php          страница дерева + поиск (кросс-сущностный)
│   ├── CityController.php
│   ├── StreetController.php
│   ├── HomeController.php
│   ├── ObjectController.php
│   └── LogController.php
├── Repositories/
│   ├── Contracts/
│   │   ├── CityRepositoryInterface.php
│   │   ├── StreetRepositoryInterface.php
│   │   ├── HomeRepositoryInterface.php
│   │   ├── ObjectRepositoryInterface.php
│   │   └── AddressLogRepositoryInterface.php
│   └── Db/
│       ├── DbCityRepository.php
│       ├── DbStreetRepository.php
│       ├── DbHomeRepository.php
│       ├── DbObjectRepository.php
│       └── DbAddressLogRepository.php
├── Services/
│   ├── MoveService.php
│   └── VisibilityService.php
├── Support/
│   ├── Bootstrap.php
│   ├── AddressTree.php             порядок/подписи/пути над строками, без SQL
│   └── Actor.php                   кто/откуда для лога
├── Views/
│   ├── layout.php
│   ├── tree.php
│   └── log.php
└── assets/
    ├── css/address.css
    └── js/*.js                     ES-модули, без сборки, без CDN
```

Namespace: `Company\AddressAdmin\`.

Принципы разбивки:

- **тип узла несёт маршрут** (`city.*`, `street.*`, `home.*`, `object.*`). Отдельный белый список типов и enum-диспетчер не вводятся: Router и так работает ключом `page.action`, а имя метода из строки не выводится;
- **одна таблица — один репозиторий** (прецедент раздела Users: `UserRepositoryInterface` + `DbUserRepository`);
- **кросс-сущностные операции — в `Services`**: перенос дома тянет объекты, каскад улицы тянет дома и объекты. Владелец транзакции — сервис, не контроллер;
- `Support\AddressTree` — владелец порядка и подписей: сортировка через `Address::sortKey`, подписи через `Address::format*`, пути через `formatDisplay`. SQL внутри запрещён.

### 4.2 Общий автозагрузчик — placement требует подтверждения

Сейчас `company/setting.php` регистрирует автозагрузчик только для `Company\Admin\` и требует `../bootstrap.php`.

Корневой `bootstrap.php` — общий файл трека А: его подключают `api.php`, `auth.php`, `sp.php`. Регистрация панельных автозагрузчиков там затянет классы панелей в каждый API-запрос.

**Предложение:** общий файл `company/autoload.php`, регистрирующий оба префикса (`Company\Admin\` → `company/admin/`, `Company\AddressAdmin\` → `company/address-admin/`), подключается из обеих точек входа. Корневой `bootstrap.php` не меняется.

Это уточнение решения 4 («общий») — прошу подтвердить placement до кода.

### 4.3 Guard доступа

По твоему ответу: в панель вообще пускает только админ, и это правило действует везде. Значит проверка живёт в одном месте — в общем слое авторизации (`SessionAuth`), а `Bootstrap` адресного модуля её не дублирует.

**НЕ ПОДТВЕРЖДЕНО:** где именно сейчас стоит проверка (`SessionAuth::check()` или контроллеры) и как используется `Position::grantsPanelAccess()`. Нужны `company/admin/Services/SessionAuth.php` и `company/admin/Support/Position.php`. До их чтения раздел считается проектом, а не фактом.

### 4.4 Ассеты

Вендоренный CSS уже лежит в `company/admin/assets/adminlte/css/adminlte.min.css`. От `company/address.php` тот же относительный путь `admin/assets/adminlte/css/adminlte.min.css` разрешается корректно — **дублировать CSS не нужно**.

Открытый долг вне волны: `bootstrap-icons` в обоих layout и `auth/login.php` тянутся с jsdelivr.

### 4.5 JS в модуле — осознанное отступление от правила панели

Правило «AdminLTE без `<script>`» действовало потому, что в разметке не было push-menu/treeview/dropdown. **Триггер наступил: модуль — это treeview + контекстное меню + диалоги.** Поэтому layout модуля подключает локальные ES-модули. Сборка не используется (см. ТЗ фронта).

---

## 5. Транспорт

### 5.1 Адресация

Единая точка входа `company/address.php`, маршрутизация как в панели: `?page=<page>&action=<action>`. Router ищет ключ `"page.action"` в карте; имя метода из строки **не выводится**.

### 5.2 Конверт ответа

Успех:

```json
{ "ok": true, "data": {} }
```

Ошибка:

```json
{
  "ok": false,
  "error": {
    "code": "duplicate_conflict",
    "message": "текст для админа",
    "details": {}
  }
}
```

HTTP-коды: 200 успех; 403 доступ/CSRF; 404 узел или маршрут не найден; 409 конфликт ключа; 422 валидация; 500 внутренняя ошибка.

Коды ошибок (закрытый словарь): `forbidden`, `csrf_failed`, `not_found`, `validation_failed`, `too_long`, `same_parent`, `duplicate_conflict`, `tenant_not_resolved`, `internal_error`.

### 5.3 CSRF

Все изменяющие запросы — POST. Токен в заголовке `X-CSRF-Token` (решение 3). GET-маршруты (`*.preview`, `tree.*`, `node.details`, `log.list`) токена не требуют, так как ничего не меняют.

### 5.4 Ошибки в JSON-виде — обязательное требование к Bootstrap модуля

Текущий `Company\Admin\Support\Bootstrap` в `catch (\Throwable)` отдаёт **текст** `Сервис временно недоступен` с кодом 500, а при отказе тенанта — текст `Tenant not resolved` с 404. Для AJAX это нераспарсиваемый ответ: фронт покажет «сбой сети» вместо причины.

**Требование:** `Bootstrap` адресного модуля определяет ожидаемый формат (заголовок `Accept: application/json` либо признак JSON-маршрута) и в случае ошибки отдаёт конверт §5.2. Диагностика в лог остаётся как в панели: класс, message, файл:строка, page/action.

То же касается отказа CSRF: нужен JSON-ответ 403, а не текстовый обрыв. **НЕ ПОДТВЕРЖДЕНО:** как `Csrf::check()` завершается сейчас — нужен исходник.

### 5.5 Логи

Канал диагностики модуля: `CompanyAddress: request failed` (аналог `CompanyAdmin: request failed`), с полями class/msg/at/page/action. Секреты в адресных таблицах отсутствуют, но `Logger::db` логирует все параметры запроса — долг маскировки остаётся открытым и на модуль тоже распространяется.

---

## 6. Маршруты

Тип узла задаётся ключом маршрута. Параметра `type` в запросах нет.

| Ключ `page.action`   | Метод | Формат | Назначение                                 |
| -------------------- | ----- | ------ | ------------------------------------------ |
| `tree.index`         | GET   | HTML   | страница дерева                            |
| `tree.search`        | GET   | JSON   | поиск по 4 уровням, с `path` для раскрытия |
| `city.list`          | GET   | JSON   | корневой уровень + счётчики детей          |
| `city.children`      | GET   | JSON   | улицы города                               |
| `city.details`       | GET   | JSON   | детали города                              |
| `city.visPreview`    | GET   | JSON   | сколько узлов затронет каскад городу       |
| `city.vis`           | POST  | JSON   | каскад `vis` городу                        |
| `street.children`    | GET   | JSON   | дома улицы                                 |
| `street.details`     | GET   | JSON   | детали улицы                               |
| `street.movePreview` | GET   | JSON   | предпросмотр переноса улиц в город         |
| `street.move`        | POST  | JSON   | перенос улиц в город                       |
| `street.visPreview`  | GET   | JSON   | сколько узлов затронет каскад улице        |
| `street.vis`         | POST  | JSON   | каскад `vis` улице                         |
| `home.children`      | GET   | JSON   | объекты дома                               |
| `home.details`       | GET   | JSON   | детали дома                                |
| `home.movePreview`   | GET   | JSON   | предпросмотр переноса домов в улицу        |
| `home.move`          | POST  | JSON   | перенос домов в улицу                      |
| `home.visPreview`    | GET   | JSON   | сколько узлов затронет каскад дому         |
| `home.vis`           | POST  | JSON   | каскад `vis` дому                          |
| `object.details`     | GET   | JSON   | детали объекта                             |
| `object.movePreview` | GET   | JSON   | предпросмотр переноса объектов в дом       |
| `object.move`        | POST  | JSON   | перенос объектов в дом                     |
| `log.index`          | GET   | HTML   | страница журнала                           |
| `log.list`           | GET   | JSON   | журнал с фильтрами и пагинацией            |

Целевой родитель фиксирован маршрутом: `object.move` → дом, `home.move` → улица, `street.move` → город. Перенос города не предусмотрен: город — корень.

Всё, чего нет в карте, — 404 (поведение Router). Никаких маршрутов «на будущее».

---

## 7. Контракты

Общие правила:

- **тип узла задаётся маршрутом**, параметр `type` в запросах отсутствует. Значение типа из ввода не читается и в SQL не попадает: имя таблицы и колонки знает репозиторий сущности.
- поле `type` в элементах ответа остаётся как **данные** (нужно фронту для отрисовки и логу), а не как селектор SQL;
- `id`, `target_id`, элементы `ids` — приведение к `int`, `> 0`, дедупликация `ids`;
- `show_hidden` — `(bool)`, влияет только на выборку;
- все ответы содержат `vis` каждого узла, чтобы фронт мог рисовать скрытые при включённом флаге.

### 7.1 `city.list`

Запрос: `show_hidden=0|1`.

Ответ `data`:

```json
{
  "show_hidden": false,
  "version": 12,
  "items": [
    {
      "id": 1,
      "type": "city",
      "name": "Ростов-на-Дону",
      "city_type": "г",
      "display": "г. Ростов-на-Дону",
      "key": "ростов-на-дону",
      "vis": 1,
      "children_count": 308,
      "has_children": true
    }
  ]
}
```

`version` — текущая версия слоя `addresses` из `lift_dict_versions`. Нужна фронту, чтобы понимать, что дерево устарело после чужой правки.

### 7.2 `city.children` / `street.children` / `home.children`

Запрос: `id`, `show_hidden=0|1`. Тип родителя задан маршрутом.

Ответ `data` (пример `city.children`):

```json
{
  "parent": {
    "type": "city",
    "id": 1,
    "display": "г. Ростов-на-Дону",
    "vis": 1
  },
  "child_type": "street",
  "version": 12,
  "items": [
    {
      "id": 202,
      "type": "street",
      "name": "Ленина",
      "street_type": "ул",
      "display": "ул. Ленина",
      "key": "ул|ленина",
      "vis": 1,
      "children_count": 93,
      "has_children": true
    }
  ]
}
```

Соответствие маршрута и дочернего уровня:

| Маршрут           | `child_type` | Поля элементов                                                                        |
| ----------------- | ------------ | ------------------------------------------------------------------------------------- |
| `city.children`   | `street`     | id, type, name, street_type, display, key, vis, children_count, has_children          |
| `street.children` | `home`       | id, type, name, display, key, vis, children_count, has_children                       |
| `home.children`   | `object`     | id, type, name, display, key, vis, guid_present, has_children=false, children_count=0 |

`guid_present` —布尔 признак непустого `guid`: нужен фронту для предупреждения о `guid_mismatch` при переносе с переименованием. Сам `guid` в списке не отдаётся, он приходит в `object.details`.

Счётчики детей считаются **с учётом `show_hidden`**: при выключенном флаге скрытые дети не увеличивают счётчик, иначе фронт покажет «есть дети» и получит пустой список.

### 7.3 `tree.search`

Запрос: `q` (минимум 2 символа после нормализации), `show_hidden`, `limit` (по умолчанию 50, максимум 200).

Ответ `data`:

```json
{
  "q": "ленина",
  "items": [
    {
      "type": "object",
      "id": 6411,
      "display": "п.1 пасс.",
      "path": {
        "city_id": 1,
        "street_id": 202,
        "home_id": 641,
        "object_id": 6411
      },
      "path_display": "г. Ростов-на-Дону, ул. Ленина, д. 20/1, п.1 пасс.",
      "vis": 1
    }
  ],
  "truncated": false
}
```

`path` обязателен: без него фронт не может раскрыть дерево до найденного узла.

### 7.4 `city.details` / `street.details` / `home.details` / `object.details`

Запрос: `id`. Тип узла задан маршрутом.

Ответ `data` — по маршруту:

| Маршрут          | Поля                                                                                                                    |
| ---------------- | ----------------------------------------------------------------------------------------------------------------------- |
| `city.details`   | id, city_name, city_type, city_key, vis, display, counts{streets,homes,objects}                                         |
| `street.details` | id, street_name, street_type, street_key, city_id, vis, timestamp, display, path_display, counts{homes,objects}         |
| `home.details`   | id, home_name, home_key, street_id, vis, year_built, timestamp, display, path_display, counts{objects}                  |
| `object.details` | id, object_name, object_key, home_id, group_id, guid, spult_id, abbreviated_name, vis, timestamp, display, path_display |

`guid` и `spult_id` — только чтение в волне 1. Инфо-поля оборудования (тип, бренд, модель, даты) **не входят**: колонок нет, спекулятивно не добавляем.

### 7.5 `object.movePreview` / `home.movePreview` / `street.movePreview`

Запрос: `ids[]`, `target_id`. Тип переносимого узла и тип цели заданы маршрутом: `object` → дом, `home` → улица, `street` → город.

Поле `type` в ответе — эхо маршрута (данные для фронта), не входной параметр.

Ответ `data`:

```json
{
  "type": "object",
  "target": {
    "type": "home",
    "id": 988,
    "display": "д. 15",
    "path_display": "…",
    "vis": 1
  },
  "items": [
    {
      "id": 6411,
      "name": "п.1 пасс.",
      "key": "п1пасс",
      "current_parent_id": 641,
      "conflict": true,
      "existing_id": 7002,
      "proposed_name": "п.1 пасс. (2)",
      "proposed_key": "п1пасс(2)",
      "too_long": false
    }
  ],
  "totals": { "count": 3, "conflicts": 1, "too_long": 0, "same_parent": 0 },
  "target_hidden": false
}
```

`too_long=true` — перенос с автонумерацией не пройдёт валидацию длины (`home_name` 64, `*_name` 255, `*_key` 190). Фронт обязан заблокировать подтверждение, а не давать серверу обрезать строку.

### 7.6 `object.move` / `home.move` / `street.move`

POST, `X-CSRF-Token`. Тело (пример `object.move`):

```json
{ "ids": [6411, 6412], "target_id": 988, "on_duplicate": "rename" }
```

`on_duplicate` ∈ `abort | rename`. `abort` — при любом конфликте отказ 409 без частичного применения.

Ответ `data`:

```json
{
  "moved": [
    {
      "id": 6411,
      "old_parent_id": 641,
      "new_parent_id": 988,
      "old_name": "п.1 пасс.",
      "new_name": "п.1 пасс. (2)",
      "old_key": "п1пасс",
      "new_key": "п1пасс(2)"
    }
  ],
  "renamed_count": 1,
  "version": 13,
  "log_id": 4521
}
```

Ошибка 409 `duplicate_conflict`, `details.items` — тот же формат, что в preview.

### 7.7 `city.visPreview` / `street.visPreview` / `home.visPreview`

Запрос: `id`, `vis` (`0|1`). Уровень каскада задан маршрутом.

Ответ `data`:

```json
{
  "node": { "type": "street", "id": 202, "display": "ул. Ленина", "vis": 1 },
  "target_vis": 0,
  "matched": { "streets": 1, "homes": 93, "objects": 412 },
  "already_in_state": { "streets": 0, "homes": 0, "objects": 0 }
}
```

`matched` — сколько узлов входит в поддерево; `already_in_state` — сколько уже в целевом состоянии. Разделение обязательно: `DB::execute()` вернёт **изменённые** строки (`MYSQL_ATTR_FOUND_ROWS = false`), и без этого разделения UI соврёт «изменено 0» на успешной операции.

### 7.8 `city.vis` / `street.vis` / `home.vis`

POST, `X-CSRF-Token`, тело `{ "id": 202, "vis": 0 }`. Уровень каскада задан маршрутом.

Ответ `data`:

```json
{
  "changed": { "streets": 1, "homes": 93, "objects": 412 },
  "matched": { "streets": 1, "homes": 93, "objects": 412 },
  "version": 14,
  "log_id": 4522
}
```

### 7.9 `log.list`

Запрос: `entity_type`, `entity_id`, `actor_id`, `action`, `from`, `to`, `page`, `per_page` (≤100).

Ответ `data`: `{ total, page, per_page, items:[ … ] }`, поля записи — §10.

---

## 8. Алгоритмы

### 8.1 Ключи и области видимости

| Уровень | Ключ                                            | Область уникальности |
| ------- | ----------------------------------------------- | -------------------- |
| город   | `Address::plainKey(city_name)`                  | тенант               |
| улица   | `Address::streetKey(raw)` = `type\|token(name)` | город                |
| дом     | `Address::homeKey(raw)`                         | улица                |
| объект  | `Address::plainKey(object_name)`                | дом                  |

Ключ **не включает** id родителя. Поэтому при переносе без переименования ключ не меняется — меняется только область, в которой он должен быть уникален. Отсюда: проверка конфликта выполняется **в целевом родителе**, по тому же ключу.

Тип улицы входит в ключ: «Ленина ул.» и «Ленина пр-кт» — разные улицы. Перенос улицы в город, где есть одноимённая улица **другого типа**, конфликтом не является.

### 8.2 Перенос

Шаги (все внутри одной транзакции):

1. Валидация: `ids` непустой, все `int > 0`, дедупликация; `target_id > 0`; `on_duplicate` из белого списка. Тип переносимого узла пришёл маршрутом и в валидации не нуждается — селектора типа в запросе нет.
2. Проверить существование целевого родителя через репозиторий **того уровня, который закреплён за маршрутом**: `object.move` → `HomeRepository`, `home.move` → `StreetRepository`, `street.move` → `CityRepository`. Отсутствие → `not_found`. Проверки «а тот ли это тип» не требуется: тип цели определяется маршрутом, а не вводом.
3. Проверить существование каждого переносимого узла. Отсутствие → `not_found`, вся операция откатывается.
4. `SELECT … FOR UPDATE` строки целевого родителя — сериализация параллельных переносов в одну цель. Оптимистичная блокировка по `timestamp` не используется: у `lift_city` колонки нет, единого механизма не получится.
5. Прочитать **всех** существующих детей цели, включая `vis = 0`, собрать множество занятых ключей.
6. Для каждого переносимого узла по порядку:
   - ключ не изменился и не занят → перенос без переименования;
   - ключ занят и `on_duplicate = abort` → 409, откат;
   - ключ занят и `on_duplicate = rename` → автонумерация (§8.3), проверка длин (§8.4), добавление нового ключа в множество занятых (защита от коллизии внутри самой пачки);
   - `current_parent_id == target_id` → узел пропускается, попадает в `totals.same_parent`, не считается ошибкой.
7. `UPDATE` родителя у узла (и `*_name`, `*_key`, если было переименование). Дети переезжают автоматически: FK указывает на непосредственного родителя, глубже ничего менять не нужно.
8. Запись в `lift_address_changes_log` (§10).
9. `AddressCacheService::invalidateCache()` **в той же транзакции** — откат операции откатит и версию; после коммита версия гарантированно соответствует данным.
10. Коммит, ответ §7.6.

**Проверка цикла не нужна.** Иерархия строго четырёхуровневая, тип родителя фиксирован: город — корень, у дома нет дочерних улиц, у объекта нет дочерних домов. Перенести узел в собственного потомка структурно невозможно. (Уточнение к моему более раннему сообщению: BFS-проверка цикла была предложена ошибочно.)

**Перенос в скрытого родителя — правило требует подтверждения.** Предлагаю: перенос наследует `vis` целевого родителя (скрытая цель → перенесённое поддерево скрывается каскадом), в preview выставляется `target_hidden = true` и фронт показывает предупреждение. Причина: иначе появляется видимый объект под скрытым домом, а SPA-словарь такие узлы не показывает — диспетчер не увидит объект, по которому продолжают приходить заявки.

### 8.3 Автонумерация при конфликте

Формат: `{исходное имя} ({n})`, `n` начинается с 2.

1. `candidate = name . ' (' . n . ')'`.
2. Ключ считается **тем же** методом уровня (`plainKey` / `homeKey` / `streetKey`), не вручную.
3. Если ключ занят среди детей цели (включая скрытых и уже обработанных в этой пачке) — `n++`, повтор.
4. Ограничение попыток (например 1000) с явной ошибкой вместо вечного цикла.
5. Проверка длин (§8.4) для каждого кандидата.

Существующее имя **не нормализуется**: «п.1 пасс.» — целиком идентичность объекта, `Address::plain()` снимает только пробелы. Маркеры и типы не переписываются.

Для улицы суффикс добавляется к **имени**, а не к типу: `Ленина (2)` + `street_type = ул`, ключ `ул|ленина(2)`.

### 8.4 Валидация длин — единственная защита

`sql_mode` без STRICT: MySQL молча обрежет строку. Проверять в PHP до записи:

| Поле          | Лимит   |
| ------------- | ------- |
| city_name     | 256     |
| street_name   | 255     |
| home_name     | **64**  |
| object_name   | 255     |
| city_type     | 10      |
| street_type   | 20      |
| любой `*_key` | **190** |

Длина считается в символах (`mb_strlen`, UTF-8), не в байтах. Превышение → `too_long` (422) с указанием поля и лимита, без записи.

### 8.5 Каскад `vis`

Симметричный (принято): скрытие узла гасит всё поддерево, показ — восстанавливает всё поддерево. Индивидуальная скрытость детей при показе родителя теряется — это осознанная цена простоты, компенсируется полным логом.

Порядок: сначала узел, затем уровни сверху вниз.

- **city**: `lift_city` по id → `lift_street` по `city_id` → `lift_home` JOIN `lift_street` по `city_id` → `lift_object` JOIN `lift_home` JOIN `lift_street` по `city_id`.
- **street**: `lift_street` по id → `lift_home` по `street_id` → `lift_object` JOIN `lift_home` по `street_id`.
- **home**: `lift_home` по id → `lift_object` по `home_id`.

Один `UPDATE` на уровень, всё в одной транзакции. **Батчи не нужны** на подтверждённых объёмах (максимум 7151 объект во всём тенанте). Уточнение к моему более раннему сообщению: батчи по 200 предлагались без данных и здесь избыточны. Порог пересмотра — десятки тысяч узлов в одном поддереве.

Счётчики: `matched` считается `SELECT COUNT(*)` до изменения, `changed` берётся из `rowCount`. Ноль в `changed` **не** означает failure: узлы могли уже быть в целевом состоянии. Существование узла проверяется `findById` до вызова.

Затем лог и `invalidateCache()` в той же транзакции.

**Каскад вверх не делается:** показ дома не показывает скрытую улицу. Иначе один клик по листу менял бы видимость половины города.

### 8.6 Сортировка

Единственный источник порядка — `Address::sortKey(city, street, home, object, streetType)`. Вызовы по уровням (имена родителей берутся один раз на запрос):

| Уровень списка | Вызов                                                             |
| -------------- | ----------------------------------------------------------------- |
| города         | `sortKey(cityName, '', '', '')`                                   |
| улицы города   | `sortKey(cityName, streetName, '', '', streetType)`               |
| дома улицы     | `sortKey(cityName, streetName, homeName, '', streetType)`         |
| объекты дома   | `sortKey(cityName, streetName, homeName, objectName, streetType)` |

Тип улицы передаётся из справочника обязательно: без него `sortKey` разбирает имя и «23-я линия» теряет «линию» — порядок разойдётся с клиентским ключом пикера (`frontend/js/utils/address-flattener.js:69–97`).

Сравнение — побайтовое по ключу. `ё/е` не сворачиваются (правило `Address`). Компаратор на клиенте уточняется в ТЗ фронта.

### 8.7 Поиск

1. Строка запроса нормализуется тем же способом, что и ключи: `Address::plainKey(q)` (регистр, пробелы, точки).
2. Поиск `LIKE '%needle%'` по `*_key` четырёх уровней. Для улицы ключ содержит тип (`ул|ленина`), поэтому вхождение по имени находится независимо от типа.
3. `show_hidden` фильтрует каждый уровень.
4. Лимит на уровень, общий `truncated` в ответе.
5. Для каждого результата собирается `path` из id родителей (для объекта — цепочка home → street → city) и `path_display` через `Address::formatDisplay`.

Нечёткого сравнения нет сознательно (правило `Address`: «2к2» ≠ «2 корп.2»).

### 8.8 Ленивая загрузка

Фронт грузит только раскрытые уровни. Полное дерево в память не тянется: 7151 объект — это мегабайты JSON и лишний трафик на каждый клик. Детали узла — отдельным запросом по клику, без кэширования в памяти (принято).

`version` в каждом ответе дерева позволяет фронту заметить, что справочник изменили из другого окна или из СПульт, и перечитать раскрытые уровни.

---

## 9. Инварианты и ловушки

1. `DB::execute()` = изменённые строки, не подошедшие. Ноль при UPDATE ≠ «нет записи».
2. `DB::transaction(callable)` передаёт `$this` в замыкание. Замыкание **не `static`**, если нужен `$this` (статическое не привязывает `$this` → `Error` в рантайме, `php -l` не ловит).
3. `DbException` без `previous` — до закрытия долга №1 опознать 1062 нельзя.
4. `Logger::db` пишет все параметры до `prepare`.
5. `sql_mode` без STRICT → валидация длин только в PHP (§8.4).
6. Ключи считает `App\Support\Address`, никаких вторых копий.
7. После каждой записи — `invalidateCache()`, иначе SPA живёт со старым словарём.
8. Имя дома ≤ 64 символов, ключ ≤ 190 — самые узкие места.
9. GUID не трогаем: `char(32)`, UNIQUE, владелец формата — `CallRepository::normalizeGuid` (скобки `{GUID}` он не нормализует).
10. Конкурент-писатель `sp.php` активен (`XML_add = 1`): проверка «SELECT, потом INSERT» без UNIQUE не защищает.
11. Тип узла и тип цели фиксированы маршрутом; имя таблицы/колонки знает репозиторий сущности. Диспетчеризация по строке типа из ввода запрещена.
12. В шаблон редактируемого узла не отдавать сырую строку `SELECT *` целиком — только поля контракта.
13. Все даты — в зоне MySQL (`NOW()`, `CURRENT_TIMESTAMP`), как в `AddressCacheService` и `DbUserRepository::lockUntil`. PHP-время в DATETIME не пишем.
14. В MariaDB нет JSON-типа: поля с JSON — `LONGTEXT` + `json_encode`, без `JSON_SET`.

---

## 10. Лог аудита

Таблица `lift_address_changes_log`:

| Колонка       | Тип                                         | Назначение                           |
| ------------- | ------------------------------------------- | ------------------------------------ |
| id            | bigint unsigned AI PK                       |                                      |
| created_at    | datetime NOT NULL DEFAULT CURRENT_TIMESTAMP | метка MySQL                          |
| actor_id      | int NOT NULL                                | id админа из сессии                  |
| actor_login   | varchar(30) NOT NULL                        | снимок логина на момент действия     |
| action        | varchar(20) NOT NULL                        | `move` \| `vis`                      |
| entity_type   | varchar(10) NOT NULL                        | `city\|street\|home\|object`         |
| entity_id     | int NOT NULL                                | главный узел операции                |
| old_parent_id | int NULL                                    |                                      |
| new_parent_id | int NULL                                    |                                      |
| old_name      | varchar(255) NULL                           |                                      |
| new_name      | varchar(255) NULL                           |                                      |
| old_key       | varchar(190) NULL                           |                                      |
| new_key       | varchar(190) NULL                           |                                      |
| old_vis       | tinyint(1) NULL                             |                                      |
| new_vis       | tinyint(1) NULL                             |                                      |
| affected      | longtext NULL                               | JSON: счётчики и id затронутых узлов |
| ip            | varchar(45) NULL                            |                                      |
| user_agent    | varchar(255) NULL                           | обрезка в PHP                        |

Индексы: `idx_created_at(created_at)` (cron), `idx_entity(entity_type, entity_id)`, `idx_actor(actor_id)`.

Полнота: для переноса — запись на каждый перемещённый узел (чтобы «кто куда дел объект 6411» искалось без разбора JSON); для каскада — одна запись на операцию с полным списком затронутых id в `affected`.

Хранение — 3 месяца. Cron-строка в `md/cron` (файл уже содержит строку чистки `lift_access_tokens`):

```sql
DELETE FROM lift_address_changes_log WHERE created_at < NOW() - INTERVAL 3 MONTH;
```

Журнал событий СПульт (`SpultEventRepository`, 30 дней) — другой канал, не смешивается и не чистится этим cron.

---

## 11. Взаимодействие со СПульт

Подтверждено исходником `sp.php`:

1. Структура сигнала: `DISP/STREET/HOME/LIFT`. GUID есть **только у пульта** (корневой атрибут) и **у лифта** (`LIFT@GUID`). **GUID улиц и домов не передаются.**
2. Город в XML не приходит: берётся `city_default` либо вырезается из `STREET@Name` по разделителю `#`.
3. Приоритет сопоставления: **GUID → адрес**. Адресный путь ищет по `city_key`, `(city_id, street_key)`, `(street_id, home_key)`, `(home_id, object_key)` и при `XML_add = 1` создаёт недостающие записи с `vis = 1`.
4. Поиск по ключам **не фильтрует `vis`**: скрытый узел сигнал не блокирует.
5. `CallRepository::resolveAddress()` — JOIN по цепочке id **без условия `vis`**, возвращает `o.vis` как поле. (Уточнение к моему более раннему сообщению: утверждение «скрытый родитель → null» относилось к LEFT JOIN в списках заявок, а не к `resolveAddress`.)
6. Расхождение адреса при найденном GUID сравнивается **по ключам компонентов** и порождает событие `guid_mismatch` (журнал + история заявки + возможно письмо админу).

Следствия для модуля:

- Переименование объекта с GUID не ломает приём сигнала, но до обновления названий на стороне пульта будет вал `guid_mismatch`. Фронт обязан предупреждать об этом при переносе с переименованием узла, у которого непустой `guid` (в тенанте таких 3).
- Любое переименование обязано пересчитать `*_key`, иначе СПульт создаст дубль-двойник.
- Скрытие узла убирает его из словаря SPA (`AddressRepository`/`AddressService` читают `vis = 1`), но не мешает созданию заявок по нему. Это ожидаемое поведение, а не баг; каскад вниз нужен, чтобы не оставлять видимых детей под скрытым родителем.
- **НЕ ПОДТВЕРЖДЕНО:** проверяет ли `CallService::validateAddress` (:722) `vis` и как именно. От этого зависит формулировка предупреждения в UI. Требуется чтение файла.

Флаг валидации адресов (решение по волне): `company/address-admin/Config/flags.php`, ключ валидации = `false`. Поведение трека А/Б в этой волне не меняется; hook проектируется, но не реализуется.

---

## 12. Техдолги, зафиксированные этим документом

| №   | Долг                                                                                                             | Приоритет                             |
| --- | ---------------------------------------------------------------------------------------------------------------- | ------------------------------------- |
| A1  | `DB.php`: `, 0, $e` в 5 catch                                                                                    | **блокер волны**                      |
| A2  | Preflight + бэкфилл ключей + UNIQUE на 4 уровня                                                                  | **блокер волны**                      |
| A3  | `AddressRepository::create*` не пишет ключи; `createObject` кладёт `spultId` в `abbreviated_name`                | высокий, отдельное решение по треку А |
| A4  | `Logger::db` логирует все параметры                                                                              | средний                               |
| A5  | `bootstrap-icons` CDN в обоих layout, AdminLTE CDN в `auth/login.php`                                            | низкий                                |
| A6  | Миграция `guest→auditor` применена наполовину: `user_id=27` имеет `user_position='auditor'`, `user_role='guest'` | вне волны, но зафиксировать           |
| A7  | Маршруты `settings`/`spult` в меню панели без обработчиков                                                       | вне волны                             |

---

## 13. Что нужно подтвердить до кода

**Решения:**

1. Placement общего автозагрузчика: `company/autoload.php` (не трогаем корневой `bootstrap.php`) — подтвердить.
2. Перенос в скрытого родителя: наследовать `vis` цели с предупреждением — подтвердить или отклонить.
3. Одиночный `vis` для объекта (без каскада) — в волне 1 или нет? В явном списке требований его не было.
4. Имена файлов ТЗ: `adreesbak.md`, `adressfront.md` — дословно или исправить.
5. Ручное переименование/создание/удаление узлов — подтверждаю как **вне волны 1**; если нужно иначе, скажи.

**Файлы с сервера (без `2>/dev/null`):**

```bash
cd /home/users/z/zamotaev/domains/liftcs.ru

cat company/admin/Services/SessionAuth.php
cat company/admin/Support/Position.php
cat company/admin/Support/Csrf.php
cat company/admin/Support/Flash.php
cat company/admin/Controllers/BaseController.php
cat company/admin/Config/routes.php
cat App/Database/DB.php
sed -n '700,800p' App/Service/CallService.php
cat App/Service/AddressService.php
```

Плюс SQL преflight из §3.2 — без его результатов UNIQUE не выполняется.

---

## 14. Приёмка (всё НЕ ПРОГНАТО)

- [ ] Долг №1 закрыт, `getPrevious()` возвращает `PDOException`, «Логин уже занят» срабатывает на гонке
- [ ] Preflight: нулевые NULL/пустые ключи, нет дублей, длины в лимитах
- [ ] 4 UNIQUE созданы, избыточные индексы удалены, `SHOW INDEX` подтверждает
- [ ] Дерево: 6 городов → 308 улиц у `city_id=1` → 93 дома у `street_id=202` → 29 объектов у `home_id=641`
- [ ] Порядок узлов совпадает с порядком адресного пикера SPA на «2 корп.2» и «п.1 пасс.»
- [ ] Ctrl+клик выделяет несколько узлов, подсказка видна до первого использования
- [ ] Перенос объекта без конфликта: `home_id` изменился, `object_key` не изменился, лог записан, `version` выросла
- [ ] Перенос с конфликтом `on_duplicate=abort`: 409, ничего не изменено
- [ ] Перенос с конфликтом `on_duplicate=rename`: имя `(2)`, ключ пересчитан, длина в лимите
- [ ] Перенос дома: все его объекты доступны по новому пути, `resolveAddress` отдаёт новый адрес
- [ ] Перенос улицы в город с одноимённой улицей другого типа: конфликтом не считается
- [ ] `vis=0` дому: все объекты дома `vis=0`; `matched`/`changed` в ответе различаются
- [ ] `vis=0` улице: каскад до объектов; `vis=1` обратно восстанавливает всё поддерево
- [ ] `vis=0` городу: каскад через улицу и дом до объекта
- [ ] «Показать скрытые»: скрытые видны, счётчики детей согласованы с выдачей
- [ ] Поиск находит узел и раскрывает дерево по `path`
- [ ] Клик по узлу: детали приходят с сервера, для каждого типа свой набор полей
- [ ] После любой записи SPA-вкладка получает новую версию `addresses` без перелогина
- [ ] Ошибка JSON-маршрута приходит конвертом, а не текстом
- [ ] POST без `X-CSRF-Token` → 403 JSON
- [ ] Не-админ не попадает ни в один маршрут модуля
- [ ] Cron удаляет записи старше 3 месяцев и не трогает свежие

---
