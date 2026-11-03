# AUTH_PROTOCOL.md — обновлённая версия

**Версия:** 2.0  
**Дата:** 01.11.2026  
**Статус:** Утверждено  
**Связанные документы:** API_PROTOCOL.md v4.1, OFFLINE_PROTOCOL.md v2.0, MASTER_PLAN.md v3.0, bisness.md v3.0, sqlstrukture.md v3.0

---

## 📑 Содержание

1. [Общие принципы](#1-общие-принципы)
2. [Мультитенантность](#2-мультитенантность)
3. [Пароли и защита от перебора](#3-пароли-и-защита-от-перебора)
4. [Access-token (JWT)](#4-access-token-jwt)
5. [Refresh-token](#5-refresh-token)
6. [Login flow](#6-login-flow)
7. [Refresh flow](#7-refresh-flow)
8. [Logout flow](#8-logout-flow)
9. [Отзыв токенов и принудительный выход](#9-отзыв-токенов-и-принудительный-выход)
10. [Middleware проверки токена](#10-middleware-проверки-токена)
11. [Быстрый вход диспетчера](#11-быстрый-вход-диспетчера)
12. [Авторизация PHP-админки (/settings)](#12-авторизация-php-админки-settings)
13. [Коды ошибок](#13-коды-ошибок)
14. [Безопасность](#14-безопасность)
15. [Схема БД](#15-схема-бд)

---

## 1. Общие принципы

### 1.1. Модель аутентификации

- **Access-token** — JWT, короткоживущий (15 минут), передаётся в `Authorization: Bearer <token>`.
- **Refresh-token** — opaque-строка (random 64 байта), долгоживущий (30 дней), хранится в БД в виде SHA-256 хэша.
- **Принудительный выход** — через `revoked_tokens` + `lift_users.force_reload`.
- **Три источника определения тенанта:** JWT `tenant_id`, `X-Tenant` header, `org_key` в теле.

### 1.2. Разделение потоков

| Клиент | Как хранит токен | Где используется |
|---|---|---|
| SPA/PWA (диспетчеры, механики) | `localStorage` | `tenant.liftcs.ru/` → `api.liftcs.ru` |
| PHP-админка (`/settings`) | `$_SESSION` (сервер) | `tenant.liftcs.ru/settings` → `api.liftcs.ru` |
| Внешние интеграции (СПульт) | `.env` (сервис-к-сервису) | Сервер → сервер |

**Правило:** JWT никогда не хранится в браузере при работе через PHP-админку. Только `PHPSESSID` (httpOnly, secure, SameSite=Lax).

### 1.3. Соответствие ролей и должностей

| `user_role` | `user_position` | Описание |
|---|---|---|
| `administrator` | `admin` | Полные права |
| `dispatcher` | `dispatcher` | Обычный диспетчер |
| `dispatcher` | `foreman` | Прораб |
| `engineer` | `mechanic` | Механик |
| `engineer` | `dispatch_equipment_mechanic` | Связист |
| `engineer` | `electronics_engineer` | Инженер-электронщик |
| `guest` | `guest` | Только чтение |

**Допустимые пары** валидируются по `public.role_position_matrix` (см. `sqlstrukture.md`).

**Старший диспетчер** — не отдельная должность. Это `dispatcher` + доп. права (`can_create_dispatchers`, `can_edit_dispatchers`, `can_block_dispatchers`) в `user_group_access`.

---

## 2. Мультитенантность

### 2.1. Определение тенанта

**Приоритет:**

1. **JWT `tenant_id`** — после логина (основной способ).
2. **`X-Tenant` header** — для `POST /auth/login` и других запросов без JWT.
3. **`org_key` в теле** — только для `POST /auth/login`, `POST /check_org_key`, `POST /get_org_users`.

**Если ни один не определён** → `401 tenant_not_resolved`.

**Алгоритм (Fastify middleware):**

```
1. Если есть JWT → верифицировать → взять tenant_id из payload.
2. Иначе если есть X-Tenant → SELECT из public.tenants WHERE subdomain = X-Tenant.
3. Иначе если есть org_key в body → SELECT из public.tenants WHERE org_key = org_key.
4. Если тенант не найден → 401 tenant_not_found.
5. Если тенант is_active = false → 403 tenant_suspended.
6. Загрузить схему тенанта (кэш 60s) → SET LOCAL search_path TO tenant_<name>, public.
```

### 2.2. Схема-переключатель

После определения тенанта:

```sql
SET LOCAL search_path TO tenant_l3, public;
```

**Ключевое:**
- `SET LOCAL` (не `SET`) — действует только внутри транзакции, не «протекает» на соединение из пула.
- Все запросы в рамках запроса идут в схему тенанта, справочники — из `public`.

**Источник данных:**
- `lift_users`, `lift_refresh_tokens`, `revoked_tokens`, `user_group_access` — **в схеме тенанта**.
- `public.tenants` — реестр (для резолва).

### 2.3. Login с определением тенанта

```json
POST /auth/login
{
  "login": "ivanov",
  "password": "...",
  "org_key": "XXXX-XXXX-XXXX",  // или X-Tenant header
  "device_fingerprint": "..."
}
```

**Алгоритм:**

1. Определить тенант:
   - по `org_key` в body;
   - или по `X-Tenant` header;
   - или по JWT (если есть, для refresh-сценариев).
2. Установить `search_path` в схему тенанта.
3. `SELECT * FROM lift_users WHERE user_login = ?`.
4. Проверить пароль, блокировки, `login_attempts`.
5. Выдать токены с `tenant_id` в payload.

### 2.4. JWT payload

```json
{
  "user_id": 3,
  "tenant_id": 1,
  "schema_name": "tenant_l3",
  "role": "dispatcher",
  "position": "dispatcher",
  "iat": 1761214500,
  "exp": 1761215400,
  "iss": "api.liftcs.ru",
  "aud": "liftcs"
}
```

**Важно:**
- `tenant_id` — ID из `public.tenants`.
- `schema_name` — имя схемы (для быстрого `SET LOCAL search_path` без SELECT к `public.tenants`).
- `schema_name` в токене **можно подделать только при знании `JWT_SECRET`** — это защищено подписью.
- При смене схемы тенанта (миграция) — старые токены перестанут работать, нужен re-login.

### 2.5. Коды ошибок мультитенантности

| Код | Когда |
|---|---|
| `tenant_not_resolved` | Тенант не определён ни одним из способов |
| `tenant_not_found` | Тенант не найден в реестре |
| `tenant_suspended` | Тенант `is_active = false` |

---

## 3. Пароли и защита от перебора

### 3.1. Хранение

- **Хэш пароля:** `password_hash($password, PASSWORD_BCRYPT, ['cost' => 12])`.
- **Поле:** `lift_users.user_password` (`VARCHAR(255)`).
- **Авто-миграция:** если хэш в формате legacy (MD5 / phpass), при успешном логине пароль перезаписывается на Bcrypt.

**Алгоритм авто-миграции:**

```
1. SELECT user_password FROM lift_users WHERE user_login = ?.
2. Определить формат:
   - Bcrypt: начинается с $2y$ / $2a$ / $2b$ → password_verify().
   - MD5: 32 hex-символа → md5($password) === $hash.
   - phpass: начинается с $P$ → phpass-check() (или password_verify для совместимых).
3. Если проверка успешна и формат НЕ Bcrypt:
   - UPDATE lift_users SET user_password = password_hash($password, PASSWORD_BCRYPT) WHERE user_id = ?;
   - audit_log: user.password_migrated.
4. Если проверка провалилась → failed attempt.
```

### 3.2. Защита от перебора

| Счётчик | Поле | Логика |
|---|---|---|
| Неудачные попытки | `login_attempts` | Инкремент при неверном пароле |
| Блокировка | `locked_until` | `now() + 15 min` после 5 неудач |
| Сброс | оба | При успешном логине: `login_attempts = 0, locked_until = NULL` |

**Дополнительно — rate-limit на IP (Nginx):**

- `/auth/login` — 5 запросов в минуту с одного IP.
- При превышении — 429 `rate_limited`.

**Алгоритм проверки:**

```
1. SELECT login_attempts, locked_until FROM lift_users WHERE user_login = ?.
2. Если locked_until > now() → 403 account_locked (с указанием времени разблокировки).
3. Проверить пароль.
4. Если неверно:
   - UPDATE login_attempts = login_attempts + 1.
   - Если login_attempts >= 5 → UPDATE locked_until = now() + 15 min, audit_log: user.locked.
   - 401 unauthorized (без деталей).
5. Если верно:
   - UPDATE login_attempts = 0, locked_until = NULL.
   - Продолжить выдачу токенов.
```

### 3.3. Требования к паролю

- Минимум **6 символов** (из `lift_options.min_password_length`, по умолчанию 6).
- Не проверять сложность на бэкенде (решение UX-уровня).
- При смене пароля (в `/settings`) — обязательная проверка старого (`invalid_password`).

---

## 4. Access-token (JWT)

### 4.1. Параметры

| Параметр | Значение |
|---|---|
| Алгоритм | HS256 |
| Секрет | `JWT_SECRET` (≥ 32 байта, из `.env`) |
| TTL | 15 минут (`JWT_ACCESS_TTL = 900`) |
| Issuer | `api.liftcs.ru` |
| Audience | `liftcs` |
| Header | `Authorization: Bearer <token>` |

### 4.2. Payload

```json
{
  "user_id": 3,
  "tenant_id": 1,
  "schema_name": "tenant_l3",
  "role": "dispatcher",
  "position": "dispatcher",
  "iat": 1761214500,
  "exp": 1761215400,
  "iss": "api.liftcs.ru",
  "aud": "liftcs"
}
```

### 4.3. Обновление

Access-token обновляется через `POST /auth/refresh` (refresh-token в теле). Фронтенд автоматически вызывает refresh при получении `401 unauthorized` (если есть refresh-token).

---

## 5. Refresh-token

### 5.1. Формат

- **Opaque-строка:** 64 байта random (base64url или hex).
- **Хэш в БД:** SHA-256 (`char(64)`).
- **Хранение:** `lift_refresh_tokens` в схеме тенанта.
- **TTL:** 30 дней (`JWT_REFRESH_TTL = 2592000`).

### 5.2. Поля `lift_refresh_tokens`

| Поле | Назначение |
|---|---|
| `id` | PK |
| `user_id` | FK → lift_users |
| `token_hash` | SHA-256 хэш токена (UNIQUE) |
| `device_fingerprint` | Отпечаток устройства (WebGL) |
| `user_ip` | IP при создании |
| `user_agent` | Браузер |
| `expires_at` | Истекает (30 дней) |
| `last_used_at` | Последнее использование |
| `created_at` | Дата создания |

### 5.3. Ротация

**При каждом refresh — ротация:**

1. Проверить refresh-token (хэш → поиск).
2. Проверить `expires_at > now()`.
3. Проверить `user_block = 0` и `force_reload = 0`.
4. Сгенерировать **новый** refresh-token.
5. `UPDATE lift_refresh_tokens SET token_hash = ?, last_used_at = now(), expires_at = now() + 30 days WHERE id = ?`.
6. Выдать новый access-token.

**Почему ротация:** если refresh-token украден и использован, оригинальный пользователь при следующем refresh обнаружит, что хэш изменился (или получит 401). Это сигнал компрометации.

**Альтернатива (проще):** не ротировать, только обновлять `last_used_at`. Для B2B-системы с малым числом пользователей — приемлемо. Решение — на усмотрение команды.

### 5.4. Смена прав и refresh-token

При смене прав:

1. `revoked_tokens` — добавить хэш **access-token**, не refresh.
2. `force_reload = 1` — флаг в `lift_users`.
3. При следующем запросе — 401 `token_revoked`.
4. Фронтенд показывает модалку и делает logout (через `POST /auth/logout`).
5. Refresh-token тоже инвалидируется (удаляется из `lift_refresh_tokens`).

**Важно:** нельзя просто отозвать access, оставив refresh — пользователь сразу обновит access и продолжит работу со старыми правами. Нужно отзывать оба.

---

## 6. Login flow

### 6.1. `POST /auth/login`

**Request:**

```json
{
  "login": "ivanov",
  "password": "secret",
  "org_key": "XXXX-XXXX-XXXX",
  "device_fingerprint": "webgl-fingerprint-hash"
}
```

| Поле | Обязательно | Описание |
|---|---|---|
| `login` | Да | Логин |
| `password` | Да | Пароль (plain) |
| `org_key` | Да (если нет `X-Tenant`) | Ключ организации |
| `device_fingerprint` | Нет | WebGL-отпечаток |

**Response 200:**

```json
{
  "ok": true,
  "data": {
    "access_token": "eyJhbGciOiJIUzI1NiIs...",
    "refresh_token": "aBcD1234...",
    "user": {
      "user_id": 3,
      "name": "Иванов Иван Иванович",
      "role": "dispatcher",
      "position": "dispatcher",
      "tenant_id": 1
    }
  }
}
```

### 6.2. Алгоритм

```
1. Rate-limit на IP (Nginx): 5 r/m.
2. Определить тенант:
   - X-Tenant header → SELECT из public.tenants.
   - Или org_key в body → SELECT из public.tenants.
   - Если ни один → 401 tenant_not_resolved.
3. Проверить тенант: is_active = true (иначе 403 tenant_suspended).
4. SET LOCAL search_path TO tenant_<name>, public.
5. SELECT * FROM lift_users WHERE user_login = ?.
6. Если не найден → 401 unauthorized (без деталей).
7. Проверить user_block = 1 → 403 forbidden («Пользователь заблокирован»).
8. Проверить locked_until > now() → 403 account_locked.
9. Проверить пароль (см. раздел 3.1, с авто-миграцией).
10. Если неверно:
    - UPDATE login_attempts = login_attempts + 1.
    - Если >= 5 → UPDATE locked_until = now() + 15 min.
    - audit_log: user.login_failed.
    - 401 unauthorized.
11. Если верно:
    - UPDATE login_attempts = 0, locked_until = NULL, last_login = now(), last_ip = ?.
    - Генерация access (JWT, 15 мин) + refresh (random, хэш в lift_refresh_tokens).
    - audit_log: user.login.
    - Ответ 200.
```

### 6.3. Ошибки

| Ситуация | Код | HTTP |
|---|---|---|
| Тенант не определён | `tenant_not_resolved` | 401 |
| Тенант не найден | `tenant_not_found` | 404 |
| Тенант приостановлен | `tenant_suspended` | 403 |
| Неверный логин/пароль | `unauthorized` | 401 |
| Пользователь заблокирован | `forbidden` | 403 |
| Аккаунт заблокирован (5+ попыток) | `account_locked` | 403 |
| Превышен rate-limit | `rate_limited` | 429 |

**Безопасность:** при неверном логине — не раскрывать, что именно неверно (логин или пароль). Одинаковый ответ 401.

---

## 7. Refresh flow

### 7.1. `POST /auth/refresh`

**Request:**

```json
{
  "refresh_token": "aBcD1234..."
}
```

**Response 200:**

```json
{
  "ok": true,
  "data": {
    "access_token": "eyJhbGciOiJIUzI1NiIs...",
    "refresh_token": "eFgH5678..."  // если включена ротация
  }
}
```

### 7.2. Алгоритм

```
1. Хэш refresh_token (SHA-256).
2. SELECT * FROM lift_refresh_tokens WHERE token_hash = ?.
3. Если не найден → 401 unauthorized.
4. Если expires_at < now() → DELETE + 401 unauthorized.
5. SELECT user FROM lift_users WHERE user_id = ?.
6. Если user_block = 1 → 403 forbidden.
7. Если force_reload = 1 → 401 token_revoked.
8. Если ротация включена:
   - Генерация нового refresh_token.
   - UPDATE lift_refresh_tokens SET token_hash = ?, last_used_at = now(), expires_at = now() + 30 days.
9. Иначе:
   - UPDATE last_used_at = now().
10. Генерация нового access-token (JWT с tenant_id из user).
11. audit_log: user.refresh.
12. Ответ 200.
```

### 7.3. Определение тенанта при refresh

Refresh-token **не содержит** `tenant_id` (это opaque-строка). Тенант определяется:

- по `X-Tenant` header (если передан);
- или по JWT (если фронт передаёт старый access-token в заголовке);
- или по `org_key` (если передан, но обычно не передаётся).

**Проще:** хранить `tenant_id` в `lift_refresh_tokens` (поле добавить). Тогда при refresh — SELECT из БД даёт `tenant_id`, и `SET LOCAL search_path` устанавливается без внешних источников.

**Рекомендация:** добавить `tenant_id` в `lift_refresh_tokens` для упрощения. Либо использовать `X-Tenant` header всегда.

---

## 8. Logout flow

### 8.1. `POST /auth/logout`

**Request:**

```json
{
  "refresh_token": "aBcD1234..."
}
```

**Response 200:**

```json
{ "ok": true }
```

### 8.2. Алгоритм

```
1. Хэш refresh_token.
2. DELETE FROM lift_refresh_tokens WHERE token_hash = ?.
3. Хэш текущего access-token (из Authorization header) → INSERT INTO revoked_tokens.
4. audit_log: user.logout.
5. Ответ 200.
```

### 8.3. Logout при отсутствии access-token

Если access-token уже истёк, но refresh есть — достаточно удалить refresh. Access и так недействителен.

Если пользователь хочет «выйти на всех устройствах» — отдельный эндпоинт `POST /auth/logout-all`:

```
DELETE FROM lift_refresh_tokens WHERE user_id = ?;
UPDATE lift_users SET force_reload = 1 WHERE user_id = ?;
```

---

## 9. Отзыв токенов и принудительный выход

### 9.1. Когда отзываем

| Событие | Что отзываем | Как |
|---|---|---|
| Смена прав (`userAccessUpdate`) | Access + Refresh | `revoked_tokens` + `force_reload = 1` + `DELETE refresh_tokens` |
| Блокировка (`userBlock`) | Access + Refresh | То же |
| Logout | Access + Refresh | `revoked_tokens` + `DELETE refresh_tokens` |
| Смена пароля | Access + Refresh (все устройства) | То же |
| Подозрение на компрометацию | Access + Refresh (все) | То же |

### 9.2. Механизм

**`revoked_tokens`:**

```sql
INSERT INTO revoked_tokens (user_id, token_hash, reason, created_at, expires_at)
VALUES (?, SHA256(access_token), 'Смена прав', now(), now() + interval '15 minutes');
```

**`lift_users.force_reload = 1`:**

```sql
UPDATE lift_users SET force_reload = 1 WHERE user_id = ?;
```

**Проверка в middleware:**

```
1. Хэш access-token → SELECT из revoked_tokens.
2. Если найден → 401 token_revoked.
3. SELECT force_reload FROM lift_users WHERE user_id = ?.
4. Если force_reload = 1 → 401 token_revoked.
```

**Очистка:** записи `revoked_tokens` с `expires_at < now()` удаляются по cron (раз в сутки).

### 9.3. Поведение фронтенда

1. Фронт получает 401 `token_revoked`.
2. Показывает модалку: **«Ваши права были изменены администратором. Сеанс будет завершён через 10 секунд.»**
3. Через 10 секунд:
   - очищает `localStorage` (access + refresh);
   - редирект на `/login`.

**Опционально:** сбросить `force_reload = 0` в БД при следующем логине (чтобы не блокировать повторно).

### 9.4. Кэш прав

`PermissionsCache` (Redis) инвалидируется при:

- `userAccessUpdate`;
- `userBlock`;
- `force_reload = 1`;
- смене `user_position`.

**Ключ:** `perm:{tenant_id}:{user_id}`.

**TTL:** 300 секунд (страховка на случай, если инвалидация не сработала).

---

## 10. Middleware проверки токена

### 10.1. Защищённый эндпоинт

**Алгоритм:**

```
1. Извлечь `Authorization: Bearer <token>`.
2. Если нет → 401 unauthorized.
3. Верифицировать JWT (подпись, exp, iss, aud).
4. Если невалиден → 401 unauthorized.
5. Извлечь tenant_id и schema_name из payload.
6. SET LOCAL search_path TO schema_name, public.
7. Хэш access → SELECT из revoked_tokens (Redis-кэш + БД).
8. Если найден → 401 token_revoked.
9. SELECT user FROM lift_users WHERE user_id = ?.
10. Если user_block = 1 → 403 forbidden.
11. Если force_reload = 1 → 401 token_revoked.
12. Загрузить контекст (user_group_access, user_elevator_assignment) — из Redis-кэша.
13. Передать управление в Policy-слой.
```

### 10.2. Публичные эндпоинты

Не требуют токена:

- `POST /auth/login`
- `POST /auth/refresh`
- `POST /check_org_key`
- `POST /get_org_users`
- `GET /health`

**Но:** для `login`, `check_org_key`, `get_org_users` требуется определение тенанта (`X-Tenant` / `org_key`).

### 10.3. Публичные с определением тенанта

**Алгоритм (без JWT):**

```
1. Определить тенант по X-Tenant header или org_key в body.
2. Если не определён → 401 tenant_not_resolved.
3. SET LOCAL search_path.
4. Выполнить бизнес-логику.
```

---

## 11. Быстрый вход диспетчера

### 11.1. `POST /check_org_key`

**Request:**

```json
{ "org_key": "XXXX-XXXX-XXXX" }
```

**Response 200:**

```json
{ "ok": true, "data": { "valid": true } }
```

**Алгоритм:**

```
1. Rate-limit на IP: 5 r/m.
2. SELECT id, is_active FROM public.tenants WHERE org_key = ?.
3. Если не найден → 404 invalid_key.
4. Если is_active = false → 403 tenant_suspended.
5. Ответ 200.
```

**Безопасность:** не раскрывать название тенанта, пользователей, ничего лишнего. Только факт «ключ действителен».

### 11.2. `POST /get_org_users`

**Request:**

```json
{ "org_key": "XXXX-XXXX-XXXX" }
```

**Response 200:**

```json
{
  "ok": true,
  "data": {
    "users": [
      { "user_id": 3, "name": "Иванов Иван" },
      { "user_id": 4, "name": "Петров Пётр" }
    ]
  }
}
```

**Алгоритм:**

```
1. Rate-limit на IP: 5 r/m.
2. Определить тенант по org_key.
3. SET LOCAL search_path.
4. SELECT user_id, user_name FROM lift_users
   WHERE user_role = 'dispatcher'
     AND user_position = 'dispatcher'
     AND allow_dispatcher_quick_login = true
     AND user_block = 0
     AND user_hiden = 0
   ORDER BY user_name;
5. Ответ 200 (только user_id и name).
```

**Критично:**

- **Прораб, админ, механик, связист, инженер-электронщик, гость — НЕ попадают.**
- **Старший диспетчер попадает** (т.к. `user_position = 'dispatcher'`).
- Не передавать: телефон, роль, права, служебные поля.
- Ответ кэшируется на фронте в `localStorage`.

---

## 12. Авторизация PHP-админки (`/settings`)

### 12.1. Отличия от SPA

| Параметр | SPA/PWA | PHP-админка (`/settings`) |
|---|---|---|
| Хранение JWT | `localStorage` (браузер) | `$_SESSION` (сервер PHP) |
| Передача в API | `Authorization: Bearer` из JS | `Authorization: Bearer` из PHP (curl) |
| CSRF | Не нужен (Bearer) | Обязателен (формы) |
| Cookie | Нет | `PHPSESSID` (httpOnly, secure, SameSite=Lax) |
| Refresh | JS вызывает `POST /auth/refresh` | PHP вызывает `POST /auth/refresh` при 401 |

### 12.2. Login flow (PHP)

**`/settings/login.php`:**

1. Форма: `login`, `password`. Скрытое поле `_csrf`.
2. Проверка `_csrf` (сравнение с `$_SESSION['csrf']`).
3. PHP-код:
   ```
   $api = new ApiClient('https://api.liftcs.ru', $tenantSubdomain);
   $response = $api->post('/auth/login', [
       'login' => $_POST['login'],
       'password' => $_POST['password'],
       'device_fingerprint' => 'php-settings-admin',
   ]);
   if ($response['ok']) {
       $_SESSION['access_token'] = $response['data']['access_token'];
       $_SESSION['refresh_token'] = $response['data']['refresh_token'];
       $_SESSION['user'] = $response['data']['user'];
       $_SESSION['csrf'] = bin2hex(random_bytes(32)); // перегенерация
       header('Location: /settings/');
       exit;
   } else {
       $error = $response['error']['message'];
       // показать форму с ошибкой
   }
   ```

**`ApiClient.php`** добавляет `X-Tenant: <subdomain>` header (из конфига).

### 12.3. Проверка сессии на каждом запросе

**`/settings/lib/Auth.php`:**

```php
function requireAuth(): array {
    if (empty($_SESSION['access_token'])) {
        header('Location: /settings/login.php');
        exit;
    }
    // Проверить access-token (можно локально верифицировать JWT или сделать ping)
    return $_SESSION['user'];
}
```

**При 401 от API:**

```php
$response = $api->post('/users', $data);
if (!$response['ok'] && $response['error']['code'] === 'unauthorized') {
    // Попробовать refresh
    $refresh = $api->post('/auth/refresh', [
        'refresh_token' => $_SESSION['refresh_token'],
    ]);
    if ($refresh['ok']) {
        $_SESSION['access_token'] = $refresh['data']['access_token'];
        // повторить исходный запрос
        $response = $api->post('/users', $data);
    } else {
        // refresh не удался → logout
        session_destroy();
        header('Location: /settings/login.php');
        exit;
    }
}
```

### 12.4. CSRF

**Генерация:** при логине — `$_SESSION['csrf'] = bin2hex(random_bytes(32))`.

**В каждой форме:**

```html
<input type="hidden" name="_csrf" value="<?= htmlspecialchars($_SESSION['csrf']) ?>">
```

**Проверка:**

```php
if (!hash_equals($_SESSION['csrf'], $_POST['_csrf'] ?? '')) {
    http_response_code(403);
    exit('CSRF token invalid');
}
```

### 12.5. Logout

**`/settings/logout.php`:**

```php
$api = new ApiClient('https://api.liftcs.ru', $tenantSubdomain);
$api->post('/auth/logout', ['refresh_token' => $_SESSION['refresh_token']]);
session_destroy();
header('Location: /settings/login.php');
exit;
```

### 12.6. Старший диспетчер в `/settings`

Если `$_SESSION['user']['position'] === 'dispatcher'` и есть `can_create_dispatchers` / `can_edit_dispatchers` / `can_block_dispatchers`:

- в меню `/settings` показывается пункт «Диспетчеры»;
- `/settings/users/` показывает только диспетчеров;
- `POST /users` — только `role='dispatcher'`, `position='dispatcher'`;
- **все проверки делает API** (Policy-слой), админка только скрывает кнопки.

---

## 13. Коды ошибок

| Код | HTTP | Когда |
|---|---|---|
| `tenant_not_resolved` | 401 | Тенант не определён ни одним из способов |
| `tenant_not_found` | 404 | Тенант не найден в реестре |
| `tenant_suspended` | 403 | Тенант `is_active = false` |
| `unauthorized` | 401 | Нет токена / просрочен / невалиден / неверный логин |
| `token_revoked` | 401 | Токен в `revoked_tokens` или `force_reload = 1` |
| `forbidden` | 403 | Пользователь заблокирован / нет прав |
| `account_locked` | 403 | `locked_until > now()` (5+ неудачных попыток) |
| `invalid_key` | 404 | Неверный `org_key` |
| `invalid_password` | 400 | Неверный старый пароль (смена пароля) |
| `invalid_input` | 400 | Ошибка валидации |
| `rate_limited` | 429 | Превышен rate-limit |
| `internal_error` | 500 | Внутренняя ошибка |

**Формат ответа об ошибке:**

```json
{
  "ok": false,
  "error": {
    "code": "token_revoked",
    "message": "Ваши права были изменены. Войдите заново."
  }
}
```

**Важно:** из-за настроек Nginx все ответы приходят с HTTP 200 (см. `API_PROTOCOL.md`). Ошибки — по полю `status: "error"` в теле.

---

## 14. Безопасность

### 14.1. Rate-limit

| Эндпоинт | Nginx | Fastify |
|---|---|---|
| `POST /auth/login` | 5 r/m с IP | дополнительно 5 r/m с IP + 10 r/m с логина |
| `POST /auth/refresh` | 30 r/m с IP | — |
| `POST /check_org_key` | 5 r/m с IP | — |
| `POST /get_org_users` | 5 r/m с IP | — |
| Остальные | 30 r/s с IP | — |

### 14.2. CORS

Только для SPA (`tenant.liftcs.ru` → `api.liftcs.ru`):

```js
origin: /^https:\/\/([a-z0-9-]+\.)*liftcs\.ru$/,
allowedHeaders: ['Content-Type', 'Authorization', 'X-Tenant'],
credentials: false,
```

### 14.3. JWT

- Подпись — HS256, секрет ≥ 32 байта.
- `exp` — 15 минут.
- `iss` / `aud` — проверяются.
- При смене `JWT_SECRET` — все сессии инвалидируются (пользователи должны перелогиниться).

### 14.4. Пароли

- Bcrypt, cost 12.
- Авто-миграция из MD5/phpass при успешном логине.
- `login_attempts` + `locked_until` (15 минут после 5 неудач).
- При смене пароля — проверка старого.

### 14.5. CSRF

Обязателен для `/settings/*` (формы). Для SPA — не нужен (Bearer, не cookies).

### 14.6. Сессия PHP

- `session.cookie_httponly = 1`
- `session.cookie_secure = 1`
- `session.cookie_samesite = Lax`
- `session.gc_maxlifetime = 28800` (8 часов)
- `session_regenerate_id(true)` после логина (защита от session fixation)

### 14.7. Принудительный выход

- `revoked_tokens` — на 15 минут (до истечения access).
- `force_reload = 1` — до следующего логина.
- Очистка `revoked_tokens` — cron раз в сутки.

### 14.8. Аудит

Все события аутентификации — в `audit_log`:

- `user.login` — успешный вход.
- `user.login_failed` — неудачная попытка.
- `user.locked` — блокировка аккаунта (5+ попыток).
- `user.logout` — выход.
- `user.refresh` — обновление токена.
- `user.password_migrated` — авто-миграция хэша.
- `token.revoked` — отзыв токена.

---

## 15. Схема БД

### 15.1. Таблицы, связанные с аутентификацией

| Таблица | Схема | Назначение |
|---|---|---|
| `public.tenants` | `public` | Реестр тенантов (для резолва) |
| `lift_users` | схема тенанта | Пользователи + `login_attempts`, `locked_until`, `force_reload` |
| `lift_refresh_tokens` | схема тенанта | Refresh-токены |
| `revoked_tokens` | схема тенанта | Отозванные access-токены |
| `audit_log` | схема тенанта | Аудит |

### 15.2. Связи

```
public.tenants (1) ─── (N) tenant_<name>.lift_users
                                    │
                                    ├── (N) lift_refresh_tokens
                                    ├── (N) revoked_tokens
                                    └── (N) audit_log
```

**Ключевое:** все таблицы аутентификации — в схеме тенанта. `public.tenants` только для резолва схемы.

---

**Конец `AUTH_PROTOCOL.md` v2.0.**

---
