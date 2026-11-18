# 📋 ORGANIZATION_ADMIN.md — v1.1

**Версия:** 1.1
**Дата:** 18.11.2026
**Статус:** согласовано, готово к реализации
**Область:** `company/setting.php`, `company/admin/`
**Связанные документы:** `AUTH_PROTOCOL.md` v2.2, `API_PROTOCOL.md` v4.4, `bisness.md` v3.0, `admin_tennat_seting.md`, `bekend.md`, `sqlupdate.txt`

---

## 0. Назначение и границы

Админ-панель настроек организации (`Organization Settings`) — отдельный PHP-интерфейс для администратора тенанта. Управляет пользователями, настройками интеграции СПульт и мониторингом событий без доступа к SPA диспетчера.

### Что это НЕ такое

| Плоскость                                 | Что это                         | Где живёт                             |
| ----------------------------------------- | ------------------------------- | ------------------------------------- |
| **Organization Settings** (этот документ) | Настройки одного тенанта        | `company/setting.php`                 |
| **Platform Admin** (super admin)          | Управление тенантами и системой | `admin/` (`index.php`, `tenants.php`) |
| **SPA диспетчера**                        | Рабочее место диспетчера        | `frontend/mobile/`                    |
| **Node.js API (Трек Б)**                  | Будущий бэкенд                  | Вне текущего объёма                   |

Админ-панель **не пересекается** с Platform Admin, не управляет списком тенантов и не заменяет SPA.

### Принципы

1. **Авторизация — только `$_SESSION`.** JWT-инфраструктура в PHP-админке отсутствует (§7).
2. **Доступ — строго `user_role = 'administrator'`.** `user_localadmin`, `user_disppermission`, `user_edit_user` — legacy, в проверке не участвуют.
3. **Удаление пользователей запрещено.** Только мягкая блокировка (`user_block = 1`) и скрытие (`user_hiden = 1`).
4. **Бизнес-логика — в сервисах, SQL — только в репозиториях, Views — только вывод.**
5. **Шов для Трека Б — один.** Интерфейсы репозиториев. Остальное — конкретные классы без «абстракций на всякий случай».
6. **`legacy_compat` не учитываем** — Трек А на MariaDB, Трек Б (если появится) на PostgreSQL. В коде на `legacy_compat` не закладываемся.
7. **Схему `lift_users` не расширяем** без необходимости. Всё, что можно сделать на существующих таблицах и файлах — делаем так.

---

## 1. Принятые решения

| №   | Вопрос                                | Решение                                                                                                                                                                                                              |
| --- | ------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| 1   | Расположение                          | `company/setting.php` — точка входа; всё остальное в `company/admin/`                                                                                                                                                |
| 2   | Доступ                                | `user_role = 'administrator'` (строго)                                                                                                                                                                               |
| 3   | `user_localadmin`                     | Не используется; legacy, deprecated                                                                                                                                                                                  |
| 4   | Пароли                                | `App\Support\Password` (`verify` / `hash` / `needsRehash`), bcrypt + авто-миграция MD5/phpass при входе                                                                                                              |
| 5   | Сессия                                | `$_SESSION`, имя cookie `LIFTCS_ADMIN`, `HttpOnly`, `Secure` (при HTTPS), `SameSite=Strict`                                                                                                                          |
| 6   | CSRF                                  | Обязателен на всех POST; токен в `$_SESSION`, ротация при логине **и логауте**                                                                                                                                       |
| 7   | `admin_email`                         | Добавляется миграцией в `lift_options` (`type=text`, `change_allowed=1`)                                                                                                                                             |
| 8   | `org_key`                             | Не секрет; `change_allowed=1`; читается открыто                                                                                                                                                                      |
| 9   | `audit_log`                           | Пишем действия админки: `admin.login`, `admin.login_failed`, `admin.login_locked`, `admin.logout`, `user.*`, `settings.*`, `org_key.rotate`, `spult.download`. Таблица создаётся миграцией `sqlupdate.txt`, доступна |
| 10  | Шаблон                                | AdminLTE 4 (vanilla JS, Bootstrap 5.3), на старте CDN, вендоринг до прода                                                                                                                                            |
| 11  | Автозагрузка                          | Второй `spl_autoload_register` в `setting.php` для `Company\Admin\` → `company/admin/`; `App\` не трогаем                                                                                                            |
| 12  | Тенант                                | `Tenant::fromRequest()` (публичный, готов); только `Host`, как в API (§0.2 `AUTH_PROTOCOL.md`)                                                                                                                       |
| 13  | Шов для Трека Б                       | Только интерфейсы репозиториев; `SessionAuth`, контроллеры, Views не меняются при переезде                                                                                                                           |
| 14  | Rate-limit логина                     | **Файловый, по прецеденту `_orgkey`** (`admin_tennat_seting.md`). Схему `lift_users` не расширяем (см. §3.8)                                                                                                         |
| 15  | `.htaccess`                           | Секция 4: `company/setting.php` в белый список. Секция 1: `company/admin/` в запрещённые директории. Патч **до** выкатки                                                                                             |
| 16  | Прямой доступ к `company/admin/*.php` | Запрещён секцией 1 `.htaccess`; только через `require` из `setting.php`                                                                                                                                              |
| 17  | Обработка исключений                  | `Bootstrap::run()` обёрнут в try/catch после получения `$tenant`; generic 500 наружу, стек — в лог                                                                                                                   |
| 18  | Content-Type                          | `header('Content-Type: text/html; charset=utf-8')` до первого вывода                                                                                                                                                 |
| 19  | Тесты                                 | Unit-тесты на `OrgKeyService`, `Csrf`, `SessionAuth` — отдельной итерацией                                                                                                                                           |

### Про `login_attempts` / `locked_until`

В ревью от 18.11 упомянуто, что поля `login_attempts` / `locked_until` «уже есть в схеме». **В `sqlupdate.txt` их нет**, и `AUTH_PROTOCOL.md` §0.6 прямо говорит: «Чего в Треке А нет — осознанно: `revoked_tokens`, `force_reload`, `login_attempts` / `locked_until`, rate-limit, `audit_log`, PHP-админка `/settings`, `check_org_key` / `get_org_users`».

Значит:

- Поля отсутствуют, добавлять их только ради админки — расширение схемы, не согласованное.
- Rate-limit реализуем **файловым способом**, как уже сделано для `org_key` (см. `admin_tennat_seting.md`, раздел «Ограничение перебора»). Прецедент есть, схема не трогается.
- Если в будущем Трек А получит `login_attempts` / `locked_until` (для SPA) — `SessionAuth` переключится на них точечно, интерфейс `UserRepositoryInterface` расширится.

---

## 2. Архитектура

### 2.1. Структура файлов

```
company/
├── setting.php                    ← точка входа
└── admin/
    ├── Support/
    │   ├── Bootstrap.php          ← инициализация, сессия, роутинг
    │   ├── Container.php          ← минимальный DI-контейнер
    │   ├── Router.php             ← dispatch($page, $action)
    │   ├── View.php               ← рендер шаблонов
    │   ├── Csrf.php
    │   └── Flash.php
    ├── Services/
    │   ├── SessionAuth.php
    │   ├── AuditService.php
    │   ├── RateLimiter.php        ← файловый, по прецеденту _orgkey
    │   ├── SettingsService.php
    │   ├── OrgKeyService.php
    │   └── SpultMonitorService.php
    ├── Repositories/
    │   ├── Contracts/
    │   │   ├── UserRepositoryInterface.php
    │   │   ├── SettingsRepositoryInterface.php
    │   │   └── SpultEventsRepositoryInterface.php
    │   └── Db/
    │       ├── DbUserRepository.php
    │       ├── DbSettingsRepository.php
    │       └── DbSpultEventsRepository.php
    ├── Controllers/
    │   ├── BaseController.php
    │   ├── AuthController.php
    │   ├── DashboardController.php
    │   ├── UsersController.php
    │   ├── SettingsController.php
    │   └── SpultController.php
    ├── Config/
    │   └── routes.php
    ├── Views/
    │   ├── layout.php
    │   ├── auth/login.php
    │   ├── dashboard.php
    │   ├── users/{list,form}.php
    │   ├── settings.php
    │   └── spult/{events,quarantine,failed}.php
    └── assets/
        └── adminlte/              ← вендоринг до прода
```

### 2.2. Слои и зависимости

```
Controller
   ├── depends on → Service (SessionAuth, SettingsService, …)
   ├── depends on → View
   └── depends on → AuditService

Service
   ├── depends on → RepositoryInterface   ← ШОВ для Трека Б
   └── depends on → DB (для транзакций)

Repository (Db\*)
   └── depends on → App\Database\DB (PDO)

Router
   ├── depends on → Config/routes.php
   └── depends on → Container

Bootstrap
   ├── depends on → Tenant::fromRequest()
   ├── depends on → App\Database\DB::forTenant($tenant)
   └── depends on → Container (биндинги)
```

### 2.3. Шов для Трека Б

**Единственная точка замены** при переезде на Node.js API — реализация репозиториев.

```
Сегодня:
  Container::bind(UserRepositoryInterface, → DbUserRepository(DB))

Если появится API:
  Container::bind(UserRepositoryInterface, → ApiUserRepository(HttpClient))
```

`SessionAuth`, контроллеры, Views, `Router`, `Csrf` — не меняются. Интерфейсы фиксированы с самого начала, чтобы это был реальный шов, а не декларация.

**Trade-off:** интерфейс возвращает `?array` (сырую строку БД), а не DTO. Это coupling на схему `lift_users`: `ApiUserRepository` обязан вернуть массив с теми же ключами (`user_id`, `user_password`, `user_block`, `user_role`, …). Приемлемо для текущего объёма; DTO — отдельной итерацией при реальном старте Трека Б.

### 2.4. Инициализация (`company/setting.php`)

Порядок:

1. `define('APP_ENTRY_POINT', true)` — иначе `bootstrap.php` и `autoload.php` отдадут 404.
2. `require bootstrap.php` — окружение, логгер, error handler, `Europe/Moscow`.
3. Регистрация второго `spl_autoload_register` для `Company\Admin\`.
4. `Bootstrap::run()` — сессия, тенант, контейнер, CSRF-проверка, роутинг.

### 2.5. Роутинг

Формат: `?page=<page>&action=<action>` (по умолчанию `page=dashboard`, `action=index`).

Карта маршрутов — в `Config/routes.php`. Ключ — `"<page>.<action>"`, значение — `[ControllerClass, method]`. Неизвестный маршрут — 404 с `Logger::warning('admin route not found', …)` (для видимости сканирования).

| Page        | Action           | Что делает                       |
| ----------- | ---------------- | -------------------------------- |
| `login`     | `index`          | Форма входа / обработка POST     |
| `logout`    | `index`          | Выход (только POST с CSRF)       |
| `dashboard` | `index`          | Виджеты + быстрые ссылки         |
| `users`     | `index`          | Список пользователей             |
| `users`     | `create`         | Форма создания                   |
| `users`     | `edit`           | Форма редактирования             |
| `users`     | `save`           | POST: создать/обновить           |
| `users`     | `toggle_block`   | POST: блокировать/разблокировать |
| `settings`  | `index`          | Форма настроек `lift_options`    |
| `settings`  | `save`           | POST: сохранить                  |
| `settings`  | `rotate_org_key` | POST: сгенерировать новый ключ   |
| `spult`     | `events`         | Журнал `spult_events`            |
| `spult`     | `quarantine`     | Файлы из `_spult/quarantine/`    |
| `spult`     | `failed`         | Файлы из `_spult/failed/`        |
| `spult`     | `download`       | Скачать файл (валидация пути)    |

### 2.6. Автозагрузка

`autoload.php` проекта регистрирует только `App\` → `App/`. `Company\Admin\` регистрируется отдельным `spl_autoload_register` в `company/setting.php` — существующий автозагрузчик **не правим**.

---

## 3. Безопасность

### 3.1. Сессия

| Параметр                | Значение                                  |
| ----------------------- | ----------------------------------------- |
| Имя cookie              | `LIFTCS_ADMIN`                            |
| `HttpOnly`              | ✅                                        |
| `Secure`                | ✅ при HTTPS                              |
| `SameSite`              | `Strict`                                  |
| Lifetime                | 8 часов                                   |
| `session_regenerate_id` | При логине и логауте (защита от fixation) |

При каждом запросе `SessionAuth::user()`:

1. Берёт `user_id` из `$_SESSION`.
2. Читает пользователя из БД.
3. Проверяет `user_role === 'administrator'` и `user_block != 1`.
4. Если не совпало — `logout()` и редирект на `?page=login`.

**Следствие:** заблокированный или разжалованный админ вылетает на следующем запросе, а не ждёт истечения сессии.

### 3.2. CSRF

- Токен — 32 случайных байта hex, хранится в `$_SESSION['csrf_token']`.
- Скрытое поле `_csrf` в каждой форме.
- Проверка на **каждом** POST до входа в контроллер.
- Ротация: после успешного логина, **после логаута**, после смены `org_key`, после смены пароля.
- Несовпадение → `403`, без выполнения действия.

**Логаут:** `Csrf::rotate()` **до** `session_regenerate_id(true)` (или полный `$_SESSION = []` перед regenerate) — иначе `csrf_token` переживёт regenerate, и старый токен останется валидным.

### 3.3. Пароли

- Чтение — `App\Support\Password::verify` (bcrypt / argon2 / phpass / md5).
- Запись — `Password::hash` (bcrypt).
- Авто-миграция при успешном логине: `needsRehash` → `hash` → `updatePasswordHash`.

### 3.4. Доступ через `.htaccess`

- Секция 4 `.htaccess` блокирует все `.php` кроме белого списка. `company/setting.php` **обязан** быть в белом списке — иначе панель не откроется вообще (403).
- Все остальные `.php` внутри `company/admin/` **не входят** в белый список: они подключаются только через `require` из `setting.php`, прямой HTTP-доступ к ним не нужен и не должен работать.
- Секция 1 `.htaccess` (запрет на директории `config/ App/ logs/ uploads/ cr/`) дополняется `company/admin/` — на случай, если белый список секции 4 будет расширен в будущем.
- Static-ассеты (`company/admin/assets/adminlte/…`) — не `.php`, секцией 4 не задеваются.

### 3.5. Доступ к файлам СПульт

`quarantine/` и `failed/` физически вне webroot (`domains/_spult/…`). Скачивание:

- Только через `?page=spult&action=download&file=<name>&tab=quarantine|failed`.
- Проверка: `basename($file) === $file` (без `..`, без слэшей).
- Проверка: `$tab` в whitelist `['quarantine', 'failed']`.
- Проверка: `realpath($path)` начинается с `realpath($baseDir)` ожидаемого каталога.
- `Content-Type: application/xml`, `Content-Disposition: attachment`.
- Действие пишется в `audit_log` как `spult.download` с именем файла.

### 3.6. XSS и SQL

- Все выводы в Views — через `htmlspecialchars($value, ENT_QUOTES, 'UTF-8')`. Исключений нет.
- Только prepared statements через `DB`. Прямых конкатенаций в SQL нет.

В `DbUserRepository::findByLogin()` — **два отдельных prepared-запроса по ветке `if`**, без интерполяции `$field` в SQL.

### 3.7. Аудит

`audit_log` заполняется через `AuditService::log($action, $params, $userId?)`. Таблица создаётся миграцией `sqlupdate.txt`.

| Поле         | Значение                                                                                                                                              |
| ------------ | ----------------------------------------------------------------------------------------------------------------------------------------------------- |
| `user_id`    | Из сессии (или 0 для неудачного логина)                                                                                                               |
| `action`     | `admin.login`, `admin.login_failed`, `admin.login_locked`, `admin.logout`, `user.toggle_block`, `settings.update`, `org_key.rotate`, `spult.download` |
| `params`     | JSON с деталями (без паролей, без `org_key`)                                                                                                          |
| `created_at` | `time()`                                                                                                                                              |

`audit_log` — append-only. Никаких UPDATE/DELETE через админку.

### 3.8. Rate-limit логина

**Файловый, по прецеденту `_orgkey`** (см. `admin_tennat_seting.md`, раздел «Ограничение перебора»). Схема `lift_users` **не расширяется**.

| Параметр                      | Значение                                                           |
| ----------------------------- | ------------------------------------------------------------------ |
| Порог                         | 5 неудачных попыток                                                |
| Окно                          | 15 минут (от первой неудачи, не скользящее)                        |
| Ключ счётчика                 | `sha256(tenant_id . ':' . REMOTE_ADDR)`                            |
| Хранение                      | Файлы в `domains/_adminlogin/`, вне webroot                        |
| Успех                         | Счётчик сбрасывается                                               |
| Заблокированный вход          | Отказ **без проверки пароля**, сообщение идентично обычному отказу |
| X-Forwarded-For               | Не используется (подделывается)                                    |
| Недоступный каталог состояния | Fail-open: вход не блокируется, `Logger::warning`                  |

**Порядок в `SessionAuth::attempt()`:**

1. `RateLimiter::isLocked($tenant, $ip)` → если да — `return false`, `audit_log.admin.login_locked`.
2. `findByLogin($login)`.
3. Если `user === null` → dummy-`Password::verify($password, DUMMY_HASH)` (выравнивание времени) → `RateLimiter::hit()` → `return false`.
4. Если `Password::verify` = `false` → `RateLimiter::hit()` → `audit_log.admin.login_failed` → `return false`.
5. Если `true` → `RateLimiter::reset()` → `audit_log.admin.login` → остальная логика (block, role, rehash).

`RateLimiter` — сервис с методами `isLocked(string $key): bool`, `hit(string $key): void`, `reset(string $key): void`. Состояние — файлы `<sha256>.json` в `_adminlogin/` (`{count, first_hit_at}`). Чистка — cron (`cron_cleanup.php` расширяется правилом «удалить файлы старше 1 суток»).

### 3.9. Обработка исключений

`Tenant::fromRequest()` — отдельный `try/catch` (404 при ошибке, без вывода деталей).

Всё после получения `$tenant` (включая `DB::forTenant`, построение контейнера, рендер) — обёрнуто в `try/catch`:

```
try {
    $db = DB::forTenant($tenant);
    $container = buildContainer($db);
    … весь дальнейший run …
} catch (\Throwable $e) {
    Logger::error('admin bootstrap fatal', ['exception' => $e::class, 'message' => $e->getMessage()]);
    http_response_code(500);
    header('Content-Type: text/html; charset=utf-8');
    echo 'Внутренняя ошибка. Попробуйте позже.';  // без стека
    return;
}
```

### 3.10. Content-Type

`header('Content-Type: text/html; charset=utf-8')` — сразу после `session_start()`, до любого вывода. Снимает зависимость от `default_charset` в ini хостинга.

---

## 4. Разделы

### 4.1. Дашборд (`?page=dashboard`)

Виджеты:

| Виджет                | Источник                                                                      |
| --------------------- | ----------------------------------------------------------------------------- |
| Открытые заявки       | `SELECT COUNT(*) FROM lift_calls WHERE call_status = 0`                       |
| Всего пользователей   | `SELECT COUNT(*) FROM lift_users WHERE user_hiden = 0`                        |
| Ошибки СПульт за 24 ч | `SELECT COUNT(*) FROM spult_events WHERE created_at > NOW() - INTERVAL 1 DAY` |
| Файлы в карантине     | `scandir(_spult/quarantine/)` минус `.` и `..`                                |

Быстрые ссылки: «Создать пользователя» (`?page=users&action=create`), «Настройки» (`?page=settings`), «Мониторинг СПульт» (`?page=spult&action=events`).

Виджет с ошибками СПульт: если `count > 0` — выделение цветом, ссылка на `?page=spult&action=events`.

### 4.2. Пользователи (`?page=users`)

проектируем под дальнейшее внедрение системы многоурвневых прав и групп доступа.

#### Список

Колонки: `ID`, `ФИО`, `Логин`, `Роль` (`user_role`), `Должность` (`user_position`), `Статус` (Активен / Заблокирован / Скрыт).

Фильтры: по роли, по статусу блокировки, поиск по ФИО/логину.

Пагинация: 50 на страницу.

Действия:

- «Создать» — кнопка над таблицей.
- «Редактировать» — в строке.
- «Заблокировать» / «Разблокировать» — POST с CSRF.

#### Форма (create / edit)

Поля:

| Поле                           | Обязательность                          | Примечание                                                                                                   |
| ------------------------------ | --------------------------------------- | ------------------------------------------------------------------------------------------------------------ |
| `user_name`                    | ✅                                      | Полное ФИО                                                                                                   |
| `user_surname`                 | ❌                                      | Для сборки `name` в API                                                                                      |
| `user_firstname`               | ❌                                      |                                                                                                              |
| `user_patronymic`              | ❌                                      |                                                                                                              |
| `user_login`                   | ✅                                      | Уникальный                                                                                                   |
| `user_email`                   | ❌                                      | Уникальный (если заполнен)                                                                                   |
| `user_role`                    | ✅                                      | `administrator`, `dispatcher`, `engineer`, `guest`                                                           |
| `user_position`                | ❌                                      | `admin`, `dispatcher`, `foreman`, `mechanic`, `dispatch_equipment_mechanic`, `electronics_engineer`, `guest` |
| `user_password`                | ✅ при создании / ❌ при редактировании | При редактировании пусто = не менять                                                                         |
| `allow_dispatcher_quick_login` | ❌                                      | Чекбокс; спец-поле                                                                                           |
| `user_hiden`                   | ❌                                      | Чекбокс; скрыть из списков                                                                                   |

**Пароль при создании:** админ вводит вручную. При сохранении — `Password::hash`. После создания показать flash «Пользователь создан. Пароль: <открытый текст> — сохраните, он больше не будет показан.» Это единственный способ, потому что в БД хранится только хеш. Принудительная смена при первом входе — **не реализуется** (флага в БД нет).

**При редактировании:** поле пароля пустое, с подсказкой «Оставьте пустым, чтобы не менять».

#### Мягкая блокировка

Удаления **нет**. `user_block = 1` — заблокирован. Кнопка «Заблокировать» / «Разблокировать» — POST через `?page=users&action=toggle_block&id=X` с CSRF.

#### Спец-чекбоксы

`allow_dispatcher_quick_login`:

- По умолчанию `0` в БД (после миграции `DEFAULT 0` — см. `admin_tennat_seting.md`).
- При создании, если `user_position = 'dispatcher'` — UI предлагает `1` (но не выставляет сам).
- При редактировании — чекбокс с подсказкой, если должность диспетчерская, а флаг снят.

`user_hiden`:

- По умолчанию `0`.
- При `1` пользователь не виден в списках API (`listQuickLogin` уже это учитывает).

#### `UserRepositoryInterface`

| Метод                                                  | Назначение                                                    |
| ------------------------------------------------------ | ------------------------------------------------------------- |
| `findById(int $id): ?array`                            | Уже есть                                                      |
| `findByLogin(string $login): ?array`                   | Уже есть                                                      |
| `updatePasswordHash(int $id, string $hash): void`      | Уже есть                                                      |
| `list(array $filters, int $page, int $perPage): array` | Список с пагинацией (расширение)                              |
| `count(array $filters): int`                           | Всего для пагинации (расширение)                              |
| `create(array $data): int`                             | INSERT, возврат `user_id` (расширение)                        |
| `update(int $id, array $data): void`                   | UPDATE без пароля (расширение)                                |
| `toggleBlock(int $id): bool`                           | Переключить `user_block`, вернуть новое значение (расширение) |

Методы rate-limit **не входят** в интерфейс — файловый `RateLimiter` работает независимо от БД.

### 4.3. Настройки (`?page=settings`)

#### Поля `lift_options`

| `option_name`             | `type`     | `change_allowed` | Примечание                     |
| ------------------------- | ---------- | ---------------- | ------------------------------ |
| `spult_organization_name` | `text`     | 1                |                                |
| `admin_email`             | `text`     | 1                | Добавляется миграцией (см. §8) |
| `city_default`            | `text`     | 1                |                                |
| `city_separator`          | `text`     | 1                |                                |
| `XML_add`                 | `checkbox` | 1                |                                |
| `spult_pult_guid`         | `text`     | 1                |                                |

Остальные ключи в форме **не показываются** (технические, `change_allowed=0`). Исключение — `org_key`.

#### `org_key`

- Читается из `lift_options WHERE option_name='org_key' ORDER BY id DESC LIMIT 1` (новейшая строка).
- Отображается открыто, с кнопкой «Сгенерировать новый».
- Формат `XXXX-XXXX-XXXX`, алфавит `ABCDEFGHJKLMNPQRSTUVWXYZ23456789` (32 символа без `0/O`, `1/I`).
- Смена ключа: **не рвёт сессии** (ключ для входа, выданные токены от него не зависят).
- Предупреждение при смене: «Старый ключ перестанет работать для входа. Диспетчеры, сохранившие его в браузере, не смогут быстро войти — им нужно сообщить новый.»
- Аудит: `org_key.rotate` с `params: {"new_key_masked": "XXXX-…-WXYZ"}`.

**Не секрет:** `org_key` даёт доступ только к списку ФИО + ID диспетчеров для быстрого входа (см. `admin_tennat_seting.md`). Утечка не критична. Хранится открыто, `hash_equals` — при сравнении (timing-safe). Нормализация кириллических двойников — в `OrgKeyService`.

#### `SettingsService`

| Метод                         | Назначение                                     |
| ----------------------------- | ---------------------------------------------- |
| `getEditableOptions(): array` | Ключи из белого списка с `change_allowed=1`    |
| `save(array $data): void`     | Валидация + upsert в транзакции                |
| `rotateOrgKey(): string`      | Сгенерировать, записать, вернуть открытый ключ |

#### `SettingsRepositoryInterface`

| Метод                                       | Назначение                   |
| ------------------------------------------- | ---------------------------- |
| `getByNames(array $names): array`           | `option_name → option_value` |
| `upsert(string $name, string $value): void` | По `option_name` (UNIQUE)    |

### 4.4. Мониторинг СПульт (`?page=spult`)

Три вкладки внутри раздела: `events`, `quarantine`, `failed`. По умолчанию — `events`.

#### `events`

Таблица `spult_events`:

| Колонка      | Источник                                           |
| ------------ | -------------------------------------------------- |
| Дата         | `created_at`                                       |
| Тип          | `kind`                                             |
| Лифт         | `lift_id`                                          |
| Заявка       | `ticket_id` (со ссылкой на SPA-карточку если есть) |
| Адрес из XML | `xml_address`                                      |
| Адрес в БД   | `db_address`                                       |
| Сообщение    | `message`                                          |
| Файл         | `spool_file` (ссылка на скачивание, если не NULL)  |

Фильтры: по `kind`, по `lift_id`, по периоду (1 / 7 / 30 дней). Пагинация — 50 на страницу.

#### `quarantine` и `failed`

Листинг каталогов `domains/_spult/quarantine/` и `domains/_spult/failed/`:

- Для каждого файла `.xml` — попытка прочитать `<file>.xml.meta.json`.
- Колонки: имя файла, дата модификации, причина (из meta или из `spult_events.message` по `spool_file`), кнопка «Скачать XML».

**Доступ к каталогам — только из PHP** (`scandir`, `file_get_contents`). HTTP-доступа к каталогам нет (вне webroot). Скачивание через `?page=spult&action=download` с валидацией пути (§3.5).

#### `SpultMonitorService`

| Метод                                                        | Назначение                        |
| ------------------------------------------------------------ | --------------------------------- |
| `listEvents(array $filters, int $page, int $perPage): array` | Выборка из `spult_events`         |
| `countEvents(array $filters): int`                           | Для пагинации                     |
| `listSpoolFiles(string $subdir): array`                      | `scandir` + meta.json + fallback  |
| `readSpoolFile(string $subdir, string $filename): ?string`   | С проверкой basename и `realpath` |

`$subdir` — строго `'quarantine'` или `'failed'` (whitelist в сервисе, не из GET).

#### `SpultEventsRepositoryInterface`

| Метод                                                  | Назначение    |
| ------------------------------------------------------ | ------------- |
| `list(array $filters, int $page, int $perPage): array` | Выборка       |
| `count(array $filters): int`                           | Для пагинации |

---

## 5. Детали реализации

### 5.1. Контейнер

Минимальный DI: `bind(string $id, callable $factory)`, `get(string $id): mixed`. Singleton-инстансы на запрос. `Router` автовайрит контроллеры по типам аргументов конструктора.

**Autowire:** пропускать параметры с `$param->isDefaultValueAvailable()` → `$param->getDefaultValue()`. Для union/intersection типов — `RuntimeException` с понятным текстом (для ядра все зависимости — конкретные классы/интерфейсы без scalar-параметров).

### 5.2. `Bootstrap::run()` — порядок

1. `startSession()` — с жёсткими cookie-параметрами.
2. `header('Content-Type: text/html; charset=utf-8')`.
3. `Tenant::fromRequest()` — 404 при ошибке (без вывода деталей клиенту).
4. **Далее — `try/catch` вокруг всего:**
   1. `DB::forTenant($tenant)`.
   2. Построение контейнера (биндинги).
   3. `SessionAuth::check()` — если не админ, редирект на `?page=login` (кроме `page=login`).
   4. CSRF-проверка (если POST).
   5. `Router::dispatch($page, $action)`.

При исключении — generic 500 + `Logger::error('admin bootstrap fatal', …)`, без стека наружу.

### 5.3. Шаблон Layout

- `layout.php` — обёртка с header, sidebar, main.
- `auth/login.php` — **без** layout (отдельный шаблон).
- Views разделов — вставляются в `$content` внутри `layout.php`.
- Flash-сообщения рендерятся в layout (для всех страниц кроме login).
- Меню sidebar: Дашборд, Пользователи, Настройки, СПульт.

### 5.4. `View::renderFile()` — защита

- После построения `$path` — `realpath($path)` должен начинаться с `realpath(__DIR__ . '/../Views/')`. Иначе — `RuntimeException` (defensive против будущего рефакторинга, когда `$name` может прийти из пользовательского ввода).
- Комментарий в шаблоне: `$this` — экземпляр `View`, не вызывать `$this->renderFile(...)` (рекурсия).

### 5.5. AdminLTE 4

- На старте — CDN (`cdn.jsdelivr.net/npm/admin-lte@4/…`).
- До прода — вендоринг в `company/admin/assets/adminlte/`.
- Смена пути — правка одной строки в `layout.php` и `auth/login.php`.

### 5.6. `Router::dispatch()` — логирование 404

Перед `http_response_code(404)` — `Logger::warning('admin route not found', ['page' => $page, 'action' => $action])`. Видно сканирование.

---

## 6. Что НЕ делаем

| Что                                                              | Почему                                              |
| ---------------------------------------------------------------- | --------------------------------------------------- |
| JWT в PHP-админке                                                | Трек Б не утверждён; `$_SESSION` достаточно         |
| `ApiClient` / HTTP-клиент к API                                  | Появится, если/когда появится API                   |
| Интерфейсы для сервисов, Views, Router                           | Замены не будет; только репозитории — шов           |
| Просмотр/редактирование `ds_*` (диспетчеризация)                 | В ТЗ не входит; в будущем — отдельно                |
| Иерархия групп                                                   | В `bisness.md` — плоские, в админку не входят       |
| Массовые операции над пользователями                             | В бэклоге                                           |
| Экспорт пользователей                                            | В бэклоге                                           |
| Принудительная смена пароля при первом входе                     | Флага в БД нет; показ пароля в flash после создания |
| Расширение `lift_users` полями `login_attempts` / `locked_until` | Rate-limit файловый, схема не трогается             |
| Автогенерация пароля                                             | Админ вводит вручную                                |

---

## 7. Переходные меры

| Мера                                                 | Когда снять                                                                                            |
| ---------------------------------------------------- | ------------------------------------------------------------------------------------------------------ |
| `admin_email` в `lift_options` добавляется миграцией | Остаётся навсегда                                                                                      |
| CDN для AdminLTE                                     | После вендоринга в `assets/adminlte/`                                                                  |
| Флаг `legacy_compat` не учитывается                  | Остаётся как есть; Трек А на MariaDB                                                                   |
| `Password::needsRehash` для MD5                      | Остаётся — легаси-пароли в БД                                                                          |
| Файловый rate-limit                                  | Остаётся; при появлении `login_attempts`/`locked_until` в `lift_users` (Трек Б) — переключение точечно |

---

## 8. Порядок выкатки

| Шаг | Действие                                                                                                                                                                                                        |
| --- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| 0   | **Патч `.htaccess`**: секция 4 — добавить `company/setting.php` в белый список; секция 1 — добавить `company/admin/`. Без этого шага панель отдаёт 403                                                          |
| 1   | Миграция: добавить `admin_email` в `lift_options` (`type=text`, `change_allowed=1`); выставить `change_allowed=1` у `org_key`; создать каталог `domains/_adminlogin/` (права 0750, владелец — пользователь PHP) |
| 2   | Выложить `company/` (setting.php + admin/)                                                                                                                                                                      |
| 3   | Проверить доступ: `https://<tenant>.liftcs.ru/company/setting.php`                                                                                                                                              |
| 4   | Войти под администратором; проверить `audit_log` (должны быть `admin.login`)                                                                                                                                    |
| 5   | Прогнать приёмку по чек-листу §9                                                                                                                                                                                |
| 6   | Вендоринг AdminLTE в `assets/adminlte/` и переключение с CDN                                                                                                                                                    |
| 7   | Unit-тесты на `OrgKeyService`, `Csrf`, `SessionAuth`, `RateLimiter` — отдельной итерацией                                                                                                                       |

### Миграция `admin_email`

```sql
INSERT INTO `lift_options` (`option_name`, `option_value`, `name`, `comment`, `change_allowed`, `type`)
SELECT
    'admin_email',
    '',
    'Email администратора',
    'Email админа организации для оповещений о сбоях СПульт. Несколько — через запятую.',
    1,
    'text'
FROM DUAL
WHERE NOT EXISTS (
    SELECT 1 FROM `lift_options` WHERE `option_name` = 'admin_email'
);

UPDATE `lift_options` SET `change_allowed` = 1 WHERE `option_name` = 'org_key';
```

---

## 9. Приёмка

### 9.1. Авторизация

- [ ] `?page=dashboard` без сессии → редирект на `?page=login`
- [ ] `?page=login` с формой, POST с неверным паролем → flash «Неверный логин или пароль», `audit_log.admin.login_failed`
- [ ] POST с верным паролем под `administrator` → редирект на `?page=dashboard`, `audit_log.admin.login`
- [ ] POST с верным паролем под `dispatcher` → отказ, `audit_log.admin.login_failed`
- [ ] POST с верным паролем под `administrator` + `user_block=1` → отказ
- [ ] После логина `session_id` изменился (regenerate)
- [ ] Logout через `?page=logout` (POST с CSRF) → сессия очищена, редирект на login
- [ ] Заблокировать админа в БД (`user_block=1`) → следующий запрос выкидывает на login
- [ ] Сменить `user_role` на `dispatcher` в БД → следующий запрос выкидывает на login

### 9.2. Пользователи

- [ ] Создание пользователя: все обязательные поля → запись в `lift_users`, пароль захеширован (`$2y$…`)
- [ ] Создание с существующим `user_login` → ошибка валидации
- [ ] Редактирование без пароля → пароль не меняется
- [ ] Редактирование с паролем → хеш обновился
- [ ] Toggle block: `user_block` меняется 0 ↔ 1
- [ ] `user_hiden=1` → пользователь не виден в `listQuickLogin`
- [ ] `allow_dispatcher_quick_login=1` при `user_position='dispatcher'` → попадает в список быстрого входа SPA
- [ ] Удаление пользователя нигде не доступно (нет action, нет кнопки)
- [ ] Каждое действие (создание/редактирование/toggle) → запись в `audit_log`

### 9.3. Настройки

- [ ] Форма показывает только `change_allowed=1` ключи + `org_key`
- [ ] Сохранение `spult_organization_name`, `admin_email`, `city_default`, `city_separator`, `XML_add`, `spult_pult_guid` → upsert
- [ ] `XML_add` как checkbox: снят → `0`, поставлен → `1`
- [ ] Смена `org_key` — предупреждение перед сохранением, после смены новая строка в `audit_log.org_key.rotate`
- [ ] Смена `org_key` не рвёт существующие сессии SPA (проверить вручную)
- [ ] Пустое значение `org_key` → функция быстрого входа выключена (проверить через `check_org_key` в SPA)

### 9.4. Мониторинг СПульт

- [ ] `?page=spult&action=events` — таблица с событиями, пагинация, фильтр по `kind`
- [ ] `?page=spult&action=quarantine` — листинг файлов + причина из meta.json или из `spult_events`
- [ ] `?page=spult&action=failed` — аналогично
- [ ] Кнопка «Скачать XML» → файл отдан с `Content-Disposition: attachment`
- [ ] Скачивание с `file=../bootstrap.php` → 403
- [ ] Скачивание с `file=../../config/admin.php` → 403
- [ ] Скачивание с `tab=../../etc` → 403
- [ ] Скачивание с `file=nonexistent.xml` → 404
- [ ] Каждое скачивание → `audit_log.spult.download` с именем файла
- [ ] `curl -I` на прямой URL файла карантина → 403/404 (вне webroot)

### 9.5. Общее

- [ ] CSRF: POST без `_csrf` → 403, действие не выполнено
- [ ] CSRF: POST с неверным `_csrf` → 403
- [ ] Все POST имеют скрытое поле `_csrf`
- [ ] Logout → старый CSRF-токен не работает при повторном использовании формы
- [ ] Прямой GET на неизвестный `page` (`?page=../../etc/passwd`) → 404, в `logs/app.log` — `admin route not found`
- [ ] XSS: имя пользователя с `<script>` → выводится как текст
- [ ] Виджеты дашборда соответствуют данным в БД
- [ ] Меню sidebar работает для всех разделов
- [ ] `curl -I` → `Content-Type: text/html; charset=utf-8`
- [ ] OPcache: после правки PHP — перезапуск PHP в панели хостинга (см. `AUTH_PROTOCOL.md` §0.10), приёмка на свежем байткоде

### 9.6. Доступ через `.htaccess`

- [ ] `https://<tenant>.liftcs.ru/company/setting.php` → 200 (не 403)
- [ ] `https://<tenant>.liftcs.ru/company/admin/Support/Bootstrap.php` → 403
- [ ] `https://<tenant>.liftcs.ru/company/admin/Config/routes.php` → 403
- [ ] `https://<tenant>.liftcs.ru/company/admin/Views/layout.php` → 403
- [ ] `https://<tenant>.liftcs.ru/company/admin/assets/adminlte/…css` → 200 (static не заблокирован)
- [ ] `https://<tenant>.liftcs.ru/company/` (директория) → 403 или 404, не листинг

### 9.7. Rate-limit

- [ ] 1–4 неудачи → счётчик растёт, вход возможен
- [ ] 5 неудач → файл состояния в `_adminlogin/` содержит `count=5`, вход блокируется на 15 минут
- [ ] Заблокированный вход: верный пароль → всё равно отказ с тем же сообщением «Неверный логин или пароль», `audit_log.admin.login_locked`
- [ ] Через 15 минут: верный пароль → вход, файл состояния удалён
- [ ] Неверный логин (`findByLogin === null`) → время ответа сравнимо с неверным паролем (визуально по `curl --write-out '%{time_total}'` для 10 запросов)
- [ ] Каталог `_adminlogin/` недоступен для записи → вход **не блокируется** (fail-open), в лог — `Logger::warning`

### 9.8. Обработка ошибок

- [ ] Остановить MariaDB тенанта → заход на `setting.php` → 500, generic-сообщение, в `logs/app.log` — запись `admin bootstrap fatal` с классом исключения
- [ ] Битый `Host` (`evil.com`, apex) → 404, без 500 и без записи в лог (как в API)

### 9.9. Смоук-проверка после выкатки

- [ ] Один администратор тенанта входит, создаёт одного диспетчера, редактирует настройку, разлогинивается
- [ ] В `audit_log` — четыре записи: `admin.login`, `user.create`, `settings.update`, `admin.logout`

---

## 10. Открытые вопросы

| №   | Вопрос                                               | Решение                                                                                                         |
| --- | ---------------------------------------------------- | --------------------------------------------------------------------------------------------------------------- |
| 1   | Принудительная смена пароля при первом входе         | Нет (флага в БД нет); показ пароля в flash после создания                                                       |
| 2   | Пагинация в `spult_events`                           | 50 на страницу, фильтры по `kind` / `lift_id` / периоду                                                         |
| 3   | Показ виджета «Закрепления механиков» на дашборде    | Появится, если/когда появятся закрепления в БД                                                                  |
| 4   | Unit-тесты                                           | Отдельной итерацией: `OrgKeyService`, `Csrf`, `SessionAuth`, `RateLimiter`                                      |
| 5   | Каталог `_adminlogin/` — отдельный или в `_alerts/`? | Отдельный (`_adminlogin/`), по аналогии с `_orgkey/` — чтобы cron-чистка правил отдельно и TTL у файлов разные  |
| 6   | Чистка `_adminlogin/` в cron                         | Расширить `cron_cleanup.php` правилом «удалить файлы старше 1 суток» — отдельной итерацией, не блокирует запуск |

---

## 11. Что осталось за рамками

| Плоскость                                        | Отдельный документ                                                  |
| ------------------------------------------------ | ------------------------------------------------------------------- |
| Platform Admin (super admin)                     | `ADMIN_PLATFORM.md` (не создан)                                     |
| Отчёты и экспорт                                 | `REPORTS.md` (не создан)                                            |
| Массовые операции с пользователями               | Бэклог                                                              |
| Трек Б (Node.js API)                             | `bisness.md` §Трек Б                                                |
| Группы лифтов и закрепления                      | `bisness.md` §3.3–3.4                                               |
| DTO для репозиториев                             | При реальном старте Трека Б                                         |
| `login_attempts` / `locked_until` в `lift_users` | Если Трек А получит их для SPA — `SessionAuth` переключится точечно |

---

## Приложение А: Реестр отличий от v1.0

| Раздел | Что изменилось                                                                                       |
| ------ | ---------------------------------------------------------------------------------------------------- |
| §1     | +6 строк (14–19), блок «Про `login_attempts`/`locked_until`»                                         |
| §2.3   | +trade-off про `?array`                                                                              |
| §3.4   | новый (доступ через `.htaccess`)                                                                     |
| §3.8   | новый (rate-limit файловый)                                                                          |
| §3.9   | новый (обработка исключений)                                                                         |
| §3.10  | новый (Content-Type)                                                                                 |
| §4.2   | `UserRepositoryInterface` расширен 5 методами (было 3 — уже есть; rate-limit методы не в интерфейсе) |
| §5.1   | Autowire с default-значениями                                                                        |
| §5.2   | try/catch, Content-Type                                                                              |
| §5.4   | path-traversal defensive                                                                             |
| §5.6   | Router 404 с логом                                                                                   |
| §8     | шаг 0 (.htaccess), миграция `admin_email` и `change_allowed` для `org_key`                           |
| §9     | +4 блока (9.6–9.9), дополнения в 9.1 и 9.5                                                           |
| §10    | +2 пункта (5, 6)                                                                                     |

---

**Конец ORGANIZATION_ADMIN.md v1.1.**
