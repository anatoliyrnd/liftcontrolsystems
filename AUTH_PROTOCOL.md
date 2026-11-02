# 🔐 Протокол авторизации (Auth Specification) — Система «Lift-Calls»

**Версия:** 1.1  
**Статус:** Актуально (согласовано)  
**Последнее обновление:** 21.10.2026  
**Связанные документы:** API_PROTOCOL.md, OFFLINE_PROTOCOL.md, TECHNICAL_DEBT.md

Настоящий документ описывает контракт между SPA-интерфейсом и серверным эндпоинтом авторизации `auth.php`, а также схему проверки подлинности запросов к шлюзу `test_calls.php`.

## 📑 Содержание
* [Архитектура авторизации](#-архитектура-авторизации)
* [Глобальные параметры](#-глобальные-параметры)
* [Токены и Cookie](#-токены-и-cookie)
* [Эндпоинты auth.php](#-эндпоинты-authphp)
* [Авторизация запросов к test_calls.php](#-авторизация-запросов-к-test_callsphp)
* [Коды ошибок в теле JSON](#-коды-ошибок-в-теле-json)
* [Fingerprint устройства (WebGL)](#-fingerprint-устройства-webgl)
* [Схема БД](#-схема-бд)
* [CORS и безопасность](#-cors-и-безопасность)

## 🏛️ Архитектура авторизации
Система использует модель «Access в памяти + Refresh в httpOnly cookie».

| Компонент | Где хранится | TTL | Назначение |
| :--- | :--- | :--- | :--- |
| `access_token` | Память SPA (переменная в `ApiService`) | 2 часа | Заголовок `Authorization: Bearer` в каждом API-запросе |
| `refresh_token` | httpOnly cookie (`SameSite=Strict`, `Secure`) | 30 дней | Восстановление access при F5 и при 401 |
| `WebGL fingerprint` | `localStorage` | — | Привязка refresh-сессии к устройству |

**Почему так:**
* XSS не украдёт `access_token` — он в памяти, недоступен из другого скрипта.
* XSS не украдёт `refresh_token` — это защищенная кука `httpOnly cookie`.
* CSRF не работает: `SameSite=Strict` + токен `access` уходит в заголовке, а не в cookie.
* Диспетчер работает месяцами без повторного ввода пароля.

## 🌐 Глобальные параметры

| Параметр | Значение |
| :--- | :--- |
| **URL auth.php** | Тот же origin, что грузит JS SPA. В проде: `https://<origin-SPA>/auth.php` |
| **URL шлюза** | `https://e-rcs.ru` (прод), `https://e-rcs.ru` (тест) |
| **Метод запроса** | POST |
| **Content-Type** | `application/json; charset=utf-8` |
| **Accept** | `application/json` |
| **Таймаут фронтенда** | 15 секунд (`AbortController`) |
| **HTTPS** | Обязателен. Cookie `Secure` без HTTPS не отправится |
| **Аутентификация** | `Authorization: Bearer <access_token>` для всех запросов, кроме login |
| **HTTP-статусы** | ⚠️ Все ответы приходят с HTTP 200 OK. Код ошибки передаётся в теле JSON (`code`). |

## 🔐 Токены и Cookie

### Access-токен

| Свойство | Значение |
| :--- | :--- |
| **Формат** | Непрозрачная строка. `bin2hex(random_bytes(32))` = 64 hex-символа |
| **TTL** | 2 часа (7200 секунд) |
| **Передача** | Заголовок `Authorization: Bearer <token>` |
| **Хранение на клиенте** | Только в памяти SPA. Не в `localStorage`, не в `sessionStorage` |
| **Хранение на сервере** | `lift_users.user_token` + `lift_users.user_token_expires_at` |

### Refresh-токен

| Свойство | Значение |
| :--- | :--- |
| **Формат** | Непрозрачная строка. `bin2hex(random_bytes(32))` = 64 hex-символа |
| **TTL** | 30 дней (2592000 секунд) |
| **Передача** | `httpOnly cookie` (ставится сервером при login/refresh) |
| **Имя cookie** | `lift_refresh` |
| **Атрибуты cookie** | `HttpOnly; Secure; SameSite=Strict; Path=/; Max-Age=2592000` |
| **Хранение на сервере** | `lift_refresh_tokens.token_hash` (SHA-256 от значения) |

Cookie — формат заголовка `Set-Cookie`:
```http
Set-Cookie: lift_refresh=<64-hex>; Max-Age=2592000; Path=/; HttpOnly; Secure; SameSite=Strict
```

## 🛠️ Эндпоинты auth.php
Все действия вызываются через query-параметр `?action=<name>`. Тело запроса — JSON.

### 1. Вход (login)
Аутентификация по логину/паролю. Опционально — по сохранённому fingerprint'у (auto-login).

#### 📥 Тело запроса
```json
{ "user_id": 3,
  "name": "ivanov",
  "pname": "secret_password",
  "webGL": "full:Google Inc.|ANGLE (Intel, Intel(R) UHD Graphics 630...)",
  "autoLogin": true
}
```

| Поле | Тип | Обязательность | Описание |
| :--- | :--- | :--- | :--- |
|user_id|	integer|	Условно	ID пользователя (из списка организации). Передается, если пользователь выбрал себя из <datalist>. Имеет приоритет над name.
| `name` | string | Условно | Логин или email. Передается, если пользователь ввел логин вручную (или нет ключа организации). |
| `pname` | string | Условно | Пароль. Обязателен, если не используется auto-login |
| `webGL` | string | Обязательное | Fingerprint устройства (см. раздел 7) |
| `autoLogin` | boolean | Опциональное | true — запросить продление refresh на 30 дней. false / отсутствует — refresh на сессию |
Логика авторизации: Если в запросе присутствует user_id, сервер авторизует пользователя строго по нему. Если user_id нет — сервер ищет пользователя по полю name.
#### 📤 Успешный ответ (HTTP 200)
**Заголовки:** `Set-Cookie: lift_refresh=<64-hex>; Max-Age=2592000; Path=/; HttpOnly; Secure; SameSite=Strict`  
**Тело:**
```json
{
  "status": "ok",
  "access_token": "a3f9...64-hex...",
  "expires_at": 1792720000,
  "user": {
    "id": 3,
    "name": "Иванов Иван",
    "role": "dispatcher"
  }
}
```

#### 🚨 Ошибки

| Ситуация | Код в теле (`code`) | Сообщение (`message`) |
| :--- | :--- | :--- |
| Неверный логин/пароль | `invalid_credentials` | «Неверное имя или пароль» |
| Пользователь заблокирован | `user_blocked` | «Учётная запись заблокирована» |
| Превышен лимит попыток | `too_many_attempts` | «Слишком много попыток входа» |
| Логин короче 4 символов | `invalid_input` | «Логин слишком короткий» |
| Не передан webGL | `invalid_input` | «Не удалось определить устройство» |

Пример ответа с ошибкой:
```json
{
  "status": "error",
  "code": "invalid_credentials",
  "message": "Неверное имя или пароль"
}
```

### 2. Обновление токена (refresh)
Выдаёт новый access-токен в обмен на валидный refresh в cookie. Используется при старте SPA (после F5) и при получении `code: 'token_expired'` от `test_calls.php`.

#### 📥 Тело запроса
```json
{}
```
*Тело пустое. Refresh-токен читается только из httpOnly cookie.*

#### 📤 Успешный ответ (HTTP 200)
```json
{
  "status": "ok",
  "access_token": "b8d2...64-hex...",
  "expires_at": 1792727200,
  "user": {
    "id": 3,
    "name": "Иванов Иван",
    "role": "dispatcher"
  }
}
```

#### 🚨 Ошибки

| Ситуация | Код в теле (`code`) | Сообщение (`message`) |
| :--- | :--- | :--- |
| Cookie отсутствует | `missing_token` | «Сессия не найдена» |
| Refresh не найден в БД | `token_invalid` | «Сессия недействительна» |
| Refresh истёк | `token_expired` | «Сессия истекла, войдите заново» |
| Пользователь заблокирован | `user_blocked` | «Учётная запись заблокирована» |

При ошибке сервер обязан очистить cookie:
```http
Set-Cookie: lift_refresh=; Max-Age=0; Path=/; HttpOnly; Secure; SameSite=Strict
```

### 3. Выход (logout)
Инвалидирует refresh-токен в БД и очищает cookie.

#### 📥 Тело запроса
```json
{}
```

#### 📤 Успешный ответ (HTTP 200)
**Заголовки:** `Set-Cookie: lift_refresh=; Max-Age=0; Path=/; HttpOnly; Secure; SameSite=Strict`  
**Тело:**
```json
{
  "status": "ok",
  "message": "Вы вышли из системы"
}
```
*Logout идемпотентен: если cookie нет или токен уже инвалидирован — всё равно 200 OK.*

### 4. Проверка сессии (validate)
Лёгкий эндпоинт для проверки живости access-токена.

#### 📥 Тело запроса
```json
{}
```
**Заголовок:** `Authorization: Bearer <access_token>`

#### 📤 Успешный ответ (HTTP 200)
```json
{
  "status": "ok",
  "expires_at": 1792720000,
  "user": {
    "id": 3,
    "name": "Иванов Иван",
    "role": "dispatcher"
  }
}
```

#### 🚨 Ошибки

| Ситуация | Код в теле (`code`) |
| :--- | :--- |
| Заголовок отсутствует | `missing_token` |
| Токен невалиден | `token_invalid` |
| Токен истёк | `token_expired` |
| Пользователь заблокирован | `user_blocked` |

## 🛡️ Авторизация запросов к test_calls.php
Все запросы к шлюзу (кроме `auth.php`) требуют заголовок: `Authorization: Bearer <access_token>`

Порядок проверки на сервере:
1. Заголовок отсутствует → ответ `{status: 'error', code: 'missing_token'}`.
2. Токен не найден в `lift_users.user_token` → ответ `{status: 'error', code: 'token_invalid'}`.
3. `user_token_expires_at < NOW()` → ответ `{status: 'error', code: 'token_expired'}`.
4. `lift_users.user_block = 1` → ответ `{status: 'error', code: 'user_blocked'}`.
5. Всё ок → выполнить действие.

Пример ошибки от `test_calls.php`:
```json
{
  "status": "error",
  "code": "token_expired",
  "message": "Access-токен истёк"
}
```

#### Поведение фронта при получении ошибки:
* **`token_expired`:** Вызывает `POST /auth.php?action=refresh`. При успехе — повторяет исходный запрос. При ошибке refresh — редиректит на `#/login`. Внедрен Mutex на refresh: параллельные 401 не запускают N дублирующих запросов.
* **`missing_token`**, **`token_invalid`**, **`device_mismatch`**: Редирект на `#/login`.
* **`user_blocked`**: Показать ошибку на экране, авто-редирект не производить.

## 🚫 Коды ошибок в теле JSON
⚠️ **Важно:** Из-за настроек веб-сервера (Nginx перехватывает 4xx/5xx статусы) все ответы сервера приходят с HTTP-статусом 200 OK.
Ошибки определяются исключительно по полям `status: "error"` и `code` в теле ответа.

| code | Когда возникает | Действие фронта |
| :--- | :--- | :--- |
| `missing_token` | Нет заголовка Authorization или cookie | Redirect на `#/login` |
| `token_invalid` | Токен не найден в БД / не совпадает | Redirect на `#/login` |
| `token_expired` | `user_token_expires_at < NOW()` | Попытка refresh → retry → иначе `#/login` |
| `device_mismatch` | Fingerprint устройства не совпал | Redirect на `#/login` без попытки refresh |
| `user_blocked` | `lift_users.user_block = 1` | Показать ошибку, не редиректить |
| `insufficient_permissions` | Роль/права не позволяют действие | Показать ошибку |
| `invalid_credentials` | Неверный логин/пароль на login | Показать сообщение в форме |
| `too_many_attempts` | Превышен лимит попыток | Показать сообщение, блокировка формы |
| `invalid_input` | Некорректные входные данные | Показать сообщение в форме |
| `server_error` | Внутренняя ошибка сервера | Показать «Ошибка сервера» |

## 🖥️ Fingerprint устройства (WebGL)

### Алгоритм генерации (JS, на стороне SPA)
```javascript
export function getWebGLFingerprint() {
    try {
        const canvas = document.createElement('canvas');
        const gl = canvas.getContext('webgl') || canvas.getContext('experimental-webgl');
        if (!gl) return 'no-webgl';

        const dbg = gl.getExtension('WEBGL_debug_renderer_info');
        if (!dbg) {
            const vendor   = gl.getParameter(gl.VENDOR)   || '';
            const renderer = gl.getParameter(gl.RENDERER) || '';
            return `basic:${vendor}|${renderer}`;
        }

        const vendor   = gl.getParameter(gl.VENDOR) || '';
        const renderer = gl.getParameter(dbg.UNMASKED_RENDERER_WEBGL) || '';
        return `full:${vendor}|${renderer}`;
    } catch (e) {
        return 'webgl-error';
    }
}
```

### Возможные значения

| Префикс | Когда | Пример |
| :--- | :--- | :--- |
| `full:` | Расширение доступно (большинство браузеров) | full:Google Inc.\|ANGLE (Intel, Intel(R) UHD Graphics 630...) |
| `basic:` | Расширение заблокировано (Firefox privacy, Safari, incognito) | basic:Google Inc.\|WebKit |
| `no-webgl` | WebGL не поддерживается | no-webgl |
| `webgl-error` | Исключение при получении контекста | webgl-error |

### Серверная проверка

| Случай | Поведение |
| :--- | :--- |
| **=== совпало** | auto-login разрешён |
| **Оба начинаются с `full:`** | Сравнение с порогом: Levenshtein < 20% длины → разрешить |
| **Хотя бы одно из `basic:*`, `no-webgl`, `webgl-error`** | Пропустить проверку устройства, требовать только валидный токен |
| **Всё остальное** | Ответ `{status: 'error', code: 'device_mismatch'}` |

## 🗄️ Схема БД

### Таблица lift_users — изменения
```sql
ALTER TABLE lift_users
ADD COLUMN user_token_expires_at DATETIME NULL AFTER user_token,
ADD COLUMN user_token_created_at DATETIME NULL AFTER user_token_expires_at;
```

### Новая таблица lift_refresh_tokens
```sql
CREATE TABLE lift_refresh_tokens (
    id INT AUTO_INCREMENT PRIMARY KEY,
    user_id INT NOT NULL,
    token_hash CHAR(64) NOT NULL,
    device_fingerprint TEXT NOT NULL,
    expires_at DATETIME NOT NULL,
    created_at DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    last_used_at DATETIME NULL,
    user_ip VARCHAR(45) NULL,
    user_agent VARCHAR(255) NULL,

    INDEX idx_user_id (user_id),
    INDEX idx_expires_at (expires_at),
    UNIQUE KEY uq_token_hash (token_hash),

    FOREIGN KEY (user_id) REFERENCES lift_users(user_id) ON DELETE CASCADE
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4;
```

| Поле | Назначение |
| :--- | :--- |
| `token_hash` | SHA-256 от значения refresh-токена. Сам токен в БД не хранится |
| `device_fingerprint` | Строка WebGL на момент логина |
| `expires_at` | Момент истечения (создание + 30 дней) |
| `last_used_at` | Когда последний раз использовался |
| `user_ip`, `user_agent` | Для аудита (кто и откуда) |

*Cron-задача:* `DELETE FROM lift_refresh_tokens WHERE expires_at < NOW();` (раз в час).

## 🌍 CORS и безопасность

### Для auth.php
CORS не требуется. `auth.php` живёт на том же origin, что и SPA. Cookie `refresh_token` — того же домена. Никаких preflight-запросов.

### Для test_calls.php
Требования к заголовкам ответа:
```http
Access-Control-Allow-Origin: https://<точный origin SPA>
Access-Control-Allow-Credentials: true
Access-Control-Allow-Headers: Content-Type, Authorization
Access-Control-Allow-Methods: POST, OPTIONS
```
⚠️ `Access-Control-Allow-Origin: *` использовать нельзя. С `credentials: 'include'` браузер заблокирует такой запрос.

### Безопасность cookie

| Атрибут | Значение | Зачем |
| :--- | :--- | :--- |
| **HttpOnly** | Да | XSS не может прочитать cookie |
| **Secure** | Да | Cookie передается только по HTTPS |
| **SameSite** | Strict | Надежная CSRF-защита |
| **Path** | / | Доступен для всех эндпоинтов домена |
| **Max-Age** | 2592000 | TTL refresh-токена (30 дней) |

Конец документа AUTH_PROTOCOL.md (версия 1.1).
