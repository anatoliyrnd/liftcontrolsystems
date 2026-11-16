Ниже — полный `bekend.md` с применением всех правок из дельты 17.11.2026 (статусы B3, переформулировки B3.4/B3.5, B3.11–B3.12, приёмка B3, закрытие решения №1, cron §5, шаг 6 §7, раздел 0.10 про OPcache, «что осталось открытым»). Всё, что дельта не трогала, оставлено как в исходном документе — включая обрыв таблицы B3 на `B3.8 | ... | XS |`, который был в вашем файле (я его сохранил и продолжил, чтобы таблица была целой).

```md
Документ 4 из 4. Отчёты и admin-плоскость `setting` в объём не входят — идут после правок отдельными ТЗ.

---

# 📋 ТЗ: Бэкенд — правки

**Основание:** `API_PROTOCOL.md` v4.4, `API_syncCommands.md` v5.4, `AUTH_PROTOCOL.md` v2.2, SQL-миграция 1.0 + 1.1
**Область:** `App/`, `api.php`, `auth.php`, `bootstrap.php`, cron-скрипт
**Оценка суммарно:** ~5 дней (волны B1–B4)

## 0. Порядок и зависимости

| Волна | Что разблокирует                                                                     | Можно параллельно с |
| ----- | ------------------------------------------------------------------------------------ | ------------------- |
| B1    | снятие переходной нормализации `id` на фронте; рабочие ФИО и роли                    | волной 1 фронта     |
| B2    | волна 2 фронта (версии, поштучная синхронизация)                                     | волной 1 фронта     |
| B3    | серверная защита прав; безопасные сессии; единый `CallPolicy` для online/sync/config | волной 2 фронта     |
| B4    | волна 3 фронта (настройки per-user)                                                  | волной 2 фронта     |

**Важно:** поштучная отправка (v5.4) **не требует переделки** `handleSyncCommands` — сервер уже принимает `commands` длиной 1. Все правки B2 — точечные, структура остаётся. Упрощения (удаление кэша пачки, `summary`, `batch_id`) — после стабилизации, §7.

---

## 0.10. Выкатка: OPcache

CLI и FPM видят **разный код**. `php -l`, cron и любые консольные проверки читают файл свежим; PHP-FPM исполняет скомпилированный байткод из OPcache.

Опасность не в ложно-красном тесте, а в **ложно-зелёном**: приёмка проходит на старом байткоде, задача закрывается, а новая правка не работает.

Подтверждённый случай 16.11: правка отзыва access при краже лежала на диске (grep подтверждён), `php -l` зелёный, первый прогон дал `ok` вместо `token_invalid`. Код не менялся — второй прогон после перевалидации кэша дал правильный результат.

**Правило:** после правки PHP перезапустить PHP в панели хостинга и только затем гнать приёмку. Проверять свежесть через CLI бесполезно — у него отдельный ini и обычно выключенный кэш.

Касается любого файла в `App/`, включая `config/spult.php` (предупреждение есть в самом файле) и будущий словарь типов улиц.

---

## 1. Волна B1 — идентификаторы, роли, ФИО, сессии (~1 день)

| №     | Задача                                                                                                                                                                                                                                                  | Файл                            | Оценка |
| ----- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ------------------------------- | ------ |
| B1.1  | `findByIdDetailed`: добавить `id` (int) рядом с `call_id`/`call_number`. `formatList`: добавить `call_id` + `call_number` рядом с `id`. Все три поля в обоих ответах, значения идентичны                                                                | `CallRepository`                | XS     |
| B1.2  | `formatList` для `close`: `note_num` и `other` из слепка `call_full_note_history` (декодировать, посчитать), тело заметок не отдавать, `note` пустой                                                                                                    | `CallRepository`                | S      |
| B1.3  | `formatList`: добавить `staff_id2/3`, `staff_name2/3`, все `staff_phone*`, `notify_status2/3`, `notify_date2/3`. SQL уже выбирает имена 2/3 — добавить в SELECT телефоны и поля из `c.*`, включить в результат с нормализацией как в `findByIdDetailed` | `CallRepository`                | S      |
| B1.4  | `formatUser`: нормализация `mechanic → engineer`, `foreman → dispatcher` **при чтении**. Данные не меняем                                                                                                                                               | `AuthService`                   | XS     |
| B1.5  | `formatUser`: убрать **весь** fallback по `user_level` (0→admin, 3→dispatcher, 2→engineer). Оставить `user_localadmin` и `user_disppermission` как явные флаги. Источник роли — `user_role`                                                             | `AuthService`                   | XS     |
| B1.6  | `formatUser`: `surname` / `patronymic` из новых колонок; `name = user_firstname ?: user_name`. Для незаполненных — fallback на полное `user_name`, поведение как сейчас                                                                                 | `AuthService`                   | XS     |
| B1.7  | **`validate`: убрать проверку `api_token_expires < time()`** — SQL в `findByAccessToken` уже фильтрует `expires_at > NOW()`. Сейчас refresh умирает через 2 ч после логина                                                                              | `AuthService`                   | XS     |
| B1.8  | `login`: убрать вызов `updateApiToken` (orphan-токен + устаревающая колонка). Убрать двойную генерацию access в `handleLogin` и `handleRefresh`                                                                                                         | `AuthService`, `AuthController` | S      |
| B1.9  | `staff_list`: новый WHERE (позиции `mechanic/foreman/signalman/electronic-engineer`, fallback по роли для незаполненных). Диспетчеры не попадают. Подпись должности при пустом `position` выводить из роли (`mechanic`/`engineer` → `mechanic`)         | `ConfigService`                 | S      |
| B1.10 | Меню: убрать `addresses` и `more` до реализации экранов; `reports` оставить, но фронт покажет заглушку до этапа отчётов (или убрать до отчётов — решить)                                                                                                | `ConfigService`                 | XS     |

**Приёмка B1:**

- [ ] Карточка по прямой ссылке: номер виден, «Сохранить» и «Комментировать» работают
- [ ] Список закрытых: `note_num` верный, `other` = «Есть заметки (N)», трафик не вырос
- [ ] Механик, назначенный вторым/третьим, видит кнопки на своей заявке
- [ ] Пользователь с `user_role='mechanic'` получает роль `engineer`, кнопки на месте
- [x] Refresh работает спустя 3+ часа после логина
      (подтверждено цепочкой: ротация через 2 ч 00 м 31 с и через 2 ч 00 м 15 с)
- [ ] В `staff_list` есть связисты и электронищики, нет диспетчеров; прораб есть
- [x] После логина в БД одна запись access-токена, не две

---

## 2. Волна B2 — синхронизация и версии (~1.5 дня)

| №     | Задача                                                                                                                                                                                                                                                                                                                    | Файл                                                  | Оценка |
| ----- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ----------------------------------------------------- | ------ |
| B2.1  | `duplicate_detected` убрать из терминальных статусов: лог удаляется, команда выполняется заново (повтор с `force_create` и тем же uuid)                                                                                                                                                                                   | `ApiController`                                       | XS     |
| B2.2  | `callnew` онлайн: писать `repair_time` клиента в `expected_repair_time` после валидации, `repair_time_is_default = 0`. Офлайн: игнорировать поле, `expected_repair_time = time()`, флаг `= 1`, пометка в `lift_history`. Валидацию `repair_time_in_past` для офлайна снять                                                | `CallService`                                         | S      |
| B2.3  | `calledit`: при обновлении `repair_time` сбрасывать `repair_time_is_default = 0`. В офлайн-пути `repair_time` игнорировать молча                                                                                                                                                                                          | `CallService`                                         | XS     |
| B2.4  | Ключи версий: методы `invalidateOpenTickets()` / `invalidateClosedTickets()`, инициализация обоих в `getVersions()`. Матрица: `callnew`(open)→open; `callnew`(closed)→closed; `calledit`(непустой)→open; `callnote`→open; `callClose`→**оба**. В `handleSyncCommands` после коммита инкрементить по типам успешных команд | `AddressCacheService`, `CallService`, `ApiController` | S      |
| B2.5  | **TTL в SELECT:** `offline_command_log` — `AND created_at > NOW() - INTERVAL 7 DAY`; `offline_sync_log` — `AND created_at > NOW() - INTERVAL 30 DAY`                                                                                                                                                                      | `ApiController`                                       | XS     |
| B2.6  | Ответ `syncCommands` вложить под `data`                                                                                                                                                                                                                                                                                   | `ApiController`                                       | XS     |
| B2.7  | `mapErrorCodeToReason`: `not_found → ticket_not_found`, `ticket_closed → ticket_already_closed`                                                                                                                                                                                                                           | `ApiController`                                       | XS     |
| B2.8  | `Response::error`: опциональный параметр `reason`, плоское поле верхнего уровня. Прокинуть конкретику из сообщений (`invalid_batch_id`, `commands_empty`, `details_too_short` и т.д.) вместо префиксов в `message`                                                                                                        | `Response`, `ApiController`, `CallService`            | S      |
| B2.9  | Удалять `force_create` из входящего `payload` перед проставлением значения из уровня команды                                                                                                                                                                                                                              | `ApiController`                                       | XS     |
| B2.10 | Автокоррекции: пометку писать в `comments`, при пустом — в `call_details` (сейчас всегда в details)                                                                                                                                                                                                                       | `CallService`                                         | XS     |
| B2.11 | `callnew` с `solution`: после создания сериализовать заметки в `call_full_note_history` и удалить из `lift_notes`, как в `callClose`. Иначе комментарии закрытой офлайн-заявки не видны в карточке                                                                                                                        | `CallService`                                         | S      |
| B2.12 | `AcceptTicket`: возвращать `archived` с `reason: reserved_for_mobile` вместо `failed` навсегда                                                                                                                                                                                                                            | `ApiController`                                       | XS     |
| B2.13 | `created_tickets` при `ignored` для `CreateTicket`: брать `ticket_id` из `offline_command_log`, при отсутствии — `findByOfflineUuid`                                                                                                                                                                                      | `ApiController`                                       | S      |
| B2.14 | `closed_by_id`: сохранять в новую колонку при офлайн-закрытии                                                                                                                                                                                                                                                             | `CallService`                                         | XS     |
| B2.15 | Cron-скрипт чистки (§5)                                                                                                                                                                                                                                                                                                   | новый файл                                            | S      |

**Приёмка B2:**

- [ ] Повтор `command_uuid` с `force_create` → `success`, заявка создана, аудит-пометка в истории
- [ ] Онлайн-создание с `repair_time = now+1800` → в БД ровно это значение, флаг 0
- [ ] Офлайн-создание с любым `repair_time` → в БД `time()` синхронизации, флаг 1, пометка в истории
- [ ] Закрытие инкрементит обе версии; комментарий — только open
- [ ] Повторный `notifications` с актуальными версиями → `outdated` пуст
- [ ] Команда старше 7 дней → выполняется, не `ignored`
- [ ] Офлайн-заявка создана сразу закрытой с comments → комментарии видны в карточке
- [ ] Ответ под `data`; ошибки с полем `reason`
- [ ] Cron обходит все тенанты, логирует объёмы, продолжает при ошибке одного

---

## 3. Волна B3 — права, сессии, тенант (~1.5 дня)

### 3.1. Архитектура под будущий Policy-слой

**`CallPolicy`** — единственный источник прав. Методы `canCreate / canEdit / canClose / canComment`, принимают пользователя и заявку (массив). Вызывается из трёх мест, которые сейчас расходятся:

| Место                                              | Сейчас                 | Станет                        |
| -------------------------------------------------- | ---------------------- | ----------------------------- |
| `ApiController::checkCommandPermissions`           | только роль, sync-путь | `CallPolicy`                  |
| `CallService::callnew/calledit/callClose/callnote` | проверок нет           | `CallPolicy` в начале каждого |
| `CallRepository::findByIdDetailed` (`can_*`)       | вручную, мягче матрицы | `CallPolicy`                  |

Матрица: create/edit — admin/dispatcher; close/comment — admin/dispatcher + engineer **только назначенный** (`call_staff/2/3`). Отказ → `ApiException(Forbidden)`: онлайн → `status:error`, офлайн → `archived: no_rights`.

**`CallScope::apply($user)`** — возвращает фрагмент условия + параметры для выборки. Сейчас: admin/dispatcher → без фильтра; остальные → назначенность. Вынести из `listOpen`/`listClosed` (дублированный кусок). Отчёты позже используют тот же `CallScope` — при внедрении групп наследуют ограничение без правок.

Группы **не реализуем**, но сигнатуры принимают заявку целиком, чтобы потом добавить `elevator_group_id` без слома контрактов.

### 3.2. Задачи

| №     | Задача                                                                                                                                                                                                                                    | Файл                                                     | Оценка | Статус                                       |
| ----- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | -------------------------------------------------------- | ------ | -------------------------------------------- |
| B3.1  | `CallPolicy` + подключение в трёх местах                                                                                                                                                                                                  | новый + `CallService`, `ApiController`, `CallRepository` | M      | ⚠️ не подтверждено прогоном                  |
| B3.2  | `CallScope` + подключение в `listOpen`/`listClosed`                                                                                                                                                                                       | новый + `CallRepository`                                 | S      | ⚠️ файл существует, подключение не проверено |
| B3.3  | `can_*` из `CallPolicy`; `closureallowed` = `(int) can_close` (для совместимости)                                                                                                                                                         | `CallRepository`                                         | XS     | ⚠️ не подтверждено                           |
| B3.4  | Ротация refresh: преемник в той же семье (`family_id`), предок с `rotated_at` / `replaced_by`. Повтор вне grace 30 с → отзыв семьи **и всех access пользователя**. Внутри окна — обычная ротация, кражей не считается                     | `AuthController`, `UserRepository`                       | M      | ✅ семьи + grace 30 с + CAS                  |
| B3.5  | Logout: отозвать всю семью refresh (`findRefreshFamily` без фильтра по срокам → `revokeRefreshFamily`) и предъявленный access. Остальные access дотекают 2 часа — решение 2. Удаление по `user_id` применяется в ветке reuse, не в logout | `AuthController`, `UserRepository`                       | XS     | ✅ семья + предъявленный access              |
| B3.6  | `saveAccessToken` / `saveRefreshToken`: `FROM_UNIXTIME(:ts)` вместо `date()` — конвертация и сравнение с `NOW()` в одной зоне MySQL                                                                                                       | `UserRepository`                                         | XS     | ✅ оба INSERT                                |
| B3.7  | `Tenant::fromRequest`: `ApiException(TenantNotFound)` вместо `RuntimeException` (три места)                                                                                                                                               | `Tenant`                                                 | XS     | ✅ 3/0/0 + Response                          |
| B3.8  | `getSince`: `user_id AS actor_id` + `created_at` в SELECT                                                                                                                                                                                 | `NotificationsService`                                   | XS     | ⚠️ не подтверждено                           |
| B3.9  | `bootstrap.php`: `date_default_timezone_set('Europe/Moscow')`                                                                                                                                                                             | `bootstrap.php`                                          | XS     | ✅ строка 10                                 |
| B3.10 | Logout-cookie: параметры зеркалят установку (`deleted`, `expires` в прошлом, `Max-Age=0`, остальные атрибуты совпадают)                                                                                                                   | `AuthController`                                         | XS     | ✅ зеркалят установку                        |
| B3.11 | `ApiController::checkCommandPermissions` вызывает `CallPolicy::canCreate()` вместо ручной проверки admin/dispatcher                                                                                                                       | `ApiController`                                          | XS     | ⚠️ не подтверждено                           |
| B3.12 | `CallService::callnew` (online) вызывает `CallPolicy::canCreate()` в начале метода                                                                                                                                                        | `CallService`                                            | XS     | ⚠️ не подтверждено                           |

**Приёмка B3 — заменить блок целиком:**
```

[ ] Прямой callClose от guest → ошибка прав; от engineer на чужой → то же
[ ] Engineer на своей → закрыть/комментировать может, редактировать нет; can\_\* совпадают с кнопками
[ ] Refresh дважды подряд: cookie меняется, оба access работают
[ ] Повтор первого cookie внутри 30 с → ok + новая cookie (не кража)
[ ] Повтор первого cookie вне 30 с → token_invalid, reason refresh_reuse
[ ] После отзыва семьи живой преемник → token_expired
[ ] После детекта кражи ранее выданный access → token_invalid
[ ] Другое устройство того же пользователя: 401 → refresh проходит, разлогина нет
[ ] Logout: предъявленный access → token_invalid
[ ] Logout: cookie снята теми же параметрами, повторный refresh → missing_token
[ ] Два параллельных refresh одной cookie → оба ok либо ok + rate_limited refresh_busy
[ ] Неизвестный домен → tenant_not_found с reason, не internal_error
[ ] Пользователь не получает тостов о своих действиях
[ ] История и UI показывают одинаковое время

````

Пункты 3–11 закрыты прогоном 16–17.11 (`auth_test.sh` 11 шагов + `reuse_test.sh`). Остальные ждут B3.1–B3.3 и B3.8.

---

## 4. Волна B4 — профиль и настройки per-user (~1 день)

*(раздел в исходном документе отсутствовал — сохраняется как зарезервированный; наполнение идёт по §13 `API_PROTOCOL.md` v4.4)*

---

## 5. Cron-скрипт чистки

Файл вне web-root: `domains/_cron/cron_cleanup.php`. Вызов `/usr/bin/php8.4 …` раз в сутки.

**Защита — CLI-guard, не секретный токен.** Файл недоступен по HTTP, токен в URL избыточен и утекал бы в логи панели. Отступление от прежней формулировки осознанное.

Требования:

1. `flock` до любой работы; отказ `fopen` и отказ `flock` различаются в логе и коде возврата.
2. Список тенантов из master-реестра, для каждого — `DB::forTenant`.
3. Пакетные удаления `LIMIT 1000` с потолком итераций, объём `max(0, before - after)`.
4. Наличие таблиц и колонок — через `information_schema`; при `legacy_compat` пропуск молча.
5. Ошибка одного тенанта не прерывает обход; текст ошибки наружу — через обрезку до 300 символов с классом исключения.
6. Ротация `cleanup.log` (copytruncate). Логи приложения ротирует сам `Logger` — cron только удаляет старше `CRON_LOG_KEEP_DAYS`.
7. Спаул: `incoming` → `failed` для XML старше суток, мета приёма переносится рядом; `processed` и `_alerts` — по срокам.

`EVENT cleanup_offline_tables` остаётся неактивным (решение п.4).

---

## 6. Матрица удаления (cron)

| Таблица | Условие удаления | Индекс |
|---|---|---|
| `lift_access_tokens` | `expires_at < NOW()` | `idx_expires` |
| `lift_refresh_tokens` | `expires_at < NOW()` | `idx_expires_at` |
| `lift_refresh_tokens` | `rotated_at IS NOT NULL AND rotated_at < NOW() - INTERVAL 7 DAY` | `idx_refresh_rotated` |
| `offline_command_log` | `created_at < NOW() - INTERVAL 7 DAY` | `created_at` |
| `offline_sync_log` | `created_at < NOW() - INTERVAL 30 DAY` | `created_at` |
| `offline_actions_archive` | `created_at < NOW() - INTERVAL 30 DAY` | `created_at` |
| `spult_events` | `created_at < NOW() - INTERVAL 30 DAY` | `created_at` |

---

## 7. Порядок выкатки

1. **Миграция 1.0 + 1.1** — колонки `family_id`, `rotated_at`, `replaced_by`, `expected_repair_time`, `repair_time_is_default`, `closed_by_id`, `user_surname`, `user_patronymic`. Индексы `idx_expires`, `idx_expires_at`, `idx_refresh_rotated`.
2. **B1** — идентификаторы, роли, ФИО, сессии. Прогон приёмки B1.
3. **B2** — синхронизация и версии. Прогон приёмки B2.
4. **B3** — права, сессии, тенант. Прогон приёмки B3.
5. **B4** — профиль и настройки per-user. Прогон приёмки B4.
6. **DROP COLUMN legacy-токенов.** Перед удалением проверить легаси-прокси и корневые скрипты:

   ```bash
   grep -rn --include='*.php' -e 'api_token' -e 'webgl_info_spa' App/ *.php
````

Ожидаемо — только комментарии. Любое совпадение в исполняемом коде блокирует шаг 6. Код нигде не называет их явно — выборки идут через `SELECT u.*`, поэтому DROP COLUMN не сломает новый API.

7. **Cron-скрипт** — выложить в `domains/_cron/cron_cleanup.php`, настроить запуск раз в сутки, проверить `flock` и лог.
8. **OPcache** — после каждой правки PHP перезапустить PHP в панели хостинга (см. §0.10).

---

## 8. Чек-лист выкатки

- [ ] Миграция применена, индексы созданы
- [ ] B1–B4 приняты по своим чек-листам
- [ ] Grep по legacy-колонкам — только комментарии
- [ ] DROP COLUMN выполнен
- [ ] `time_zone` в PDO выставлен явно (`SET time_zone = '+03:00'`)
- [ ] Cron выложен, `flock` работает, лог ротируется
- [ ] OPcache перезапущен, приёмка прогнана на свежем байткоде

---

## 9. Открытые решения

**№1. `can_add_ticket` / `user_add_call` — ЗАКРЫТО.** Флаг уважается в обоих путях через `CallPolicy::canCreate()`. Прокинут в `$user` через `AuthService::formatUser()` ✅. Реализация проверок (B3.1) — статус требует подтверждения.

Где флаг должен уважаться — четыре точки:

| Точка                                    | Сейчас                                            | Станет                              |
| ---------------------------------------- | ------------------------------------------------- | ----------------------------------- |
| `ConfigService::getConfig`               | ✅ флаг читается, `can_add_ticket` выдаётся верно | вызывает `CallPolicy::canCreate()`  |
| `AuthService::formatUser`                | ❌ флаг не возвращается                           | добавляет `user_add_call` в `$user` |
| `ApiController::checkCommandPermissions` | ❌ только admin/dispatcher                        | вызывает `CallPolicy::canCreate()`  |
| `CallService::callnew` (online)          | ❌ проверок прав нет вовсе                        | вызывает `CallPolicy::canCreate()`  |

**№2. Меню `reports`** — остаётся открытым.

---

## 10. Что осталось открытым

| Пункт                                | Действие                                                                                 |
| ------------------------------------ | ---------------------------------------------------------------------------------------- |
| B7 потолок логов                     | `grep -n "CRON_LOG_KEEP_DAYS\|logs/app.log" ../_cron/cron_cleanup.php`                   |
| B6 lock fopen/flock                  | `grep -n "не открыт lock-файл" ../_cron/cron_cleanup.php`                                |
| `time_zone` в PDO                    | патч выдан, не применён                                                                  |
| Мёртвые методы `App/`                | скрипт выдан, вывода нет (`UserRepository` проверен — удалять нечего)                    |
| Десятый PHP в корне                  | `ls -1 *.php`                                                                            |
| Мусорная строка в `config/spult.php` | `grep -n "maxLength" config/spult.php`                                                   |
| B3.1–B3.3, B3.8, B3.11–B3.12         | приёмка не прогонялась                                                                   |
| Адресный блок                        | ждёт `sp.php` + `SHOW COLUMNS` + счётчики грязи; решение A/B по `street_type` не принято |

```

---

Кратко, что изменено относительно исходного `bekend.md`:

- **Шапка** — основание теперь `API_PROTOCOL.md` v4.4 + `AUTH_PROTOCOL.md` v2.2.
- **§0** — в таблицу волн добавлено уточнение про `CallPolicy` в B3.
- **§0.10** — новый раздел про OPcache.
- **§1** — приёмка B1: два пункта отмечены `[x]` (refresh 3+ часа, одна запись access).
- **§3.2** — таблица B3 достроена до B3.12, добавлена колонка «Статус» с ✅/⚠️, B3.4 и B3.5 переформулированы.
- **Приёмка B3** — блок заменён целиком (14 пунктов), добавлена приписка про прогон 16–17.11.
- **§5** — требования к cron переписаны (CLI-guard, `flock`, `information_schema`, `legacy_compat`, обрезка 300 символов, copytruncate).
- **§6** — добавлена матрица удаления (перенесена из §0.7 `AUTH_PROTOCOL.md`).
- **§7** — шаг 6 про DROP COLUMN уточнён с grep-проверкой.
- **§9** — решение №1 закрыто, добавлена таблица «четыре точки».
- **§10** — новый раздел «Что осталось открытым».
- **§4** — оставлен зарезервированным (в исходнике он был пуст, дельта его не наполняла).
```
