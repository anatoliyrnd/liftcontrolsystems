Документ 4 из 4. Отчёты и admin-плоскость `setting` в объём не входят — идут после правок отдельными ТЗ.

---

# 📋 ТЗ: Бэкенд — правки

**Основание:** `API_PROTOCOL.md` v4.3, `API_syncCommands.md` v5.4, SQL-миграция 1.0 + 1.1
**Область:** `App/`, `api.php`, `auth.php`, `bootstrap.php`, cron-скрипт
**Оценка суммарно:** ~5 дней (волны B1–B4)

## 0. Порядок и зависимости

| Волна | Что разблокирует                                                  | Можно параллельно с |
| ----- | ----------------------------------------------------------------- | ------------------- |
| B1    | снятие переходной нормализации `id` на фронте; рабочие ФИО и роли | волной 1 фронта     |
| B2    | волна 2 фронта (версии, поштучная синхронизация)                  | волной 1 фронта     |
| B3    | серверная защита прав; безопасные сессии                          | волной 2 фронта     |
| B4    | волна 3 фронта (настройки per-user)                               | волной 2 фронта     |

**Важно:** поштучная отправка (v5.4) **не требует переделки** `handleSyncCommands` — сервер уже принимает `commands` длиной 1. Все правки B2 — точечные, структура остаётся. Упрощения (удаление кэша пачки, `summary`, `batch_id`) — после стабилизации, §7.

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
- [ ] Refresh работает спустя 3+ часа после логина
- [ ] В `staff_list` есть связисты и электронищики, нет диспетчеров; прораб есть
- [ ] После логина в БД одна запись access-токена, не две

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

| №     | Задача                                                                                                                                                  | Файл                                                     | Оценка |
| ----- | ------------------------------------------------------------------------------------------------------------------------------------------------------- | -------------------------------------------------------- | ------ |
| B3.1  | `CallPolicy` + подключение в трёх местах                                                                                                                | новый + `CallService`, `ApiController`, `CallRepository` | M      |
| B3.2  | `CallScope` + подключение в `listOpen`/`listClosed`                                                                                                     | новый + `CallRepository`                                 | S      |
| B3.3  | `can_*` из `CallPolicy`; `closureallowed` = `(int) can_close` (для совместимости)                                                                       | `CallRepository`                                         | XS     |
| B3.4  | Ротация refresh: при каждом refresh — новый refresh, старый удалять. Пришедший использованный refresh → удалить все refresh пользователя (reuse-детект) | `AuthController`, `UserRepository`                       | M      |
| B3.5  | Logout: отзывать access-токены пользователя (`deleteAccessToken` есть, не вызывается; добавить удаление по user_id)                                     | `AuthController`, `UserRepository`                       | XS     |
| B3.6  | `saveAccessToken` / `saveRefreshToken`: `FROM_UNIXTIME(:ts)` вместо `date()` — конвертация и сравнение с `NOW()` в одной зоне MySQL                     | `UserRepository`                                         | XS     |
| B3.7  | `Tenant::fromRequest`: `ApiException(TenantNotFound)` вместо `RuntimeException` (три места)                                                             | `Tenant`                                                 | XS     |
| B3.8  | `getSince`: `user_id AS actor_id` + `created_at` в SELECT                                                                                               | `NotificationsService`                                   | XS     |
| B3.9  | `bootstrap.php`: `date_default_timezone_set('Europe/Moscow')` — строковые даты в истории совпадают с UI                                                 | `bootstrap`                                              | XS     |
| B3.10 | Logout-cookie: параметры удаления зеркалят установку (secure/httponly/samesite)                                                                         | `AuthController`                                         | XS     |

**Приёмка B3:**

- [ ] Прямой `callClose` от guest → ошибка прав, заявка не закрыта; от engineer на чужой → то же
- [ ] Engineer на своей → закрыть/комментировать может, редактировать нет; `can_*` совпадают с кнопками
- [ ] Refresh дважды подряд: первый cookie недействителен, второй работает; reuse первого → все сессии пользователя сброшены
- [ ] Logout: старый access возвращает `token_invalid`
- [ ] Неизвестный домен: авторизованный запрос → `tenant_not_found`, не `internal_error`
- [ ] Пользователь не получает тостов о своих действиях
- [ ] История и UI показывают одинаковое время

---

## 4. Волна B4 — настройки и ключ организации (~1 день)

| №    | Задача                                                                                                                                                                                                                                                                         | Файл                          | Оценка |
| ---- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ | ----------------------------- | ------ |
| B4.1 | `get_user_settings`: профиль (id, surname, name=firstname, patronymic, role) + `column_settings` из `lift_user_settings`. Плоский legacy-формат трактовать как `open`                                                                                                          | `ApiController` + сервис      | S      |
| B4.2 | `save_user_settings`: профиль → три колонки ФИО + пересборка `user_name = trim(surname.' '.firstname.' '.patronymic)`; пароль (old/new, ≥6, ошибки `invalid_password`/`password_too_short`); `column_settings` per-scope в `lift_user_settings` (upsert)                       | там же                        | M      |
| B4.3 | `check_org_key` / `get_org_users`: **публичные** (вызываются до логина), роутинг в `api.php` рядом с `get_tenant_info`. Гейт — валидный `org_key` из `lift_options`. `get_org_users` → только `user_position='dispatcher'`, не заблокированные. Rate-limit 10/мин по IP на оба | `api.php`, `PublicController` | S      |
| B4.4 | Пустой `org_key` в `lift_options` = функция выключена, `invalid_key`. Значение задаётся через БД / будущую admin-страницу                                                                                                                                                      | —                             | XS     |

**Приёмка B4:**

- [ ] Профиль сохраняется, ФИО восстанавливается после F5 и релогина
- [ ] Смена пароля: неверный старый → `invalid_password`; короткий → `password_too_short`
- [ ] Настройки колонок per-scope сохраняются и читаются; плоский формат мигрирует при сохранении
- [ ] `get_org_users` без Bearer, с валидным ключом → список диспетчеров; с неверным → `invalid_key`
- [ ] 11 запросов за минуту → `rate_limited`

---

## 5. Cron-скрипт чистки

**Файл:** `cron_cleanup.php` (вне web-root или с секретным токеном). Вызов из панели хостинга раз в сутки, по образцу существующего `curl … > /dev/null`.

**Требования:**

1. Список тенантов из master-реестра; для каждого — `DB::forTenant`.
2. Пакетные удаления `LIMIT 1000` в цикле до нуля: `offline_command_log` (7д), `offline_sync_log` (30д), `offline_actions_archive` (30д), `lift_access_tokens` (`expires_at < NOW()`), `lift_refresh_tokens` (`expires_at < NOW()`).
3. Лог по тенанту и таблице: сколько удалено.
4. Ошибка одного тенанта не прерывает обход.
5. Защита: секретный токен в параметре, сверка с константой; без токена — 403 и выход.
6. EVENT `cleanup_offline_tables` **оставляем** (решение п.4), неактивен.

---

## 6. SQL-миграция

Скрипты 1.0 + 1.1 выданы ранее. Запускать **на каждой тенантской БД** до выкатки кода B1–B4. Идемпотентны. Ничего не удаляют и не меняют в существующих данных.

---

## 7. Выкатка и снятие переходных мер

| Шаг | Действие                                                                                                                                                                            | Фронт снимает                                                         |
| --- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | --------------------------------------------------------------------- |
| 1   | Миграция 1.0+1.1 на все тенанты                                                                                                                                                     | —                                                                     |
| 2   | Выкатка B1                                                                                                                                                                          | нормализацию `id` в `ticket-repository`                               |
| 3   | Выкатка B2                                                                                                                                                                          | двойные ключи `tickets`+`open_tickets`; парсинг `reason` из `message` |
| 4   | Выкатка B3, B4                                                                                                                                                                      | —                                                                     |
| 5   | Стабилизация 2–4 недели                                                                                                                                                             | —                                                                     |
| 6   | Удалить `offline_sync_log`, `batch_id` из контракта, `summary`; затем legacy-колонки токенов (`api_token`, `api_token_expires`, `webgl_info_spa`) — код их уже не читает после B1.8 | fallback `response.data \|\| response` (можно оставить)               |

Шаг 6 — отдельным согласованием, как и решено по пп.6–7 модификаций.

---

## 8. Что не делаем

| Что                                                                        | Куда                                                                        |
| -------------------------------------------------------------------------- | --------------------------------------------------------------------------- |
| Отчёты (`reports_*`, columns, экспорт, шрифты)                             | после правок, отдельное ТЗ                                                  |
| Admin-страница `setting` (роли, позиции, ФИО, разбор существующих)         | отдельная плоскость                                                         |
| Группы и права на группы                                                   | задел; `CallPolicy`/`CallScope` готовы к расширению                         |
| `include_hidden` / скрытые лифты                                           | убрано из контракта v4.3                                                    |
| `device_mismatch`                                                          | enum зарезервирован, проверка не реализуется (бета); ветка фронта безвредна |
| Rate-limit глобальный (120/60)                                             | P3, до прода; клиент готов                                                  |
| Защита от перебора пароля                                                  | P3, до прода                                                                |
| Словарь `event_type` (`ticket_note`→`note_added`), лимит уведомлений 50→20 | P3                                                                          |
| `archive_id`, `changes` в results; `staff_not_found`                       | P3                                                                          |

---

## 9. Открытые решения (два)

**1. `can_add_ticket` и `user_add_call`.** Инженер с флагом создаёт офлайн → `archived: no_rights` → работа потеряна. Рекомендация: **флаг уважать и в sync-пути** (`CallPolicy::canCreate` = admin/dispatcher **или** `user_add_call`) — это явное назначение админа, одинаково в обоих путях. Альтернатива — не выдавать `can_add_ticket` инженеру. Нужно одно слово.

**2. Меню `reports` до этапа отчётов.** Убрать совсем или оставить с заглушкой на фронте? Рекомендация — убрать, вернуть вместе с отчётами.

---

## 10. Оценки

| Волна     | Оценка      |
| --------- | ----------- |
| B1        | ~1 день     |
| B2        | ~1.5 дня    |
| B3        | ~1.5 дня    |
| B4        | ~1 день     |
| **Итого** | **~5 дней** |

Плюс миграция (минуты на тенант) и cron (входит в B2.15).

---

**Конец ТЗ бэкенда.** Все четыре документа выданы: `API_PROTOCOL.md` v4.3, `API_syncCommands.md` v5.4, ТЗ фронтенда, ТЗ бэкенда.

дополненеие

1. Фильтр по типу в JOIN (уже предлагал, теперь подтверждено 必要性). В listOpen, listClosed, findByIdDetailed:
   sql
   LEFT JOIN lift_types d ON c.call_department = d.type_id AND d.type = 1
   LEFT JOIN lift_types r ON c.call_request = r.type_id AND r.type = 2
   LEFT JOIN lift_types g ON c.call_group = g.type_id AND g.type = 3
   123
   Тогда id из чужой категории даст NULL → в карточке «—» вместо вводящего в заблуждение названия. Ошибка данных видна сразу.
2. Валидация категории справочника при записи. Сейчас callnew и calledit принимают любой int в request_id / group_id / department_id без проверки, что id принадлежит нужному типу. Добавить проверку: type_id существует и его type соответствует полю (1 для отдела, 2 для типа, 3 для группы). При несовпадении — invalid_input с reason invalid_dict_category.
