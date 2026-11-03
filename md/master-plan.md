# `MASTER_PLAN.md` — обновлённая версия (часть 1: разделы 1–6)

**Версия:** 3.0  
**Дата:** 01.11.2026  
**Статус:** Утверждено к реализации  
**Заменяет:** фрагменты АРХИТЕКТУРНЫЙ*ДОКУМЕНТ.txt (разделы о стеке и плане), Технический стек и ресурсы VPS, DevOps, план работ  
**Связанные документы:** bisness.md (архитектура), СТРУКТУРА*БАЗЫ_ДАННЫХ.txt (модель данных), API_PROTOCOL.md v4.1 (контракт API), AUTH_PROTOCOL.md, OFFLINE_PROTOCOL.md, TECHNICAL_DEBT.md

---

## Содержание

1. Контекст и цели
2. Текущее состояние (as-is)
3. Целевая архитектура (to-be)
4. Стек и инфраструктура
5. Сетевая схема и домены
6. Миграционная стратегия
7. Админ-панель тенанта (PHP)
8. DevOps
9. Безопасность
10. Полный план работ по фазам
11. Риски и митигация
12. Открытые вопросы
13. Приложение А: API.md (ссылка + сводка изменений)

---

## 1. Контекст и цели

### 1.1. Что есть

- **`e-rcs.ru`** — самое старое legacy (PHP + MariaDB), работающий тенант **sh**.
- **`liftcs.ru`** — более новый PHP + MariaDB, существующий код с адаптером к `e-rcs.ru` (`LegacyProxyService`).
- **Диспетчерский фронт** (SPA/PWA, ванильный JS + Vite) — единый для всех тенантов.
- **`admin.liftcs.ru`** — глобальная админка управления организациями (не трогаем).
- **RUVDS VPS** — закупается для нового API.
- **Jino** — хостинг PHP (`liftcs.ru`, `*.liftcs.ru`), статика и legacy PHP.

### 1.2. Что делаем — двухтрековая стратегия

#### Трек А (урезанный PHP, временный)

- Доделать существующий PHP-код на `liftcs.ru` с минимальным функционалом для быстрого запуска нового тенанта **l3**.
- Запуск на поддомене `l3.liftcs.ru` с отдельной БД MariaDB.
- **Срок жизни:** 6–8 месяцев (до готовности нового бэкенда).
- **Цель:** дать диспетчерам привыкнуть к новому интерфейсу, не дожидаясь полной реализации.
- **Скоуп:** авторизация (админ, диспетчер, механик), создание/просмотр/закрытие заявок, комментарии, поиск по номеру, фильтры, исключение Аварийной службы, экспорт PDF/Excel, адресный справочник.
- **НЕ входит** (техдолг): группы лифтов, права по группам, контрагенты, офлайн, фото, закрепление механиков как отдельная сущность, массовый перенос лифтов, тонкая настройка прав.

#### Трек Б (новый Node.js API, основной)

- Новый API на Node.js + PostgreSQL (`api.liftcs.ru`) с **schema-per-tenant** (каждый тенант — отдельная схема PostgreSQL).
- **Прокси-роутер** на `liftcs.ru` — маршрутизирует запросы по тенантам (`e_rcs` / `l3_trimmed` / `new_api`).
- **Тенантская админка на PHP** (`tenant.liftcs.ru/settings`) — тонкий клиент к API.
- Тенанты на урезанном коде переносятся на новый бэкенд с миграцией **только открытых заявок**. Закрытые заявки остаются в архиве MariaDB.
- Все будущие тенанты создаются сразу на новом бэкенде.

### 1.3. Что НЕ делаем

- ~~Полная миграция legacy-тенантов в первом этапе~~ — они остаются на `sh.e-rcs.ru`, доступ через прокси на `sh.liftcs.ru`.
- ~~Параллельная запись~~ — стратегия «чистого старта» для новых тенантов.
- ~~Strangler Fig для постепенного перевода~~ — мгновенное переключение по готовности нового API.
- Мастер-адресация (`AddressProvider` закладывается, `MasterApiAddressProvider` — позже).
- Роль «Связист» как полноценная сущность с заявками по типу 24 (закладывается через `user_position`, логика — позже).
- Иерархия групп (плоские, без подгрупп).
- S3 для фото — техдолг, локальный диск на старте.

### 1.4. Принципы

- **Двухтрековая разработка** — Трек А (урезанный PHP для быстрого запуска) и Трек Б (новый API для основной функциональности).
- **Урезанный код как временный мост** — не вкладываем в него лишнего, только то, что нужно для работы l3-тенанта.
- **Архитектура с учётом будущего переезда** — даже в урезанном PHP учитываем, что через 6–8 месяцев перейдём на новый стек.
- **Schema-per-tenant в PostgreSQL** — каждый тенант = отдельная схема, подключение переключается по поддомену.
- **Прокси-роутер только для legacy** — `sh.liftcs.ru` проксирует на `sh.e-rcs.ru`, новые тенанты работают напрямую.
- **Своя БД на тенант** — принцип сохраняется и в новом стеке (через schemas).
- **Бизнес-логика — только в API.** PHP-админка и прокси — тонкие.
- **Новый тенант сразу на новом бэкенде** (кроме l3 — временно на Треке А).
- **PostgreSQL — единственный источник истины** для нового API.
- **Redis — эфемерный.** Потеря Redis не ломает данные.
- **Домены стабильны, IP — деталь.** `api.liftcs.ru` — контракт.
- **Секреты — изолированы.** Отдельная таблица, шифрование, аудит.
- **Аудит — append-only.** Никто не удаляет.

---

## 2. Текущее состояние (as-is)

```
Браузер (legacy sh-тенант)              Браузер (новый l3-тенант)
sh.liftcs.ru/                            l3.liftcs.ru/
   │                                        │
   ▼                                        ▼
┌──────────────────────────────┐    ┌──────────────────────────────┐
│ Jino: liftcs.ru              │    │ Jino: liftcs.ru (тот же)     │
│  └── Прокси-роутер (PHP)     │    │  └── Урезанный PHP-бэкенд    │
│       sh → e-rcs.ru          │    │       (Трек А)               │
└───────────┬──────────────────┘    └──────────────┬───────────────┘
            │                                       │
            ▼                                       ▼
   ┌──────────────────────┐              ┌──────────────────────┐
   │ sh.e-rcs.ru (legacy) │              │ MariaDB              │
   │ + MariaDB            │              │ (БД l3-тенанта)      │
   └──────────────────────┘              └──────────────────────┘
```

**Проблемы:**

- Бизнес-логика размазана: чтения — в `liftcs.ru`, записи — в `e-rcs.ru`.
- Нет единой модели прав (легаси-флаги `user_edit_obj`, `user_disppermission`).
- Нет групп лифтов, закрепления механиков как сущности.
- Нет аудита (только `lift_history` по заявкам).
- Нет чёткого разделения ролей и должностей.
- Новый тенант l3 не может ждать полной реализации нового API — нужен быстрый запуск.

---

## 3. Целевая архитектура (to-be)

```
┌─────────────────────────┐         ┌─────────────────────────────────┐
│ Браузер (legacy sh)     │         │ Браузер (новый l3)              │
│ sh.liftcs.ru/           │         │ l3.liftcs.ru/                   │
└───────────┬─────────────┘         └───────────────┬─────────────────┘
            │ HTTPS (JSON, Bearer)                  │ HTTPS (JSON, Bearer)
            ▼                                       ▼
┌──────────────────────────────────┐   ┌──────────────────────────────┐
│ Jino: liftcs.ru                  │   │ Jino: liftcs.ru (тот же)     │
│  └── Прокси-роутер (PHP)         │   │  └── Урезанный PHP-бэкенд    │
│       sh.liftcs.ru → sh.e-rcs.ru │   │       (Трек А, расширенный)  │
└───────────┬──────────────────────┘   └──────────────┬───────────────┘
            │                                         │
            ▼                                         ▼
   ┌──────────────────────┐                ┌──────────────────────┐
   │ sh.e-rcs.ru (legacy) │                │ MariaDB              │
   │ + MariaDB            │                │ (БД l3-тенанта)      │
   └──────────────────────┘                └──────────────────────┘

┌──────────────────────────────────────────────────────────────────────┐
│ RUVDS VPS                                                            │
│  ┌─────────────────────────────────────────────────────────────┐     │
│  │ Новый API (Node.js + Fastify)                               │     │
│  │  ├── Схема tenant_sh (когда legacy переедет)                │     │
│  │  ├── Схема tenant_l3 (когда l3 переедет)                    │     │
│  │  └── Схема tenant_X (новые тенанты)                         │     │
│  └─────────────────────────────────────────────────────────────┘     │
│                              │                                       │
│  ┌───────────────────────────▼─────────────────────────────────┐     │
│  │ PostgreSQL (один инстанс, schema-per-tenant)                 │     │
│  │  public: tenants, tenant_migrations, lift_city/street/home  │     │
│  └─────────────────────────────────────────────────────────────┘     │
│  ┌─────────────────────────────────────────────────────────────┐     │
│  │ Redis (кэш прав, сессии)                                     │     │
│  └─────────────────────────────────────────────────────────────┘     │
└──────────────────────────────────────────────────────────────────────┘
```

### 3.1. Ключевые компоненты

| Компонент              | Где                         | Роль                                        |
| ---------------------- | --------------------------- | ------------------------------------------- |
| **SPA/PWA**            | `tenant.liftcs.ru/`         | Диспетчерский фронт, офлайн                 |
| **Прокси-роутер**      | `liftcs.ru` (PHP)           | Маршрутизация по тенанту и action           |
| **Тенантская админка** | `tenant.liftcs.ru/settings` | Управление пользователями, правами, лифтами |
| **Новый API**          | `api.liftcs.ru` (RUVDS)     | Единая бизнес-логика (schema-per-tenant)    |
| **Legacy e-rcs**       | `e-rcs.ru`                  | Старые тенанты (sh), пока не мигрируют      |
| **Урезанный PHP**      | `l3.liftcs.ru` (Jino)       | Временный мост для l3-тенанта (Трек А)      |
| **Глобальная админка** | `admin.liftcs.ru`           | Управление организациями (не трогаем)       |

### 3.2. Принцип работы прокси-роутера

```php
// Псевдокод
$tenant = resolve_tenant();       // по поддомену
$action = match_route($_SERVER['REQUEST_URI']);
$backend = routes($tenant, $action);

switch ($backend) {
    case 'e_rcs':      include 'adapters/e-rcs.php';      break;
    case 'liftcs':     include 'legacy/api.php';          break;
    case 'l3_trimmed': include 'l3/api.php';              break;   // Трек А
    case 'new_api':    forward_to('https://api.liftcs.ru', $action, $payload, $auth); break;
}
```

**Правило:** тенант целиком на одном бэкенде. Переключение мгновенное — смена маршрута в прокси.

**Таблица маршрутов — конфиг, не код:**

```php
return [
    'sh'   => ['*' => 'e_rcs'],           // legacy, через прокси
    'l3'   => ['*' => 'l3_trimmed'],      // урезанный PHP (Трек А)
    'test' => ['*' => 'new_api'],         // тестовый на новом API
    // будущие тенанты сразу на new_api
];
```

### 3.3. Schema-per-tenant в новом API

**Принцип:** каждый тенант = отдельная схема PostgreSQL.

**Структура:**

```
liftcalls (одна БД)
├── public                          ← общее для всех тенантов
│   ├── tenants                     (реестр тенантов)
│   ├── tenant_migrations           (лог миграций по схемам)
│   ├── lift_city                   ← ЕДИНОЕ АДРЕСНОЕ ПРОСТРАНСТВО
│   ├── lift_street
│   ├── lift_home
│   └── object_fields_description
├── tenant_sh                       ← данные тенанта sh
│   ├── lift_users
│   ├── lift_calls                  (FK → public.lift_home)
│   ├── lift_object                 (FK → public.lift_home)
│   ├── elevator_groups
│   ├── user_group_access
│   ├── user_elevator_assignment
│   ├── lift_types
│   ├── audit_log
│   └── ...
├── tenant_l3                       ← данные тенанта l3
│   └── (то же самое)
└── tenant_X                        ← новые тенанты
    └── (то же самое)
```

**Подключение:**

1. Прокси-роутер определяет тенант по поддомену.
2. Запрос к API с заголовком `X-Tenant: l3` (или JWT `tenant_id`).
3. API в транзакции: `SET LOCAL search_path TO tenant_l3, public`.
4. Все последующие запросы — в рамках этой схемы.

**Плюсы:**

- Изоляция данных между тенантами.
- Простой бэкап: `pg_dump -n tenant_l3`.
- Простая миграция: применить миграции на каждую схему отдельно.
- Совместимость с принципом «своя БД на тенант».
- **Единое адресное пространство** — общие адреса в `public.lift_city/street/home`, доступны всем тенантам, FK на уровне БД.
- **Один пул соединений** — критично для VPS 4 ГБ RAM.

**Системные таблицы** (реестр тенантов, лог миграций, справочники, адреса) — в схеме `public`.

**Миграции:**

```bash
# Применить миграции на все схемы
node scripts/migrate-all.js

# Или на конкретную схему
npx knex migrate:latest --env=tenant_l3
```

---

## 4. Стек и инфраструктура

### 4.1. Стек нового API

| Слой          | Технология              | Версия    | Обоснование                                    |
| ------------- | ----------------------- | --------- | ---------------------------------------------- |
| Runtime       | Node.js                 | 22 LTS    | Один язык с фронтом                            |
| Язык          | JavaScript (ESM)        | —         | Без TypeScript на старте                       |
| Фреймворк     | Fastify                 | 4.x       | Встроенная валидация, плагины                  |
| СУБД          | PostgreSQL              | 16        | JSONB, partial unique index, schema-per-tenant |
| Драйвер       | `pg`                    | 8.x       | Стандартный                                    |
| Query builder | Knex.js                 | 3.x       | SQL виден, миграции, `searchPath`              |
| Кэш           | Redis                   | 7.x       | PermissionsCache, revoked_tokens, rate-limit   |
| Reverse proxy | Nginx                   | stable    | TLS, rate-limit, gzip                          |
| Контейнеры    | Docker + Compose        | 27.x / v2 | Воспроизводимость                              |
| TLS           | Let's Encrypt (certbot) | —         | Автообновление                                 |
| Cron          | `node-cron`             | —         | Бэкапы, архивация фото                         |
| Логи          | `pino`                  | —         | JSON-логи                                      |
| PDF           | `pdfkit`                | —         | Экспорт отчётов (Трек А и новый API)           |
| Excel         | `exceljs`               | —         | Экспорт отчётов (Трек А и новый API)           |

**Обязательные пакеты:** `fastify`, `@fastify/cors`, `@fastify/jwt`, `@fastify/rate-limit`, `@fastify/multipart`, `@fastify/helmet`, `@fastify/swagger`, `@fastify/swagger-ui`, `pg`, `knex`, `ioredis`, `dotenv`, `pino`, `node-cron`, `pdfkit`, `exceljs`.

**Не используем:** TypeScript (на старте), NestJS, Prisma, Express, Varnish, Memcached, Kubernetes.

### 4.2. Инфраструктура

**Провайдер:** RUVDS (Москва).  
**ОС:** Debian 12 (bookworm) — соло-разработчик знаком с Debian через Raspbian.

**Стартовая конфигурация:**

| Параметр  | Значение           |
| --------- | ------------------ |
| CPU       | 2 × 3.4 ГГц        |
| RAM       | 4 ГБ (+ swap 2 ГБ) |
| Диск      | 50 ГБ NVMe         |
| IP        | 1 публичный        |
| Стоимость | ~1500–1800 ₽/мес   |

**Рост:** RUVDS позволяет менять CPU/RAM/диск на лету (стандартные тарифы). Акционный тариф — фиксирован, но можно перейти на «свою конфигурацию» без пересоздания сервера. Ограничение: NVMe-системный диск + доп. HDD — совместимость уточнить при заказе.

**Целевая инфраструктура (при росте):**

| VPS | Роль            | CPU | RAM  | Диск       |
| --- | --------------- | --- | ---- | ---------- |
| 1   | Edge (Nginx)    | 1   | 1 ГБ | 20 ГБ      |
| 2   | App (Node)      | 2   | 2 ГБ | 40 ГБ      |
| 3   | DB (PostgreSQL) | 2   | 4 ГБ | 80 ГБ NVMe |
| 4   | Cache (Redis)   | 1   | 2 ГБ | 20 ГБ      |
| 5   | Backup          | 1   | 1 ГБ | 200 ГБ     |

**Правило:** БД и Redis — **без публичного IP**. Доступ только через внутреннюю сеть.

### 4.3. Фото

**Старт (техдолг):** локальный диск `/opt/liftcalls/uploads`, монтируется в контейнер.

**Правило с первого дня:** монтировать `./uploads` с хоста в контейнер (не писать в слой образа). При пересборке образа файлы не теряются.

**Позже:** S3-совместимое хранилище (Selectel Object Storage, Backblaze B2, Yandex Object Storage) или второй диск на VPS через MinIO. Абстракция `StorageProvider` (как `AddressProvider`) позволит переключиться без переписывания кода.

---

## 5. Сетевая схема и домены

### 5.1. Домены

| Домен             | Куда                 | Назначение                                  |
| ----------------- | -------------------- | ------------------------------------------- |
| `liftcs.ru`       | Jino                 | Прокси-роутер, статика SPA, legacy PHP      |
| `*.liftcs.ru`     | Jino                 | Поддомены тенантов (SPA + `/settings`)      |
| `sh.liftcs.ru`    | Jino (прокси)        | Legacy sh, прокси на `sh.e-rcs.ru`          |
| `l3.liftcs.ru`    | Jino (PHP)           | Урезанный PHP (Трек А)                      |
| `api.liftcs.ru`   | **RUVDS** (A-запись) | Новый API                                   |
| `admin.liftcs.ru` | Jino (уже есть)      | Глобальная админка организаций (не трогаем) |

**TTL A-записи `api.liftcs.ru`:** 300 секунд (для быстрой миграции между провайдерами).

**TLS:**

- `liftcs.ru`, `*.liftcs.ru` — Wildcard Let's Encrypt от Jino (оставляем).
- `api.liftcs.ru` — отдельный сертификат на RUVDS через `certbot --nginx -d api.liftcs.ru`.

### 5.2. Порты и доступ

| Порт                   | Где   | Доступ                         |
| ---------------------- | ----- | ------------------------------ |
| 22 (или нестандартный) | RUVDS | Только whitelist IP + SSH-ключ |
| 80, 443                | RUVDS | Публичный                      |
| 3000 (Node)            | RUVDS | Только 127.0.0.1               |
| 5432 (PostgreSQL)      | RUVDS | Только docker network          |
| 6379 (Redis)           | RUVDS | Только docker network          |

### 5.3. CORS

SPA (`tenant.liftcs.ru`) → `api.liftcs.ru` — **cross-site**. Нужен CORS:

```js
await app.register(cors, {
  origin: (origin, cb) => {
    if (!origin) return cb(null, true);
    if (/^https:\/\/([a-z0-9-]+\.)*liftcs\.ru$/.test(origin))
      return cb(null, true);
    if (origin === "http://localhost:5173") return cb(null, true);
    return cb(new Error("Not allowed by CORS"), false);
  },
  credentials: false, // Bearer, не cookies
  methods: ["GET", "POST", "PUT", "DELETE", "PATCH", "OPTIONS"],
  allowedHeaders: ["Content-Type", "Authorization", "X-Tenant"],
  maxAge: 86400,
});
```

**Никогда** `origin: true` или `*` в продакшене.

Админка (`tenant.liftcs.ru/settings`) → `api.liftcs.ru` — запросы с PHP-сервера, **CORS не нужен**.

### 5.4. CSP

SPA (`index.html`):

```
default-src 'self';
script-src 'self';
style-src 'self' 'unsafe-inline';
img-src 'self' data: https://api.liftcs.ru;
connect-src 'self' https://api.liftcs.ru;
frame-ancestors 'none';
```

Админка (`/settings`):

```
default-src 'self';
script-src 'self';
style-src 'self';
img-src 'self' data:;
connect-src 'self';
frame-ancestors 'none';
```

### 5.5. Мультитенантность в API

**Определение тенанта:**

1. **JWT `tenant_id`** — основной способ (после логина).
2. **`X-Tenant` header** — fallback для `login` (прокси-роутер передаёт).
3. **`org_key` в теле** — только для `login`, `check_org_key`, `get_org_users`.

**Приоритет:** JWT → `X-Tenant` → `org_key`.

**Если ни один не определён** → 401 `tenant_not_resolved`.

---

## 6. Миграционная стратегия

### 6.1. Принципы

- **Новые тенанты** создаются сразу на новом API (PostgreSQL, schema-per-tenant).
- **Тенанты на урезанном коде (Трек А)** переносятся на новый API через 6–8 месяцев.
- **Legacy-тенанты (sh)** продолжают работать через прокси, миграция — по готовности.
- **Миграция только открытых заявок** (закрытые остаются в архиве MariaDB).
- **Переключение мгновенное** — смена маршрута в прокси-роутере.
- **Параллельная запись не используется** — стратегия «чистого старта».

### 6.2. Этапы для тенантов на урезанном коде (l3)

```
T-30 дней:  Подготовка (новый API готов для всех нужных функций тенанта)
T-7 дней:   Снизить TTL A-записи api.liftcs.ru до 300s (уже сделано)
T-3 дня:    Тестовая миграция на staging (dry run)
T-0 (ночь): 1. Остановка записи в урезанный PHP (read-only)
            2. Миграция данных: MariaDB → PostgreSQL (схема tenant_l3)
            3. Переключение routes('l3') → new_api
            4. Проверка /health, логин, создание тестовой заявки
            5. Открытие для пользователей
T+1 день:   Мониторинг
T+7 дней:   Проверка стабильности
T+30 дней:  Урезанный PHP остаётся только как архив (если нужен)
```

**Простой:** 15–30 минут (при малой БД).

### 6.3. Что мигрирует (только для l3-тенанта)

| Данные                   | Откуда                        | Куда                                          |
| ------------------------ | ----------------------------- | --------------------------------------------- |
| Пользователи             | `lift_users` (MariaDB)        | `lift_users` (PostgreSQL, схема `tenant_l3`)  |
| Группы                   | — (создать «Без группы»)      | `elevator_groups`                             |
| Лифты                    | `lift_object`                 | `lift_object` + `core` + `extra` + `dispatch` |
| Адреса                   | `lift_city/street/home`       | `lift_city/street/home` (в `public`)          |
| **Открытые заявки**      | `lift_calls` (`status=0`)     | `lift_calls`                                  |
| **Комментарии открытых** | `lift_notes`                  | `lift_notes`                                  |
| **История открытых**     | `lift_history`                | `lift_history`                                |
| Справочники              | — (уже в новом API)           | `lift_types`                                  |
| ~~Закрытые заявки~~      | ~~`lift_calls` (`status=1`)~~ | ~~НЕ мигрируем (архив)~~                      |
| ~~Фото~~                 | ~~—~~                         | ~~НЕ мигрируем (их не будет)~~                |

**Миграция идемпотентна.** Скрипт можно запускать повторно.

### 6.4. Что нельзя перенести автоматически

- `user_edit_obj`, `user_edit_user`, `user_disppermission`, `user_add_call`, `user_read_all_calls` — мигрируют в `user_group_access.base_permissions` / `extra_permissions` по маппингу (см. отдельный документ миграции).
- `abbreviated_name` (SPult ID) — переносится как есть.
- `user_position` — вычисляется из `user_role` (см. таблицу маппинга).
- **Хэши паролей** — переносятся как есть (Bcrypt с авто-миграцией из MD5/phpass).

### 6.5. Откат

**В прокси:** `routes('l3')` → `l3_trimmed` (урезанный PHP).

**Данные:**

- Данные, созданные в новом API после переключения, остаются в PostgreSQL.
- Заявки, созданные в урезанном PHP после отката, идут в MariaDB.
- Reconciliation — ручной или скриптом (перенос из PostgreSQL в MariaDB за период).

**Поэтому:** перед переключением — финальная проверка, что всё работает. Откат — крайняя мера.

### 6.6. Архив закрытых заявок

Закрытые заявки l3-тенанта остаются в MariaDB после перехода на новый API.

**Доступ к архиву:**

- Отдельный прокси или фронтенд для архива (реализуется позже).
- Или доступ только через админку (по запросу к админу).
- Решение принимается позже, не блокирует основной релиз.

---

# `MASTER_PLAN.md` — обновлённая версия (часть 2: разделы 7–13)

---

## 7. Админ-панель тенанта (PHP)

### 7.1. Расположение

`tenant.liftcs.ru/settings` — на том же поддомене, что SPA, но в отдельной директории.

**Структура:**

```
tenant.liftcs.ru/
├── index.html           ← SPA
├── assets/
├── sw.js
├── manifest.json
├── uploads/
├── settings/            ← PHP-админка
│   ├── index.php
│   ├── login.php
│   ├── logout.php
│   ├── users/
│   ├── groups/
│   ├── objects/
│   ├── contractors/
│   ├── audit/
│   ├── reports/         ← экспорт PDF/Excel (Трек А и новый API)
│   ├── lib/
│   │   ├── ApiClient.php
│   │   ├── Session.php
│   │   └── Auth.php
│   └── templates/
└── .htaccess
```

### 7.2. Авторизация

**Независимая от SPA** (не SSO на старте):

- Админ логинится в `/settings/login.php` — PHP отправляет `POST /auth/login` в API, сохраняет токены в `$_SESSION`.
- Каждый запрос админки: PHP берёт токен из сессии, шлёт в API.
- Если 401 — PHP пытается обновить через refresh. Если и refresh истёк — редирект на логин.
- JWT **не хранится в браузере** — только `PHPSESSID` (httpOnly, secure, SameSite=Lax).

**CSRF:** токен на каждую форму, проверка на сервере.

### 7.3. `ApiClient.php`

Тонкий клиент к API (по образцу `LegacyProxyService`):

- `get/post/put/delete`;
- таймауты (5 сек read, 10 сек write);
- `JSON_THROW_ON_ERROR`;
- логирование без токенов;
- авто-refresh при 401 (один раз, без циклов);
- **передача `X-Tenant` header** (из поддомена, в котором работает админка);
- **для отчётов** — поддержка `Accept: application/pdf` и `application/vnd.openxmlformats-officedocument.spreadsheetml.sheet` (бинарь).

### 7.4. Что админка делает

| Страница                           | Эндпоинты API                                                |
| ---------------------------------- | ------------------------------------------------------------ |
| `/settings/login.php`              | `POST /auth/login`                                           |
| `/settings/users/`                 | `GET /users`                                                 |
| `/settings/users/edit.php`         | `GET /users/:id`, `POST /users/:id`, `POST /users/:id/block` |
| `/settings/users/access.php`       | `GET/POST/DELETE /users/:id/access`                          |
| `/settings/groups/`                | `GET/POST /groups`, `POST /groups/:id`, `DELETE /groups/:id` |
| `/settings/objects/`               | `GET /objects`, `POST /objects/:id/update`                   |
| `/settings/objects/assign.php`     | `POST /objects/:id/assign-mechanic` / `unassign-mechanic`    |
| `/settings/contractors/`           | `GET/POST /contractors`                                      |
| `/settings/audit/`                 | `GET /audit`                                                 |
| **`/settings/reports/`**           | **`GET /reports/calls/search`**                              |
| **`/settings/reports/export.php`** | **`GET /reports/calls/export/pdf` / `excel`**                |

**Правило:** админка не имеет своей БД. Вся логика — в API.

### 7.5. Старший диспетчер в админке

Если у пользователя есть `can_create_dispatchers` / `can_edit_dispatchers` / `can_block_dispatchers`:

- в меню `/settings` появляется пункт «Диспетчеры»;
- `/settings/users/` показывает только диспетчеров (не всех);
- `/settings/users/edit.php` позволяет редактировать только диспетчеров;
- `POST /users` — только `role='dispatcher'`, `position='dispatcher'`.

**Проверки делает API** (Policy-слой), админка только скрывает кнопки.

---

## 8. DevOps

### 8.1. Первичная настройка VPS

1. `apt update && upgrade`
2. Пользователь `deploy`, SSH-ключи, root-login отключён, `PasswordAuthentication no`
3. `ufw` (22/80/443), `fail2ban`, `unattended-upgrades`
4. Swap 2 ГБ, `vm.swappiness=10`
5. `timedatectl set-timezone Europe/Moscow`
6. Docker + Compose
7. Nginx + certbot
8. `postgresql-client-16` (для `pg_dump`)
9. Директории `/opt/liftcalls/*`

### 8.2. Docker Compose (старт)

```yaml
services:
  api:
    build: ./app
    restart: unless-stopped
    env_file: .env
    expose: ["3000"]
    volumes:
      - ./uploads:/app/uploads
      - ./logs:/app/logs
    depends_on:
      db: { condition: service_healthy }
      cache: { condition: service_healthy }
    networks: [internal]
    logging: { driver: json-file, options: { max-size: "10m", max-file: "5" } }
    healthcheck:
      {
        test: ["CMD", "wget", "-qO-", "http://127.0.0.1:3000/health"],
        interval: 30s,
      }

  db:
    image: postgres:16-alpine
    restart: unless-stopped
    env_file: .env
    volumes: [pgdata:/var/lib/postgresql/data, ./backups:/backups]
    expose: ["5432"]
    networks: [internal]

  cache:
    image: redis:7-alpine
    restart: unless-stopped
    command:
      [
        "redis-server",
        "--appendonly",
        "yes",
        "--maxmemory",
        "512mb",
        "--maxmemory-policy",
        "allkeys-lru",
      ]
    volumes: [redisdata:/data]
    expose: ["6379"]
    networks: [internal]

networks:
  internal: { driver: bridge, internal: true }

volumes:
  pgdata:
  redisdata:
```

Nginx — **на хосте** (не в Docker), для простоты certbot.

### 8.3. PostgreSQL tuning (4 ГБ RAM)

```ini
shared_buffers = 1GB
effective_cache_size = 2GB
work_mem = 16MB
maintenance_work_mem = 256MB
max_connections = 50
wal_buffers = 16MB
checkpoint_completion_target = 0.9
random_page_cost = 1.1
effective_io_concurrency = 200
```

### 8.4. Деплой

```bash
cd /opt/liftcalls/app && git pull
cd /opt/liftcalls && docker compose build api
docker compose exec api node scripts/migrate-all.js   # миграции на все схемы
docker compose up -d --no-deps --build api
curl -f https://api.liftcs.ru/health
```

**Простой:** 2–5 секунд. Для B2B приемлемо.

**Откат:** `git checkout <prev>` + `docker compose build api && up -d`.

### 8.5. Бэкапы

| Что                   | Куда              | Частота        | Хранение  |
| --------------------- | ----------------- | -------------- | --------- |
| `pg_dump` (все схемы) | S3 + локально     | Ежедневно 3:00 | 30 дней   |
| `pg_dump -n tenant_X` | S3                | Еженедельно    | 30 дней   |
| WAL (continuous)      | S3                | Непрерывно     | 7 дней    |
| Фото                  | S3 или второй VPS | Еженедельно    | 30 дней   |
| Конфиги               | Приватный Git     | При изменении  | Бессрочно |

**Правило:** бэкап, который не проверяли, — не бэкап. Раз в месяц — восстановление на staging.

### 8.6. Мониторинг

- **Uptime Kuma** — `GET /health` каждые 60 сек, алерт в Telegram.
- **`docker stats`** — RAM/CPU.
- **`pg_stat_statements`** — медленные запросы.
- **`pino` + Docker json-file** — логи API.
- **logrotate** — Nginx, API.

### 8.7. Health-check

`GET /health` → `{ status: 'ok', db: 'ok', cache: 'ok' }` или 503.

**Расширенный health-check для schema-per-tenant:**

- проверка `SELECT 1` в `public`;
- проверка `SELECT 1` в схеме хотя бы одного активного тенанта;
- проверка `PING` к Redis.

### 8.8. Schema-per-tenant: управление

#### Создание нового тенанта

```bash
# 1. Создать схему
psql -U postgres -d liftcalls -c "CREATE SCHEMA tenant_X;"

# 2. Применить миграции на схему
node scripts/migrate-tenant.js --tenant=X

# 3. Создать системную группу «Без группы»
node scripts/create-default-group.js --tenant=X

# 4. Добавить в таблицу маршрутов прокси-роутера
# 'X' => ['*' => 'new_api']

# 5. Зарегистрировать в public.tenants
psql -U postgres -d liftcalls -c "
  INSERT INTO public.tenants (subdomain, schema_name, status, schema_version)
  VALUES ('X', 'tenant_X', 'active', '1.100');
"
```

#### Бэкап конкретного тенанта

```bash
pg_dump -U postgres -n tenant_X -F c liftcalls > tenant_X.backup
```

#### Восстановление тенанта

```bash
pg_restore -U postgres -d liftcalls -n tenant_X tenant_X.backup
```

**Важно:** если восстанавливаете на новом сервере — сначала `public` (там `tenants` и адреса), потом схему тенанта.

#### Удаление тенанта (после переноса на другой инстанс)

```bash
psql -U postgres -d liftcalls -c "DROP SCHEMA tenant_X CASCADE;"
psql -U postgres -d liftcalls -c "DELETE FROM public.tenants WHERE subdomain='X';"
```

#### Миграции всех схем

```bash
# scripts/migrate-all.js
# - SELECT subdomain, schema_name FROM public.tenants WHERE status='active'
# - для каждой схемы: knex.migrate.latest({ searchPath: [schema, 'public'], pool: { max: 1 } })
# - при ошибке в одной схеме — продолжаем остальные, логируем
# - обновляем public.tenants.schema_version
node scripts/migrate-all.js
```

---

## 9. Безопасность

1. **Секреты в `.env`**, `chmod 600`, не в Git. `JWT_SECRET` (≥ 32 байт), `CRYPTO_KEY` (32 байта base64), `POSTGRES_PASSWORD`.
2. **TLS** — Let's Encrypt, HSTS после стабилизации, CAA-запись.
3. **CORS** — только allowlist `*.liftcs.ru`, разрешён `X-Tenant` в `allowedHeaders`.
4. **Rate-limit** — Nginx: 5 r/m на `/auth/*`, 30 r/s на остальное. Fastify — дополнительно на чувствительные эндпоинты и на экспорт отчётов (10 r/h).
5. **Revoked tokens** — при смене прав, блокировке, logout. `force_reload` + `revoked_tokens` + `PermissionsCache` инвалидация.
6. **CSRF** — обязателен для `/settings/*`.
7. **Секреты диспетчеризации** — отдельная таблица `lift_object_dispatch`, шифрование через `Crypto`, маскирование в API, аудит просмотра (`objectDispatchReveal`).
8. **`audit_log`** — append-only, даже админ не удаляет.
9. **Пользователи** — не удаляются, только блокируются.
10. **Docker** — контейнеры не от root, `internal` network изолирована.
11. **Schema-per-tenant** — `search_path` только через `SET LOCAL` в транзакции; тест на изоляцию в CI (записал в A, прочитал из B → пусто).
12. **Обновления** — `unattended-upgrades` (ОС), `npm audit` (пакеты), пересборка базовых образов раз в месяц.

---

## 10. Полный план работ по фазам

**Итого:** ~38–55 рабочих дней для одного разработчика с частичной занятостью — **3–4 месяца календарно**. MVP (фазы 0.5, 0–5) — 2–3 недели чистой работы.

### Фаза 0.5. Урезанный PHP для l3-тенанта (Трек А) — 5–7 дней

**Задачи:**

- [ ] Развернуть существующий PHP-код на `l3.liftcs.ru`.
- [ ] Создать отдельную БД MariaDB для l3-тенанта.
- [ ] Настроить `Tenant.php` для определения l3 по поддомену.
- [ ] Доделать существующий функционал:
  - [ ] Поиск заявок по номеру.
  - [ ] Фильтры: лифт, дом, механик, период.
  - [ ] Исключение Аварийной службы (`is_emergency`).
  - [ ] Экспорт в PDF и Excel.
- [ ] Добавить поле `is_emergency` в `lift_calls`.
- [ ] Добавить поле `call_number` в `lift_calls`.
- [ ] Создать таблицу `reports` (сохранение параметров отчётов).
- [ ] Настроить архивное хранилище для закрытых заявок (будет использоваться после переезда на новый API).
- [ ] Тестовые данные: 3–5 пользователей, 10 лифтов, 20 заявок.

**Критерии готовности:**

- l3-тенант работает на `l3.liftcs.ru`.
- Можно авторизоваться, создавать заявки, искать по фильтру.
- Экспорт в PDF/Excel работает.
- Код учитывает будущий переезд на новый API (те же названия сущностей).

### Фаза 0. VPS + настройка + прокси-роутер для sh — 1–2 дня

- [ ] Закупка VPS RUVDS (2×3.4 / 4 ГБ / 50 ГБ NVMe)
- [ ] Настройка сервера по чек-листу (8.1)
- [ ] DNS `api.liftcs.ru` → IP VPS, TTL 300
- [ ] `certbot --nginx -d api.liftcs.ru`
- [ ] **Прокси-роутер на `liftcs.ru`** с поддержкой `e_rcs`, `l3_trimmed`, `new_api` (тонкий, без нового API пока)
- [ ] Прокси-адаптер `e-rcs` обернуть как бэкенд роутера (не переписывать)
- [ ] Таблица маршрутов: `sh → e_rcs`, `l3 → l3_trimmed`, `test → liftcs` (пока)
- [ ] Git-репозиторий `liftcalls-infra` (приватный): `.env.example`, `docker-compose.yml`, `nginx/*`, `scripts/*`

**Критерий:** `curl https://api.liftcs.ru` → 502 (Nginx работает, API нет). Фронт sh-тенанта работает через роутер, l3-тенант работает на Треке А.

### Фаза 1. Каркас API — 2–3 дня

- [ ] `npm init`, Fastify + плагины
- [ ] `GET /health` (заглушка)
- [ ] Dockerfile + `docker-compose.yml`
- [ ] Подключение к PostgreSQL (`pg` + Knex), `SELECT 1` в `public`
- [ ] Подключение к Redis, `PING`
- [ ] `GET /health` → реальные проверки db/cache
- [ ] Деплой на VPS

**Критерий:** `curl https://api.liftcs.ru/health` → `{ status: 'ok', db: 'ok', cache: 'ok' }`.

### Фаза 2. Схема БД и миграции (schema-per-tenant) — 3–4 дня

- [ ] Миграции для `public`: `tenants`, `tenant_migrations`, `lift_city`, `lift_street`, `lift_home`, `object_fields_description`
- [ ] Миграции для схем тенантов: `lift_users`, `lift_calls`, `lift_notes`, `lift_history`, `lift_object`, `lift_object_core/extra/dispatch`, `elevator_groups`, `user_group_access`, `user_elevator_assignment`, `audit_log`, `revoked_tokens`, `contractors`, `lift_types`, `lift_options`, `offline_sync_log`, `object_visibility_history`
- [ ] Partial unique index на `user_elevator_assignment`
- [ ] `CHECK` / `ENUM` для `assignment_type`, `offline_sync_log.status`, `user_position`
- [ ] `scripts/migrate-all.js` — цикл по схемам тенантов
- [ ] `scripts/create-tenant.js` — создание нового тенанта
- [ ] `tenantPlugin` (Fastify) — определение тенанта по `X-Tenant` / JWT / `org_key`, `SET LOCAL search_path`
- [ ] Сиды: тенант `test`, 1 админ, 1 диспетчер, 3 лифта, 1 группа
- [ ] Проверка идемпотентности: `migrate:latest` → `rollback` → `latest`

**Критерий:** миграции применяются и откатываются; тестовые данные на месте; `tenantPlugin` корректно переключает `search_path`.

### Фаза 3. Аутентификация — 2–3 дня

- [ ] `POST /auth/login` (JWT + refresh; `tenant_id` в payload; определение тенанта по `org_key` / `X-Tenant`)
- [ ] `POST /auth/refresh`
- [ ] `POST /auth/logout` (`revoked_tokens`)
- [ ] Middleware проверки токена (+ проверка `revoked_tokens` + `force_reload`)
- [ ] `GET /me`

**Критерий:** логин → токен → защищённый эндпоинт → 200. Без токена → 401. С `X-Tenant: test` → попадает в схему `tenant_test`.

### Фаза 4. Policy-слой — 2–3 дня

- [ ] `PermissionsCache` (Redis, TTL 300, инвалидация)
- [ ] `BasePolicy` — хелперы
- [ ] `CallPolicy` — `canCreate`, `canEdit`, `canClose`, `canComment` (MVP)
- [ ] `ObjectPolicy` — `canView`, `canEdit`
- [ ] `UserPolicy` — проверки для старшего диспетчера (`can_create_dispatchers` и т.д.)
- [ ] Интеграция в middleware
- [ ] Юнит-тесты на Policy

**Критерий:** Policy вызывается на каждом защищённом эндпоинте, кэш инвалидируется.

### Фаза 5. Заявки — вертикальный срез — 3–5 дней

- [ ] `GET /calls/open` (с фильтрами, `can_edit/can_close/can_comment`)
- [ ] `POST /calls/create` (проверка `vis`, `canCreate`, `AddressProvider`)
- [ ] `POST /calls/edit` (append-only для `details`, назначение/снятие staff)
- [ ] `POST /calls/note` (без фото)
- [ ] `POST /calls/close` (с `call_fullhistory`, оптимистичная блокировка)
- [ ] `GET /calls/closed`

**Критерий:** полный цикл — создать → отредактировать → комментарий → закрыть. Всё логируется.

**Параллельно:** в прокси-роутере `test → new_api` для готовых действий. Тестовый тенант полностью на новом API.

### Фаза 6. Лифты — 2–3 дня

- [ ] `GET /objects/:id`
- [ ] `POST /objects/:id/update` (core/extra/dispatch)
- [ ] `POST /objects/:id/dispatch-reveal` (аудит)
- [ ] `POST /objects/:id/assign-mechanic` / `unassign-mechanic`
- [ ] `POST /objects/:id/assign-specialist` (связист / инженер-электронщик)
- [ ] `POST /objects/bulk-update`
- [ ] `POST /objects/set-visibility-bulk` (расторжение/возобновление договора, с датой и причиной)

**Критерий:** карточка лифта, изменение полей, закрепление механика, расторжение договора.

### Фаза 7. Группы и пользователи — 3–4 дня

- [ ] `GET /groups`, `POST /groups`, `POST /groups/:id`, `DELETE /groups/:id`
- [ ] `GET /users`, `POST /users`, `POST /users/:id/block`
- [ ] `GET/POST/PUT/DELETE /users/:id/access`
- [ ] **Проверки старшего диспетчера** (только диспетчеров, только с правами `can_*_dispatchers`)
- [ ] Принудительный выход при смене прав
- [ ] `GET/POST /contractors`

**Критерий:** админ управляет группами, правами, пользователями. Прораб создаёт механиков. Старший диспетчер создаёт/изменяет/блокирует диспетчеров. При смене прав — logout.

### Фаза 7.5. PHP-админка тенанта — 4–5 дней

- [ ] Структура `/settings` на Jino
- [ ] `ApiClient.php`, `Session.php`, `Auth.php` (+ `X-Tenant` header)
- [ ] Логин, logout, CSRF
- [ ] Список пользователей + редактирование + блокировка
- [ ] Управление правами (включая `can_create_dispatchers` и т.д.)
- [ ] Группы
- [ ] Лифты (карточка, bulk, assign-mechanic)
- [ ] Контрагенты
- [ ] Аудит
- [ ] **Экспорт отчётов** (PDF/Excel) — проксирование бинарных ответов API

**Критерий:** админ тенанта делает всё через `/settings`, не трогая SPA. Старший диспетчер видит только раздел «Диспетчеры».

### Фаза 8. Адреса и справочники — 2 дня

- [ ] `AddressProvider` (интерфейс) + `LocalAddressProvider` (читает `public.lift_city/street/home`)
- [ ] `POST /loadAddress` (с `include_hidden`, `is_hidden`, `hidden_reason`, `suspended_at`)
- [ ] `GET /config` (с `user_position`, `elevator_groups`, `can_manage_dispatchers`)
- [ ] `POST /check_org_key`
- [ ] `POST /get_org_users` (только обычные диспетчеры; старшие тоже, т.к. `user_position='dispatcher'`)

**Критерий:** SPA получает дерево адресов и конфиг. Прораб не виден в быстром входе. Скрытые лифты — с полями `is_hidden`, `hidden_reason`, `suspended_at`.

### Фаза 9. Офлайн-синхронизация — 2–3 дня

- [ ] `POST /calls/offline` (пачка до 10, транзакция, идемпотентность по `batch_id` и `offline_uuid`)
- [ ] `offline_sync_log`
- [ ] `address_not_verified` при невалидном адресе
- [ ] `POST /notifications` (поллинг)

**Критерий:** офлайн-заявки синхронизируются, повтор не создаёт дубликатов.

### Фаза 10. Отчёты и экспорт — 2–3 дня

- [ ] `GET /reports/calls/search` — поиск заявок по номеру + фильтры (лифт, дом, механик, период, статус, `exclude_emergency`)
- [ ] `GET /reports/calls/export/pdf` — экспорт в PDF (через `pdfkit`)
- [ ] `GET /reports/calls/export/excel` — экспорт в Excel (через `exceljs`)
- [ ] Фильтр `is_emergency` для исключения Аварийной службы
- [ ] Аудит экспорта (`report.export`) с параметрами фильтров
- [ ] Rate-limit на экспорт (10 запросов в час на пользователя)
- [ ] Лимит 10 000 строк, пагинация для поиска

**Критерий:** можно искать заявки по всем фильтрам, экспортировать в PDF и Excel. Аудит фиксирует параметры.

### Фаза 11. Фото (техдолг) — 1–2 дня

- [ ] `POST /calls/note` с `photo_base64`
- [ ] Сжатие (или доверить клиенту)
- [ ] Лимит 2 фото на заявку
- [ ] Локальное хранение `/opt/liftcalls/uploads`
- [ ] Cron архивации (фото старше года)

**Критерий:** фото загружается, отображается, лимит соблюдается.

### Фаза 12. Фронтенд — новые экраны — 4–5 дней

- [ ] Экран «Группы лифтов»
- [ ] Экран «Управление правами» (в `/settings`, не SPA)
- [ ] Закрепление механиков (в карточке лифта `/settings`)
- [ ] Скрытые лифты (для прорабов/админов)
- [ ] Галочка «Искать в удалённых»
- [ ] Предупреждение/запрет при заявке на скрытый лифт
- [ ] Экран «Отчёты» (поиск + экспорт)

**Критерий:** новые экраны работают, UI скрывает недоступные кнопки.

### Фаза 13. Миграция l3 на новый API — 2–3 дня

- [ ] Скрипт миграции: MariaDB (l3) → PostgreSQL (схема `tenant_l3`):
  - пользователи (хэши как есть);
  - лифты + core/extra/dispatch;
  - адреса (в `public`);
  - **открытые** заявки + комментарии + история;
  - справочники.
- [ ] Тестовая миграция на staging (dry run).
- [ ] Скрипт валидации: сравнение количества пользователей, лифтов, открытых заявок.
- [ ] Скрипт создания системной группы «Без группы».
- [ ] Обновление таблицы маршрутов прокси-роутера: `'l3' => ['*' => 'new_api']`.
- [ ] Переключение в ночное время (T-0).
- [ ] Проверка: логин, создание заявки, просмотр списка.
- [ ] Мониторинг ошибок (T+1 — T+7 дней).

**Критерий:** l3-тенант полностью работает на новом API, урезанный PHP остаётся как архив.

### Фаза 14. Мониторинг и бэкапы — 1 день

- [ ] Uptime Kuma → `/health`
- [ ] Cron `pg_dump` (все схемы + по каждой схеме) → S3 + локально
- [ ] Cron фото → S3
- [ ] Алерты в Telegram
- [ ] Проверка восстановления из бэкапа на staging

**Критерий:** при падении API — алерт в течение 2 минут. Бэкап восстанавливается.

### Фаза 15. Тестирование и документация — 3–5 дней

- [ ] Тест-кейсы по матрице прав
- [ ] **Тест на изоляцию schema-per-tenant** (записал в A, прочитал из B → пусто)
- [ ] Нагрузочный тест (`wrk` на `/health`, `/calls/open`, `/reports/calls/search`)
- [ ] Обновить `API_PROTOCOL.md` (v4.1), `AUTH_PROTOCOL.md`, `OFFLINE_PROTOCOL.md`
- [ ] `README.md` репозитория
- [ ] `MIGRATION_GUIDE.md` для перевода тенанта с MariaDB на PostgreSQL

**Критерий:** все тест-кейсы проходят, документация актуальна.

### Сводка

| Фаза                            | Длительность    | Зависит от |
| ------------------------------- | --------------- | ---------- |
| 0.5. Урезанный PHP для l3       | 5–7 дней        | —          |
| 0. VPS + прокси-роутер          | 1–2 дня         | —          |
| 1. Каркас API                   | 2–3 дня         | 0          |
| 2. Схема БД (schema-per-tenant) | 3–4 дня         | 1          |
| 3. Аутентификация               | 2–3 дня         | 2          |
| 4. Policy                       | 2–3 дня         | 3          |
| 5. Заявки                       | 3–5 дней        | 2, 4       |
| 6. Лифты                        | 2–3 дня         | 4          |
| 7. Группы/пользователи          | 3–4 дня         | 2, 4       |
| 7.5. PHP-админка                | 4–5 дней        | 3, 6, 7    |
| 8. Адреса/справочники           | 2 дня           | 2          |
| 9. Офлайн                       | 2–3 дня         | 5          |
| 10. Отчёты и экспорт            | 2–3 дня         | 5          |
| 11. Фото                        | 1–2 дня         | 5          |
| 12. Фронтенд                    | 4–5 дней        | 5, 7       |
| 13. Миграция l3 на новый API    | 2–3 дня         | 1–12       |
| 14. Мониторинг/бэкапы           | 1 день          | 1          |
| 15. Тестирование                | 3–5 дней        | всё        |
| **Итого**                       | **~38–55 дней** |            |

Для соло-разработчика с частичной занятостью — **3–4 месяца календарно**. MVP (фазы 0.5, 0–5) — 2–3 недели чистой работы.

---

## 11. Риски и митигация

| Риск                                                    | Вероятность | Влияние         | Митигация                                                                                   |
| ------------------------------------------------------- | ----------- | --------------- | ------------------------------------------------------------------------------------------- |
| ~~Ошибки миграции данных~~                              | ~~Средняя~~ | ~~Высокое~~     | _(Удалено — миграция только для l3, только открытые заявки)_                                |
| Производительность Policy-слоя                          | Низкая      | Среднее         | Кэш прав в Redis, оптимизация SQL, индексы                                                  |
| Баги в логике прав                                      | Средняя     | Высокое         | Полная матрица тестирования, code review, логирование                                       |
| Конфликты при офлайн-синхронизации                      | Низкая      | Среднее         | Идемпотентность через `offline_uuid`, транзакции                                            |
| Потеря фото при ошибке cron                             | Низкая      | Среднее         | Сначала перенос в архив, потом удаление                                                     |
| Сложность отладки прав                                  | Средняя     | Среднее         | Подробное логирование, admin-UI для просмотра прав                                          |
| ~~Проблемы при переключении с legacy~~                  | ~~Средняя~~ | ~~Высокое~~     | _(Заменено на: проблемы при переезде l3 с урезанного на новый API)_                         |
| **Проблемы при переезде l3 с урезанного на новый API**  | **Средняя** | **Высокое**     | **Тестовая миграция на staging, скрипт сравнения, возможность отката**                      |
| Утечка секретов диспетчеризации                         | Низкая      | Высокое         | Отдельная таблица, шифрование, маскирование, аудит                                          |
| Прораб попадает в список диспетчеров                    | Низкая      | Среднее         | Должностной тип `user_position` вместо проверки по роли                                     |
| ~~Прокси-роутер — единая точка отказа~~                 | ~~Высокая~~ | ~~Высокое~~     | _(Удалено — прокси только для sh, критичность ниже)_                                        |
| **Прокси для sh-тенанта падает**                        | **Средняя** | **Среднее**     | **Fallback на sh.e-rcs.ru напрямую, мониторинг прокси**                                     |
| Забыть swap на VPS → OOM-kill PG                        | Средняя     | Высокое         | Чек-лист настройки, мониторинг `free -h`                                                    |
| Акционный тариф RUVDS не масштабируется                 | Средняя     | Низкое          | Закладывать «свою конфигурацию»                                                             |
| Jino падает → всё недоступно                            | Низкая      | Высокое         | Осознанно, при росте — вынести роутер                                                       |
| **Двойная разработка (Трек А и Трек Б)**                | **Высокая** | **Среднее**     | **Чёткий скоуп Трека А, не вкладывать лишнего, общий код только для контрактов**            |
| **«Застревание» на Треке А**                            | **Средняя** | **Высокое**     | **Жёсткий дедлайн 6–8 месяцев, регулярные checkpoints, демонстрации прогресса Трека Б**     |
| **Экспорт PDF/Excel тормозит на больших выборках**      | **Средняя** | **Среднее**     | **Лимит на количество строк (10 000), пагинация, асинхронный экспорт для больших объёмов**  |
| **Утечка между тенантами из-за ошибки в `search_path`** | **Средняя** | **Критическое** | **Только `SET LOCAL` в транзакции; тест на изоляцию в CI; линтер на `knex()` без `req.db`** |
| **Пулы соединений при росте тенантов**                  | **Низкая**  | **Среднее**     | **Один пул на всех (schema-per-tenant), PgBouncer при 50+ тенантах**                        |

---

## 12. Открытые вопросы

1. **S3 для бэкапов** — Selectel, Backblaze B2, Yandex Object Storage, или локально + `rsync` на второй VPS?
2. **Uptime Kuma** — на этом же VPS (отдельный compose) или на втором?
3. **CI/CD** — GitHub Actions сразу или ручной деплой?
4. **Cloudflare** перед `api.liftcs.ru` — нужен?
5. **Мониторинг PostgreSQL** — `pg_stat_statements` сразу или позже?
6. **Логи** — Docker json-file или Loki?
7. **WebSocket для notifications** — когда заменить поллинг?
8. **SSO между SPA и `/settings`** — когда админов станет много?
9. **Акционный тариф RUVDS** — брать или сразу «своя конфигурация»?
10. **СПульт** — работает с доменом или IP? (уточнить у владельца)
11. **Асинхронный экспорт** отчётов (если >10 000 строк): когда реализовывать?
12. **PgBouncer** — вводить с первого дня или при 10+ тенантах? (при schema-per-tenant — не нужен до 50+ тенантов)
13. **Архив закрытых заявок** после миграции l3 — отдельный прокси или админка? Когда?
14. **Инженер-электронщик** — какие заявки, кроме типа 24? Отдельный `assignment_type` или `dispatch_specialist`?

---

## 13. Приложение А: API.md

Полный контракт API — в отдельном документе **`API_PROTOCOL.md` v4.1**. Сводка изменений от v4.0:

### Новое в v4.1

- **Actions для отчётов:** `GET /reports/calls/search`, `GET /reports/calls/export/pdf`, `GET /reports/calls/export/excel`.
- **Мультитенантность:** заголовок `X-Tenant`, `tenant_id` в JWT, `org_key` для `login`.
- **`config`:** добавлены `user_position`, `elevator_groups`, `can_manage_dispatchers`.
- **`loadAddress`:** параметр `include_hidden`, поля `is_hidden`, `hidden_reason`, `suspended_at`.
- **`get_org_users`:** фильтр `user_position = 'dispatcher'` (старшие диспетчеры тоже попадают).
- **`callnew`:** проверка `vis=0` → `contract_terminated` для не-админов и не-прорабов с правом.
- **`calls/open` / `calls/closed`:** поля `can_edit`, `can_close`, `can_comment`, `elevator_group_id`, `is_emergency`.
- **Новые коды ошибок:** `token_revoked`, `contract_terminated`, `call_already_closed`, `tenant_not_resolved`, `tenant_suspended`, `tenant_not_found`.
- **`callNewOffline`:** `batch_id` для идемпотентности пачки, `created`/`skipped` в ответе.

### Эндпоинты по категориям

| Категория      | Эндпоинты                                                                                                                                                                                                                                                                |
| -------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| Аутентификация | `POST /auth/login`, `POST /auth/refresh`, `POST /auth/logout`                                                                                                                                                                                                            |
| Конфигурация   | `GET /config`, `POST /loadAddress`, `POST /check_org_key`, `POST /get_org_users`                                                                                                                                                                                         |
| Заявки         | `GET /calls/open`, `GET /calls/closed`, `POST /calls/create`, `POST /calls/edit`, `POST /calls/close`, `POST /calls/note`, `POST /calls/offline`                                                                                                                         |
| Уведомления    | `POST /notifications`                                                                                                                                                                                                                                                    |
| Лифты          | `GET /objects/:id`, `POST /objects/:id/update`, `POST /objects/bulk-update`, `POST /objects/set-visibility-bulk`, `POST /objects/:id/dispatch-reveal`, `POST /objects/:id/assign-mechanic`, `POST /objects/:id/unassign-mechanic`, `POST /objects/:id/assign-specialist` |
| Пользователи   | `GET /users`, `POST /users`, `POST /users/:id/block`, `GET/POST/PUT/DELETE /users/:id/access`                                                                                                                                                                            |
| Группы         | `GET /groups`, `POST /groups`, `POST /groups/:id`, `DELETE /groups/:id`                                                                                                                                                                                                  |
| Контрагенты    | `GET /contractors`, `POST /contractors`, `POST /contractors/:id`                                                                                                                                                                                                         |
| **Отчёты**     | **`GET /reports/calls/search`, `GET /reports/calls/export/pdf`, `GET /reports/calls/export/excel`**                                                                                                                                                                      |
| Аудит          | `GET /audit`                                                                                                                                                                                                                                                             |
| Прочее         | `GET /health`, `GET /me`                                                                                                                                                                                                                                                 |

---

**Конец `MASTER_PLAN.md` (v3.0).**

---

## Что дальше

Осталось обновить:

1. **`СТРУКТУРА_БАЗЫ_ДАННЫХ.txt`** — под schema-per-tenant:
   - `public.tenants`, `public.tenant_migrations`;
   - адреса в `public.lift_city/street/home`;
   - `is_emergency`, `call_number` в `lift_calls`;
   - поля старшего диспетчера (`can_create_dispatchers`, `can_edit_dispatchers`, `can_block_dispatchers`) в `user_group_access`;
   - `contract_suspended_at`, `contract_suspend_reason` в `lift_object`;
   - `electronics_engineer` в `user_position`, `electronics_specialist` в `assignment_type`;
   - таблица `reports` (Трек А);
   - индексы под отчёты.

2. **`AUTH_PROTOCOL.md`** — мультитенантность:
   - `tenant_id` в JWT;
   - `org_key` при логине;
   - `X-Tenant` header;
   - `token_revoked`;
   - сессия PHP для `/settings`.

3. **`OFFLINE_PROTOCOL.md`**:
   - `batch_id`;
   - `offline_sync_log`;
   - `address_not_verified`;
   - только открытые заявки (при миграции).

Какой документ обновлять следующим? Если пришлёте исходники — внесу правки. Если нет — могу подготовить обновлённую версию каждого по аналогии, с пометками «на основе MASTER_PLAN.md v3.0 и bisness.md v3.0».
