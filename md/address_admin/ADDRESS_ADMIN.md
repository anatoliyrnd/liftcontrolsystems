Актуальная редакция основного контракта адресного модуля. Согласована с ТЗ бэкенда и фронтенда; решения по двусторонней видимости, переносу поддеревьев, блокировкам и защите preview зафиксированы в соответствующих разделах.

---

# ADDRESS_ADMIN — модуль управления адресным пространством

Основной контракт: транспорт, маршруты, форматы запросов/ответов, алгоритмы.
ТЗ бэка — `md/техзадания/adreesbak.md`, ТЗ фронта — `md/техзадания/adressfront.md`.

> Имена файлов ТЗ взяты дословно из твоего сообщения (`adreesbak.md`, `adressfront.md`).
> Если это опечатка — скажи, поправлю до создания файлов.

> **Изменения модели видимости (редакция 27.11.2026):** двусторонний `vis` (каскад вниз + пересчёт предков вверх), индивидуальная скрытость сохраняется при переносе под видимого родителя; скрытая цель скрывает всё переносимое поддерево. Блокировки — top-down по уровням, ID по возрастанию. Preview защищён `preview_token`; устаревшее состояние возвращает 409 `state_changed`. См. алгоритмы и контракты ниже.

## 0. Статус документа

| Раздел                                                                                                                      | Статус                                                                                                                                                                    |
| --------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Схема БД, объёмы, опции тенанта                                                                                             | **ПОДТВЕРЖДЕНО** `information_schema` + `SELECT` (25.11.2026, тенант `zamotaev_demo_liftcs`)                                                                              |
| Владелец ключей `App\Support\Address`                                                                                       | **ПОДТВЕРЖДЕНО** полным исходником                                                                                                                                        |
| `AddressCacheService`, `AddressRepository`, `Bootstrap`, `View`, `Container`, `Router`, `layout.php`, `company/setting.php` | **ПОДТВЕРЖДЕНО** `cat` на сервере                                                                                                                                         |
| Приём XML СПульт (`sp.php`)                                                                                                 | **ПОДТВЕРЖДЕНО** исходником из репозитория `main`                                                                                                                         |
| Guard «только админ», CSRF                                                                                                  | **ПОДТВЕРЖДЕНО** `cat` на сервере: `SessionAuth` проверяет сырую роль, `Csrf::check()` читает только `$_POST` и отвечает текстом                                          |
| Поведение `CallService` по `vis`                                                                                            | **ПОДТВЕРЖДЕНО**: `validateAddress` возвращает `vis` (:756), единственный потребитель — :307, где в историю **уже созданной** заявки пишется отметка. Отказа по `vis` нет |
| Preflight ключей и объёмов (§1.4)                                                                                           | **ПОДТВЕРЖДЕНО** SQL 25.11.2026                                                                                                                                           |
| Все сценарии модуля                                                                                                         | **НЕ ПРОГНАНО** — кода модуля не существует                                                                                                                               |

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

Следствия: ленивая загрузка по уровням обязательна, но один уровень целиком (≤308 узлов) помещается в ответ без пагинации. Сортировка в SQL на объёме уровня допустима.

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

### 1.4 Результаты preflight (25.11.2026, тенант `zamotaev_demo_liftcs`)

| Проверка                                                | Результат                                                                             |
| ------------------------------------------------------- | ------------------------------------------------------------------------------------- |
| NULL / пустые `*_key`, 4 уровня                         | 0 / 0 везде                                                                           |
| Дубли ключей в области родителя, 4 области              | 0 групп                                                                               |
| Пустые или NULL имена, 4 уровня                         | 0                                                                                     |
| Расхождение хранимого ключа с именем (city/home/object) | 0 строк                                                                               |
| Максимум символов в именах                              | city 14, street 24, home 18, object 11                                                |
| Максимум символов в хранимых ключах                     | city 14, street 25, home 16, object 8                                                 |
| `street_type`                                           | ул 283, пер 48, пр-кт 23, пл 5, б-р 3, мкр 2, ш 1, NULL 1 — все непустые канонические |
| `city_type`                                             | г 6                                                                                   |
| Улиц без типа                                           | 1; с типовым словом в конце имени — 0                                                 |
| `lift_object.abbreviated_name`                          | `varchar(255) NOT NULL DEFAULT ''` — в INSERT можно не передавать                     |
| `lift_object.group_id`                                  | `int(11) DEFAULT 1`                                                                   |
| `lift_home.year_built`                                  | `NULL DEFAULT NULL`                                                                   |
| Зона сервера                                            | `@@system_time_zone = MSK`, `NOW() − UTC_TIMESTAMP() = +03:00`                        |

Следствия: бэкфилл ключей **не требуется**; четыре UNIQUE ставятся сразу; реконструкция ключа улицы из `(name, type)` безопасна на этих данных (§8.3); зона сессии PDO совпадает с зоной сервера, граница cron не разъезжается.

---

## 2. Владельцы логики: зовём, не копируем

| Что                            | Владелец                                                          | Правило для модуля                                                                                                                    |
| ------------------------------ | ----------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------- |
| Ключ города                    | `App\Support\Address::plainKey()`                                 | только вызов                                                                                                                          |
| Ключ улицы (тип входит в ключ) | `Address::streetKey()`                                            | только вызов                                                                                                                          |
| Ключ дома                      | `Address::homeKey()`                                              | только вызов                                                                                                                          |
| Ключ объекта                   | `Address::plainKey()`                                             | только вызов                                                                                                                          |
| Разбор типа/маркера            | `Address::parseCity/parseStreet/parseHome`                        | только вызов                                                                                                                          |
| Ключ сортировки заявок         | `Address::sortKey()`                                              | **в модуле не вызывается** (§8.6): порядок дерева — SQL по имени. Владелец ключа остаётся один и работает в списках и карточке заявки |
| Display-подпись                | `Address::formatDisplay()` / `formatCity/formatStreet/formatHome` | только вызов                                                                                                                          |
| Версия адресного слоя          | `App\Service\AddressCacheService::invalidateCache()`              | вызов после **каждой** успешной записи                                                                                                |
| Резолв адреса цепочкой         | `App\Repository\CallRepository::resolveAddress()`                 | не дублировать JOIN                                                                                                                   |
| Формат GUID                    | `App\Repository\CallRepository::normalizeGuid()`                  | не трогать GUID в волне 1                                                                                                             |
| Сессия/доступ                  | `Company\Admin\Services\SessionAuth`                              | переиспользование                                                                                                                     |

Запрещено: свой форматтер адреса, своя нормализация ключей, свой инкремент `lift_dict_versions`, своя сборка `fullAddress`.

**Известный дефект трека А (подтверждён `cat`):** `App\Repository\AddressRepository::createCity/createStreet/createHome/createObject` **не пишут `*_key`** и не зовут `Address::parse*`; `createObject` кладёт `$spultId` в `abbreviated_name`, тогда как `sp.php` пишет `spult_id` в `spult_id`. Это второй путь записи, создающий записи с пустыми ключами. Модуль **не использует** эти методы и не становится третьим путём. Фиксируется как техдолг (§12).

---

## 3. Блокирующие шаги до первого файла модуля

### Шаг 1. Долг №1 — `App\Database\DB.php`, сохранить `previous` — **ЗАКРЫТО 25.11.2026**

Подтверждено на сервере: `grep -n -F ', 0, $e' App/Database/DB.php` даёт пять совпадений (строки 62, 95, 113, 130, 152). `DbException` сохраняет `PDOException` с `SQLSTATE` и `errorInfo`, перевод 1062 в `DbUserRepository::create()` стал достижимым. Формулировки ниже оставлены как история долга.

~~Подтверждено: 5 блоков `catch (PDOException $e)` (строки 33, 61, 78, 94, 110), ни одного `, 0, $e`. `DbException` теряет причину.~~

~~Подтверждено также: `DbUserRepository.php:200` уже читает `$e->getPrevious()`. То есть **перевод 1062 в «Логин уже занят» уже написан, но мёртв** — `getPrevious()` всегда `null`.~~

Без этого шага UNIQUE-индексы давали 500 «Сервис временно недоступен» вместо разборного конфликта.

### Шаг 2. Preflight-проверки перед UNIQUE (обязательны, до ALTER)

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

**Статус 25.11.2026: все запросы 1–4 дали ноль (§1.4). Допуск к ALTER получен, бэкфилл не нужен.** Запросы остаются в документе как обязательный повторный прогон перед применением на другой базе.

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
- `Support\AddressTree` — владелец порядка и подписей: сортировка через SQL по имени своего уровня (см. §8.6), подписи через `Address::format*`, пути через `formatDisplay`. SQL внутри запрещён.

### 4.2 Общий автозагрузчик — placement требует подтверждения

Сейчас `company/setting.php` регистрирует автозагрузчик только для `Company\Admin\` и требует `../bootstrap.php`.

Корневой `bootstrap.php` — общий файл трека А: его подключают `api.php`, `auth.php`, `sp.php`. Регистрация панельных автозагрузчиков там затянет классы панелей в каждый API-запрос.

**Предложение:** общий файл `company/autoload.php`, регистрирующий оба префикса (`Company\Admin\` → `company/admin/`, `Company\AddressAdmin\` → `company/address-admin/`), подключается из обеих точек входа. Корневой `bootstrap.php` не меняется.

Это уточнение решения 4 («общий») — прошу подтвердить placement до кода.

### 4.3 Guard доступа

**Подтверждено исходником `Company\Admin\Services\SessionAuth`:** проверка централизована и дублировать её в модуле запрещено.

- `attempt()` и `user()` сравнивают **сырую** `user_role === 'administrator'` плюс `user_block`; нормализация трека А и fallback по `user_localadmin` не применяются;
- `user()` читает запись из БД на каждом вызове и разлогинивает при разжаловании или блокировке — кэшировать пользователя в модуле нельзя;
- `locked_until` в `user()` не проверяется сознательно: блокировка про вход, не про сессию;
- `Position::grantsPanelAccess()` в guard'е **не участвует** — он про «последнего админа» и «свою должность». Моё раннее предложение проверять должность снимаю.

Следствия для модуля: достаточно `auth->check()`, как в панели. **Своей страницы логина у модуля нет** — неаутентифицированный редиректится на `setting.php?page=login`, а не на `?page=login` внутри модуля.

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

Все изменяющие запросы — POST. Токен в заголовке `X-CSRF-Token` (решение 3). GET-маршруты (`city.list`, `*.children`, `*.details`, `*.movepreview`, `*.vispreview`, `tree.*`, `log.list`) токена не требуют, так как ничего не меняют.

Подтверждено исходником `Csrf`: сейчас `check()` читает только `$_POST['_csrf']` и на отказе делает `echo 'CSRF token mismatch'; exit;`. Для AJAX это нераспарсиваемый ответ, поэтому патч `Csrf` обязателен: чтение заголовка + JSON-отказ по признаку `Accept: application/json`, поведение панели сохраняется.

### 5.4 Ошибки в JSON-виде — обязательное требование к Bootstrap модуля

Текущий `Company\Admin\Support\Bootstrap` в `catch (\Throwable)` отдаёт **текст** `Сервис временно недоступен` с кодом 500, а при отказе тенанта — текст `Tenant not resolved` с 404. Для AJAX это нераспарсиваемый ответ: фронт покажет «сбой сети» вместо причины.

**Требование:** `Bootstrap` адресного модуля определяет ожидаемый формат (заголовок `Accept: application/json` либо признак JSON-маршрута) и в случае ошибки отдаёт конверт §5.2. Диагностика в лог остаётся как в панели: класс, message, файл:строка, page/action.

То же касается отказа CSRF: нужен JSON-ответ 403, а не текстовый обрыв. Текущее поведение `Csrf::check()` подтверждено в §5.3 (`echo` + `exit`) — патч `Csrf` обязателен.

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
| `city.vispreview`    | GET   | JSON   | сколько узлов затронет каскад городу       |
| `city.vis`           | POST  | JSON   | каскад `vis` городу                        |
| `street.children`    | GET   | JSON   | дома улицы                                 |
| `street.details`     | GET   | JSON   | детали улицы                               |
| `street.movepreview` | GET   | JSON   | предпросмотр переноса улиц в город         |
| `street.move`        | POST  | JSON   | перенос улиц в город                       |
| `street.vispreview`  | GET   | JSON   | сколько узлов затронет каскад улице        |
| `street.vis`         | POST  | JSON   | каскад `vis` улице                         |
| `home.children`      | GET   | JSON   | объекты дома                               |
| `home.details`       | GET   | JSON   | детали дома                                |
| `home.movepreview`   | GET   | JSON   | предпросмотр переноса домов в улицу        |
| `home.move`          | POST  | JSON   | перенос домов в улицу                      |
| `home.vispreview`    | GET   | JSON   | сколько узлов затронет каскад дому         |
| `home.vis`           | POST  | JSON   | каскад `vis` дому                          |
| `object.details`     | GET   | JSON   | детали объекта                             |
| `object.vispreview`  | GET   | JSON   | предпросмотр одиночного изменения vis объекта |
| `object.vis`         | POST  | JSON   | изменение vis объекта                      |
| `object.movepreview` | GET   | JSON   | предпросмотр переноса объектов в дом       |
| `object.move`        | POST  | JSON   | перенос объектов в дом                     |
| `log.index`          | GET   | HTML   | страница журнала                           |
| `log.list`           | GET   | JSON   | журнал с фильтрами и пагинацией            |

Целевой родитель фиксирован маршрутом: `object.move` → дом, `home.move` → улица, `street.move` → город. Перенос города не предусмотрен: город — корень.

**Регистр ключей:** action в URL — строчными, метод контроллера — camelCase (`city.vispreview` → `visPreview`). Соответствие задаёт только карта; Router имя метода из строки не выводит. Правило взято из `company/admin/Config/routes.php` (`users.reloadall` → `reloadAll`).

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

`guid_present` — булев признак непустого `guid`: нужен фронту для предупреждения о `guid_mismatch` при переносе с переименованием. Сам `guid` в списке не отдаётся, он приходит в `object.details`.

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

### 7.5 `object.movepreview` / `home.movepreview` / `street.movepreview`

Запрос: `ids[]`, `target_id`. Тип переносимого узла и тип цели заданы маршрутом: `object` → дом, `home` → улица, `street` → город.

Поле `type` в ответе — эхо маршрута, не входной параметр. Preview возвращает `version` адресного слоя и `preview_token` — короткоживущий opaque HMAC-токен от канонического снимка состояния (tenant + route + ids + parents + vis + keys + target + preview result). Токен привязан к типу/ID переносимых узлов, их родителям и vis, целевому родителю, его vis, составу/ключам детей цели и рассчитанному vis_effect. Он не является средством авторизации.

Ответ `data`:

```json
{
  "type": "object",
  "target": { "type": "home", "id": 988, "display": "д. 15", "path_display": "…", "vis": 1 },
  "items": [
    { "id": 6411, "name": "п.1 пасс.", "key": "п1пасс", "current_parent_id": 641,
      "conflict": true, "existing_id": 7002, "proposed_name": "п.1 пасс. (2)",
      "proposed_key": "п1пасс(2)", "too_long": false, "vis_before": 0, "vis_after": 0 }
  ],
  "totals": { "count": 3, "conflicts": 1, "too_long": 0, "same_parent": 0 },
  "vis_effect": {
    "down": { "matched": { "homes": 0, "objects": 1 }, "will_hide": 0, "will_show": 0, "will_preserve_hidden": 1 },
    "up_old_parent": { "type": "home", "id": 641, "vis_before": 1, "vis_after": 0 },
    "up_new_parent": { "type": "home", "id": 988, "vis_before": 1, "vis_after": 1 },
    "inherit_from_target": false
  },
  "version": 13,
  "preview_token": "opaque-server-token"
}
```

`vis_effect.down` описывает все узлы переносимого поддерева, а не только корень. При переносе под скрытого родителя все узлы поддерева станут скрытыми. При переносе под видимого родителя существующие значения сохраняются: скрытый узел остаётся скрытым. `up_old_parent` и `up_new_parent` показывают прогноз пересчёта предков; для каждого предка в полном списке сохраняется тип, ID и vis до/после. Если переносимый узел уже находится в целевом родителе, он не перемещается и не участвует в прогнозе.

`too_long=true` — перенос с автонумерацией не пройдёт валидацию длины (`home_name` 64, `*_name` 255, `*_key` 190). Фронт обязан заблокировать подтверждение.

### 7.6 `object.move` / `home.move` / `street.move`

POST, `X-CSRF-Token`. Тело (пример `object.move`):

```json
{ "ids": [6411, 6412], "target_id": 988, "on_duplicate": "rename", "preview_token": "opaque-server-token" }
```

`on_duplicate` ∈ `abort | rename`. `abort` — при любом конфликте отказ 409 без частичного применения. `preview_token` обязателен: сервер внутри транзакции заново строит снимок состояния после получения блокировок и сравнивает его с предпросмотром. Если состояние изменилось — `409 state_changed`, без записи; фронт повторно запрашивает preview. `version` используется как дополнительная проверка, но не заменяет сравнение снимка.

Ответ `data`:

```json
{
  "moved": [{ "id": 6411, "old_parent_id": 641, "new_parent_id": 988,
    "old_name": "п.1 пасс.", "new_name": "п.1 пасс. (2)", "old_key": "п1пасс", "new_key": "п1пасс(2)",
    "old_vis": 0, "new_vis": 0 }],
  "vis_changed": { "changed": [], "ancestors": [], "counts": { "hidden": 0, "shown": 0 } },
  "renamed_count": 1,
  "version": 14,
  "log_id": 4521
}
```

`vis_changed.changed` — полный список узлов, у которых фактически изменился `vis` (тип, ID, `old_vis`, `new_vis`); он включает корни переноса и любые узлы поддерева. `vis_changed.ancestors` — все пересчитанные предки старой и новой ветвей, с `old_vis`/`new_vis`, включая предков, у которых значение не изменилось. Списки дедуплицированы по паре type+id. `counts` содержит фактическое число скрытых и показанных узлов.

Ошибка 409 `duplicate_conflict`, `details.items` — тот же формат, что в preview. Ошибка 409 `state_changed` означает устаревший preview и требует нового preview.

### 7.7 `city.vispreview` / `street.vispreview` / `home.vispreview` / `object.vispreview`

Запрос: `id`, `vis` (`0|1`). Для city/street/home выполняется каскад вниз и пересчёт предков вверх; для object меняется сам лист и пересчитываются home → street → city.

Ответ `data`:

```json
{
  "node": { "type": "street", "id": 202, "display": "ул. Ленина", "vis": 1 },
  "target_vis": 0,
  "down": { "matched": { "cities": 0, "streets": 1, "homes": 93, "objects": 412 }, "already_in_state": { "cities": 0, "streets": 0, "homes": 0, "objects": 0 } },
  "up": [{ "type": "city", "id": 1, "vis_before": 1, "vis_after": 0 }],
  "version": 15,
  "preview_token": "opaque-server-token"
}
```

`down.matched` включает сам узел и всё его поддерево, с раздельными счётчиками по типам (`cities`, `streets`, `homes`, `objects`); для object содержит только объект. `already_in_state` — сколько узлов уже имеют целевое значение. `up` содержит всех предков, которых затронет пересчёт, с прогнозом `vis_before`/`vis_after`.

Preview read-only. `preview_token` привязан к снимку поддерева и цепочки предков; если снимок изменился до POST, сервер возвращает `409 state_changed`.

**Смысл предупреждения в UI (подтверждено, §11).** Скрытие убирает узлы из справочника SPA, но **не останавливает создание заявок** — ни онлайн, ни офлайн-синхронизацией, ни через СПульт. При создании заявки по скрытому объекту в историю пишется отметка «объект выведен из обслуживания на момент синхронизации». Формулировка «приём заявок прекратится» запрещена.

### 7.8 `city.vis` / `street.vis` / `home.vis` / `object.vis`

POST, `X-CSRF-Token`, тело `{ "id": 202, "vis": 0, "preview_token": "opaque-server-token" }`. Уровень каскада задан маршрутом. `preview_token` обязателен и проверяется внутри транзакции после блокировок. Устаревший снимок → `409 state_changed` без записи.

Ответ `data`:

```json
{
  "changed": { "streets": 1, "homes": 93, "objects": 412 },
  "matched": { "streets": 1, "homes": 93, "objects": 412 },
  "vis_changed": {
    "changed": [{ "type": "street", "id": 202, "old_vis": 1, "new_vis": 0 }],
    "ancestors": [{ "type": "city", "id": 1, "old_vis": 1, "new_vis": 0 }],
    "counts": { "hidden": 506, "shown": 0 }
  },
  "version": 16,
  "log_id": 4522
}
```

`vis_changed.changed` — все узлы с фактическим изменением, включая descendants, а не только выбранный узел. `vis_changed.ancestors` — все проверенные предки, с прежним и итоговым значением. `changed`/`matched` сохраняются для совместимости счётчиков UI; `vis_changed` — источник полной детализации и аудита.

Ответ не содержит признака остановки приёма заявок: такого эффекта у скрытия нет (§11).

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

Все шаги выполняются в одной транзакции. Перенос пересчитывает видимость по старой и новой ветвям.

1. Валидация: `ids` непустой, все `int > 0`, дедупликация; `target_id > 0`; `on_duplicate` из белого списка; `preview_token` обязателен.
2. Определить полный набор затрагиваемых узлов: переносимые корни и их поддеревья, целевой родитель, старые родители, все предки старых и новой ветвей, а также диапазоны детей родителей, состав которых влияет на пересчёт `vis`.
3. Заблокировать набор детерминированно: уровни сверху вниз (`city → street → home → object`); внутри каждого уровня — уникальные ID по возрастанию. Внутри одного уровня блокировать все строки одним отсортированным набором, не в порядке входного массива. Блокировать строки всех старых и новых родителей, включая родительские строки, через которые другие операции модуля могут добавить/удалить детей. Любой move обязан сначала получить эти блокировки в том же порядке; это сериализует операции самого модуля.
4. После блокировок повторно прочитать строки и построить снимок; проверить `preview_token`. Несовпадение → `409 state_changed`, rollback, никаких записей.
5. Проверить существование целевого родителя и всех переносимых узлов; отсутствие → `not_found`, rollback.
6. Прочитать всех детей цели, включая `vis=0`, собрать занятые ключи.
7. Разрешить конфликты ключей по §8.3. При `abort` — 409 и полный rollback; при `rename` — проверить длины до записи.
8. Переместить корни. Если целевой родитель скрыт (`vis=0`), установить `vis=0` **всем узлам каждого переносимого поддерева**. Если целевой родитель видим (`vis=1`), сохранить `vis` каждого переносимого узла: скрытые узлы не становятся видимыми автоматически.
9. Пересчитать предков старой и новой ветвей снизу вверх. Для каждого родителя: если у него есть хотя бы один непосредственный видимый ребёнок — `vis=1`; если дети существуют и все скрыты — `vis=0`; если детей нет — сохранить прежний `vis`. При переносе нескольких узлов один предок пересчитывается один раз после всех перемещений.
10. Записать аудит: одна запись `move` на каждый перемещённый корень; `affected` содержит все фактически изменённые vis-узлы и полный список пересчитанных предков с old/new.
11. Коммит. После коммита вызвать `AddressCacheService::invalidateCache()`. Ошибка инвалидирования не должна приводить к повторному выполнению уже закоммиченного переноса: в колонке `cache_invalidation_pending` записи аудита устанавливается `1`, операция остаётся успешной; cron/reconciler повторяет инвалидизацию и снимает pending после успеха.
12. Вернуть `moved`, `vis_changed`, `version`, `log_id`.

**Важное ограничение СПульт.** `sp.php` создаёт записи вне транзакции модуля и не обязан соблюдать описанный порядок блокировок. UNIQUE-индексы защищают уникальность ключей, но не гарантируют сериализацию вставки нового ребёнка с пересчётом предков. В волне 1 принимается возможность временного дрейфа `vis` после записи СПульт. Следующая операция модуля над веткой выполняет полную сверку/пересчёт предков по фактическому составу детей. Это ограничение не следует трактовать как гарантию отсутствия гонки. Отдельная будущая задача — согласовать `sp.php` с общей блокировкой и пересчётом либо добавить периодический reconciler.

**Проверка цикла не нужна.** Иерархия строго четырёхуровневая, тип родителя фиксирован маршрутом.

### 8.3 Автонумерация при конфликте

Формат: `{исходное имя} ({n})`, `n` начинается с 2.

1. `candidate = name . ' (' . n . ')'`.
2. Ключ считается **тем же** методом уровня (`plainKey` / `homeKey` / `streetKey`), не вручную.
3. Если ключ занят среди детей цели (включая скрытых и уже обработанных в этой пачке) — `n++`, повтор.
4. Ограничение попыток (например 1000) с явной ошибкой вместо вечного цикла.
5. Проверка длин (§8.4) для каждого кандидата.

Существующее имя **не нормализуется**: «п.1 пасс.» — целиком идентичность объекта, `Address::plain()` снимает только пробелы. Маркеры и типы не переписываются.

Для улицы суффикс добавляется к **имени**, а не к типу: `Ленина (2)` + `street_type = ул`, ключ `ул|ленина(2)`.

**Ключ улицы из хранимых `(name, type)`** считается реконструкцией сырой строки и вызовом владельца: `Address::streetKey($newName . ' ' . $type)` при непустом типе, `Address::streetKey($newName)` при пустом. Отдельный метод в `App\Support\Address` **не вводится** (решение B3, вариант «б»): данные подтвердили каноничность всех непустых типов и отсутствие опасных имён (§1.4).

**Guard обязателен:** `Address::parseStreet()` от реконструированной строки должен вернуть ровно хранимый тип и новое имя. Несовпадение — легаси-код типа вне словаря алиасов либо типовое слово в конце имени при пустом типе — даёт отказ `validation_failed` с логом, ключ не пишется. Угаданный ключ ломает сопоставление СПульт и плодит дубли, поэтому отказ лучше «почти правильного» ключа.

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

### 8.5 Двусторонняя модель `vis`

Модель состоит из двух направлений:

1. **Вниз:** явное изменение видимости узла распространяется на всё его поддерево. `vis=0` скрывает узел и всех потомков; `vis=1` показывает узел и всех потомков. Это правило относится к city, street, home. Для object меняется сам лист.
2. **Вверх:** после изменения листа/поддерева или переноса пересчитываются все предки до city. Для родителя: хотя бы один непосредственный ребёнок `vis=1` → родитель `vis=1`; все существующие непосредственные дети `vis=0` → родитель `vis=0`; если детей нет — сохранить прежнее значение родителя. Расчёт выполняется снизу вверх.

Таким образом, родитель отражает наличие хотя бы одного видимого непосредственного ребёнка, но пустой родитель не теряет своё последнее состояние. После каскада вниз пересчёт вверх может изменить предков выбранного узла.

**Перенос:** скрытый переносимый узел остаётся скрытым при переносе под видимого родителя. При переносе под скрытого родителя `vis=0` применяется ко всем узлам переносимого поддерева. При переносе под видимого родителя сохраняются все индивидуальные значения `vis` поддерева. После этого пересчитываются предки старой и новой ветвей.

**Полнота пересчёта.** Старые предки пересчитываются после удаления перемещённых узлов из старой ветви; новые предки — после вставки в новую ветвь. При пересечении цепочек предков каждый узел пересчитывается один раз по итоговому состоянию БД.

**Зачем каскад (подтверждено §11).** Скрытие не останавливает приём заявок. Каскад обеспечивает согласованность дерева и появление отметки в истории по скрытым объектам: `resolveAddress` отдаёт `vis` самого объекта.

**Порядок блокировок и записи:** полный набор затрагиваемых строк определяется до записи; блокировки идут уровнями сверху вниз (`city → street → home → object`), внутри уровня — ID по возрастанию. Обновление видимости и пересчёт предков выполняются снизу вверх в рамках той же транзакции. Все операции модуля придерживаются одного порядка блокировок.

**СПульт:** `sp.php` — внешний писатель и не участвует в транзакции/протоколе блокировок модуля. После его вставок возможен временный дрейф. При следующей операции над веткой модуль полностью пересчитывает её предков по фактическим детям. Согласование `sp.php` или периодический reconciler — отдельная задача.

Preview read-only, возвращает `down`, `up`, `version`, `preview_token`. POST сверяет токен после блокировок; устаревший снимок → `409 state_changed`.

Счётчики `matched` и `changed` сохраняются: `matched` — количество узлов в области операции, `changed` — число реально изменённых строк. `vis_changed` содержит полный список изменённых узлов и предков, а не только агрегаты.

После коммита вызывается `invalidateCache()`. Ошибка инвалидирования фиксируется в аудите как `cache_invalidation_pending=true`; cron/reconciler повторяет инвалидизацию. Нельзя повторять уже закоммиченную операцию как будто транзакция не состоялась.

### 8.6 Сортировка — решение изменено по факту grep

**Факт:** в `frontend/js/components/address-picker.js` нет `sort` и нет `localeCompare` — только проброс `sort_key` (строки 216, 451, 576). Порядок списка адресов в пикере приходит с сервера: `App\Service\AddressService::getAddresses()` сортирует `ORDER BY city_name / street_name / home_name / object_name`. Ключ `sort_key` из `address-flattener.js:69–97` применяется к **таблице заявок** (`body-render.js:67–69`), а не к дереву адресов.

**Решение:** дерево модуля сортируется **в SQL по колонке имени своего уровня**, ровно как справочник для SPA. Прежний вариант «сортировать в PHP через `Address::sortKey`» отменён: он опирался на неверную предпосылку о сортировке в пикере.

Следствия:

- `Support\AddressTree` **не сортирует** — он отвечает только за display-подписи и пути;
- имена предков для сортировки не нужны, N+1 не возникает;
- имя в справочнике чистое (`street_name` без типа, `home_name` без маркера), поэтому тип не собирает все улицы под «у», а дома — под «д»;
- сравнение выполняет collation MySQL. `Address` не сворачивает `ё/е`, а collation может считать их равными: расхождение возможно только на таких именах и для дерева допустимо — порядок заявок живёт по своему ключу;
- `Address::sortKey` в модуле не вызывается. Владелец ключа сортировки остаётся один и работает там, где нужен, — в списках и карточке заявки.

Запрещено: сортировать дерево на клиенте, вводить второй компаратор, «улучшать» порядок натуральной сортировкой чисел без отдельного решения.

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
3. `DbException` сохраняет `previous` (долг №1 закрыт 25.11.2026): причина достаётся через `getPrevious()->errorInfo[1]`. Опознание 1062 обязательно, а не «по возможности».
4. `Logger::db` пишет все параметры до `prepare`.
5. `sql_mode` без STRICT → валидация длин только в PHP (§8.4).
6. Ключи считает `App\Support\Address`, никаких вторых копий.
7. После каждой записи — `invalidateCache()`, иначе SPA живёт со старым словарём.
8. Имя дома ≤ 64 символов, ключ ≤ 190 — самые узкие места.
9. GUID не трогаем: `char(32)`, UNIQUE, владелец формата — `CallRepository::normalizeGuid` (скобки `{GUID}` он не нормализует).
10. Конкурент-писатель `sp.php` активен (`XML_add = 1`): проверка «SELECT, потом INSERT» без UNIQUE не защищает.
11. Тип узла и тип цели фиксированы маршрутом; имя таблицы/колонки знает репозиторий сущности. Диспетчеризация по строке типа из ввода запрещена.
12. В шаблон редактируемого узла не отдавать сырую строку `SELECT *` целиком — только поля контракта.
13. Все даты — в зоне MySQL (`NOW()`, `CURRENT_TIMESTAMP`). Зона сессии PDO зафиксирована в `DB.php` как `SET time_zone = '+03:00'`, серверный `system_time_zone = MSK` — значения совпадают. PHP-время в DATETIME не пишем. Наружу даты уходят в +03:00, фронт локальную зону браузера не применяет.
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
| affected      | longtext NULL                               | JSON: счётчики, все изменённые vis-узлы и предки с old/new |
| cache_invalidation_pending | tinyint(1) NOT NULL DEFAULT 0 | повторная инвалидизация версии после commit |
| ip            | varchar(45) NULL                            |                                      |
| user_agent    | varchar(255) NULL                           | обрезка в PHP                        |

Индексы: `idx_created_at(created_at)` (cron), `idx_entity(entity_type, entity_id)`, `idx_actor(actor_id)`, `idx_cache_pending(cache_invalidation_pending, created_at)`.

Полнота: для переноса — запись на каждый перемещённый узел (чтобы «кто куда дел объект 6411» искалось без разбора JSON); для каскада — одна запись на операцию с полным списком затронутых id в `affected`; для `move` туда также попадают все потомки, чья видимость изменилась, и все пересчитанные предки старой/новой ветвей с `old_vis`/`new_vis`.

Хранение — 3 месяца. Cron в `md/cron` чистит журнал и повторяет `AddressCacheService::invalidateCache()` для записей с `cache_invalidation_pending=1`; после успешной инвалидизации pending снимается. (Файл уже содержит строку чистки `lift_access_tokens`.)

Оговорка про зону: `created_at` пишется в сессии PDO с `+03:00`, а cron выполняет `NOW()` в своей сессии — сейчас `SYSTEM = MSK`, границы совпадают (проверено 25.11.2026). При смене TZ хостера трёхмесячная граница разъедется на часы; это принимается, но при разборе «почему запись исчезла раньше» проверяется первым делом.

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
5. `CallRepository::resolveAddress()` — JOIN по цепочке id **без условия `vis`**, возвращает `o.vis` как поле.
6. Расхождение адреса при найденном GUID сравнивается **по ключам компонентов** и порождает событие `guid_mismatch` (журнал + история заявки + возможно письмо админу).

Следствия для модуля:

- Переименование объекта с GUID не ломает приём сигнала, но до обновления названий на стороне пульта будет вал `guid_mismatch`. Фронт обязан предупреждать об этом при переносе с переименованием узла, у которого непустой `guid` (в тенанте таких 3).
- Любое переименование обязано пересчитать `*_key`, иначе СПульт создаст дубль-двойник.
- Скрытие узла убирает его из словаря SPA (`AddressRepository`/`AddressService` читают `vis = 1`), но **не мешает созданию заявок по нему**. Подтверждено телом ветки `CallService:307`: внутри `if (!$addr['vis'])` стоит только `$this->historyRepo->add($callId, ...)`, а `$callId` уже существует — заявка создана. Отказа, `ApiException` или иного обрыва там нет.
- Текст отметки дословно: **«объект выведен из обслуживания на момент синхронизации»**. Это единственный серверный сигнал о скрытости при создании заявки.
- `grep -n -F "['vis']" App/Service/CallService.php` даёт ровно два места: :307 (эта ветка) и :756 (возврат из `validateAddress`). Других потребителей `vis` в сервисе нет.
- `resolveAddress` возвращает `o.vis` — видимость **только самого объекта**. Скрытый дом с видимыми объектами отметки не даёт; каскад делает её всеобщей (§8.5).
- **В карантин по `vis` сигнал не уезжает.** Маппинг причин в `sp.php` знает `object_not_found` (:1004) и общий fallback (:1014); причины, связанной со скрытостью, в словаре нет.
- История формулировки: моё промежуточное утверждение «заявка по скрытому объекту не создаётся, сигнал уйдёт в карантин» было **ошибочным** — вывод сделан по условию `if` без тела. Снято; исходная формулировка этого пункта восстановлена как верная.

Флаг валидации адресов (решение по волне): `company/address-admin/Config/flags.php`, ключ валидации = `false`. Поведение трека А/Б в этой волне не меняется; hook проектируется, но не реализуется.

---

## 12. Техдолги, зафиксированные этим документом

| №   | Долг                                                                                                                      | Приоритет                                                                         |
| --- | ------------------------------------------------------------------------------------------------------------------------- | --------------------------------------------------------------------------------- |
| A1  | `DB.php`: `, 0, $e` в 5 catch                                                                                             | **ЗАКРЫТ 25.11.2026**, подтверждено grep на сервере                               |
| A2  | UNIQUE на 4 уровня                                                                                                        | preflight чист (§1.4), бэкфилл не нужен; **ALTER разрешён**, ожидается применение |
| A3  | `AddressRepository::create*` не пишет ключи; `createObject` кладёт `spultId` в `abbreviated_name`                         | высокий, отдельное решение по треку А                                             |
| A4  | `Logger::db` логирует все параметры                                                                                       | средний                                                                           |
| A5  | `bootstrap-icons` CDN в обоих layout, AdminLTE CDN в `auth/login.php`                                                     | низкий                                                                            |
| A6  | ~~Миграция 1.8 применена наполовину~~ — **ложная тревога, снята**: по `Position::role()` пара `auditor → guest` корректна | закрыт                                                                            |
| A7  | Маршруты `settings`/`spult` в меню панели без обработчиков                                                                | вне волны                                                                         |
| A8  | Текст отметки `CallService:307` говорит «на момент синхронизации», хотя ветка общая для онлайн- и офлайн-создания         | косметика трека А, низкий, не наш модуль                                          |

---

## 13. Что нужно подтвердить до кода

**Закрыто фактами:**

- guard «только админ» — в `SessionAuth`, по сырой роли; модуль свой guard не вводит, редирект на `setting.php?page=login`;
- CSRF — нужен патч `Csrf::check()`: заголовок + JSON-отказ;
- долг №1 — закрыт на сервере;
- preflight — чист, UNIQUE разрешён, бэкфилл не нужен;
- ключ улицы — вариант «б»: реконструкция + guard, трек А не трогаем;
- порядок дерева — SQL по имени (§8.6);
- инкремент версии — после коммита (§8.2 шаг 10);
- регистр ключей маршрутов — строчными (§6);
- поведение по `vis` — отказ отсутствует, есть только отметка в истории (§11);
- проверка синтаксиса — выполняет IDE, прогон через интерпретатор не требуется.

**Осталось подтвердить:**

1. Старт сессии: извлечь общий `Session::start()` вместо копии ini (B4) — патч панели.
2. Placement общего автозагрузчика `company/autoload.php` (B5), корневой `bootstrap.php` не трогаем.

**Вне волны 1:** ручные create/rename/delete узлов, инфо-поля оборудования, группы, XML-импорт, редактирование в SPA, матрица прав.

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
- [ ] `object.vispreview`/`object.vis`: одиночный объект скрывается/показывается, все предки пересчитываются
- [ ] изменение vis объекта при видимых соседях оставляет родителя видимым; скрытие последнего видимого ребёнка скрывает предков до city
- [ ] пустой родитель при пересчёте сохраняет прежний `vis`
- [ ] показ родителя каскадно показывает всё поддерево, затем пересчитывает предков
- [ ] перенос скрытого объекта под видимого родителя сохраняет `vis=0`
- [ ] перенос дома под скрытую улицу скрывает дом и все объекты; перенос под видимую улицу сохраняет vis каждого узла
- [ ] перенос пересчитывает все старые и новые ветви, включая предков, общих для обеих ветвей
- [ ] блокировки: уровни city→street→home→object, ID по возрастанию внутри уровня; конкурентные переносы не создают дедлок при одинаковом наборе строк
- [ ] изменение состояния между preview и POST даёт 409 `state_changed`, никаких частичных записей
- [ ] `vis_changed` содержит все реально изменённые узлы и всех пересчитанных предков с old/new
- [ ] сбой `invalidateCache()` после commit не приводит к повторному выполнению операции; ошибка фиксируется и инвалидизация повторяется
- [ ] `vis=0` улице: каскад до объектов; `vis=1` обратно восстанавливает всё поддерево
- [ ] `vis=0` городу: каскад через улицу и дом до объекта
- [ ] «Показать скрытые»: скрытые видны, счётчики детей согласованы с выдачей
- [ ] Скрытый объект: узла нет в справочнике SPA, но заявка по нему **создаётся**, в истории — отметка «объект выведен из обслуживания на момент синхронизации»
- [ ] Скрытый дом с видимыми объектами после внешней записи СПульт: дрейф фиксируется как ограничение; следующая операция модуля над веткой пересчитывает предков
- [ ] Сигнал СПульт по скрытому объекту: заявка создаётся, в `quarantine/` **не попадает**
- [ ] Поиск находит узел и раскрывает дерево по `path`
- [ ] Клик по узлу: детали приходят с сервера, для каждого типа свой набор полей
- [ ] После любой записи SPA-вкладка получает новую версию `addresses` без перелогина
- [ ] Ошибка JSON-маршрута приходит конвертом, а не текстом
- [ ] POST без `X-CSRF-Token` → 403 JSON
- [ ] Не-админ не попадает ни в один маршрут модуля
- [ ] Cron удаляет записи старше 3 месяцев и не трогает свежие
