# Состояние проекта — Lift Control Systems PWA

Дата: 15.11.2026
Область: `frontend/`, vanilla JS + ES-модули + Vite + IndexedDB + Service Worker.
Основание: `API_PROTOCOL.md` v4.3, `API_syncCommands.md` v5.4, `frontend.md` (ТЗ волны 1–3), `architecture_frone.md`.

---

## 1. Статус волн

| Волна                               | Статус                  | Приёмка §5                        |
| ----------------------------------- | ----------------------- | --------------------------------- |
| 1 — баги, безопасность, офлайн-срок | закрыта                 | 11/11                             |
| 2 — поштучная синхронизация, версии | закрыта                 | 15/15 формально                   |
| 3 — per-user настройки и scope      | локальная часть закрыта | 5 сценариев не прогонялись        |
| 3 — серверная часть                 | заблокирована бэкендом  | `SERVER_SETTINGS_ENABLED = false` |
| СПульт (события `spult_error`)      | клиент закрыт           | ручной прогон не выполнялся       |

Всё нижеперечисленное подтверждено grep-ами **из репозитория**, не из выгрузки.

---

## 2. Закрыто и подтверждено

### Волна 1

`escape-html` корректен · regex `pending-overlay` корректен · `router` валидация param · picker срока скрыт офлайн в создании и правке · `repair_time` отсутствует в payload · `mergeIntoOfflineCreate` одна readwrite-транзакция · закрытая всегда через `fetchById` · `data-ts` + сортировка по атрибуту · backdrop в `unmount` · поколения в `refreshSilently` · `splice` вместо `.length=0` · `beforeunload` по всем четырём счётчикам · `normalizeTicketFields` семантика нуля · `ThemeController.unmount` в teardown.

### Волна 2

Мёртвые блоки `startSync` / `_linkCreatedTicket` удалены · `getDelayMs` удалён · индекс `[status, created_at]` · `getPendingBatch(1)` с пропуском blocked и backoff · два счётчика отказов · ручной режим персистентный · отложенные триггеры 5/3/2 с · `rejected` + чистка 7 дней · экран очереди 4 группы · индикатор 5 состояний · прогресс по каждой команде · `applied` только после применения · cooldown слоя 10 мин · backoff-будильник при `done > 0`.

### Волна 3 (локально)

`settings.js` v2 — 22 экспорта, per-user ключи `lift:{uid}:table:{scope}:…`, `reportSource` для отчётов, `getFreezeLeftOffset(scope)` · `tickets-controller` без `localStorage`, `setScope` в mount / `refreshColumns` / `_renderTableFull` · `main.js` — `applyUserSettings(uid, null)` **синхронно до первого await**, `resetSettings` на logout и auth:lost, `loadServerSettings` под флагом · `body-render` / `header-render` / `resizer` / `profile-controller` на новом API.

### Надёжность и гигиена

`create-controller` — один `_handleOfflineSave`, `offline === true` (все три кода), `isStale` после await, catch не создаёт офлайн-дубль при живой сети · `ticket-repository` — таймаут ≠ отмена · `queue-controller` — `escapeHtml` + `_isActive` / `_mountId` / `_renderSeq` · `sync-indicator` — единственный владелец шапки, `progressLabel`, порядок `el → guard → badge/label` · `notify` — dismiss-хэндлы, `fullText`, `maxLength` через `batch` · `menu-manager` — `_runChain` + гейт до записи сторов (§16.5) · `teardownApp` — `syncManager?.stop()`.

### СПульт

`config.EVENT_TOAST_TYPE` — `spult_error: "error"`, `ticket_edited: "info"` · poller — `EVENT_ALIASES` (`ticket_note → note_added`), `resolveToastType` с диагностикой неизвестных типов, `ticketId ?? null`, `maxLength: 500` · notify — полный текст в `title` · протокол — дельта §11.2 / §11.2.1 / §11.4.1 внесена.

---

## 3. Архитектурные правила

Базовые шесть — в `architecture_frone.md`. Дополнения, зафиксированные в этой сессии:

7. **Один источник истины по правам.** Карточка и любое новое меню считают права одной функцией. Дублирование логики запрещено.
8. **Один путь применения версий.** `sync:applied` ставится только после успешной записи. Второй apply-путь не создавать — переиспользовать `sync:applied_reset` + тик поллера.
9. **Запись данных не зависит от активности экрана.** После `isStale()` пропускается DOM и навигация, но сохранение в outbox, тост и история выполняются — иначе работа теряется.
10. **Отказ канала определяется по `resp.offline === true`.** Три кода: `network_error`, `aborted` (timeout), `invalid_response`. Проверка только `network_error` — дефект.
11. **`timeout` и `sound` принадлежат серверу** (§11.1). Клиентские per-type override не заводить.
12. **Нативное `contextmenu` не глушить** на `input`, `textarea`, `[contenteditable]`, `a`.
13. **id и address не скрываются и всегда зафиксированы.** Инвариант держится на UI (`isAbsoluteFixed`), в `settings.js` защита не реализована — см. п. 5.

---

## 4. Особенности кодовой базы

### Артефакты выгрузки

В присланном тексте систематически встречаются: пробелы внутри строковых литералов (`"pending "`), `() = >` вместо `=>`, `& &`, разорванные идентификаторы (`updateCountBa dge`, `state.use rId`), `<em>/` в комментариях, съеденные `_` перед кавычкой.

**Правило:** не переписывать файл из-за них, помечать «проверить в репозитории», логику оценивать по исправному чтению. Все проверенные случаи оказались артефактами — репозиторий чистый.

**Важно:** `main.js` лежит в корне `frontend/`, а не в `js/`. Команда `grep -rn … js/` его не покрывает.

Knowledge Base содержит накопленные копии файлов разных версий. Авторитетен только grep из репозитория.

### Зоны повышенного риска

Нормализация id/дат во всех точках входа · regex офлайн-комментариев · мёртвый код и дубли методов · `updateOutboxFlag` по четырём статусам · `force_create` только уровень команды и только из подтверждения · слияние офлайн-заявки одной транзакцией · приоритет состояний индикатора · версии applied и cooldown слоёв · валидация param роутера · teardown и дедупликация инициализации.

### Не является дефектом

Колбэк-заглушка в конструкторе `SyncManager` · `_sourceArray` / `_sourceIdx` в details (ТЗ §6) · отсутствие отчётов и admin-настроек · серверные дефекты, помеченные ⚠️ в протоколе.

---

## 5. Открытые позиции — фронтенд

| #   | Позиция                                                                                                                                         | Приоритет                      |
| --- | ----------------------------------------------------------------------------------------------------------------------------------------------- | ------------------------------ |
| 1   | `maxLength: 500` в poller применяется ко всем событиям; нужен условный спред только для `spult_error`                                           | мелочь                         |
| 2   | Инвариант id/address в `settings.js`: `buildColumns` верит `userHidden` безоговорочно, серверный `hidden: ["address"]` сломает липкую раскладку | существенный                   |
| 3   | п. 1.24 — два vite-конфига (`../vite.config.js` и `frontend/vite.config.js`), корневой удалить после diff                                       | существенный                   |
| 4   | Приёмка волны 3 — 5 сценариев не прогонялась                                                                                                    | приёмка                        |
| 5   | `tickets_cache` не разделён по пользователям — офлайн-строки предыдущего аккаунта видны следующему                                              | существенный, отдельная задача |
| 6   | `architecture_frone.md` — в одной копии `ctrl.isActive`, в другой `ctrl._isActive`; унифицировать на публичный `isActive`                       | мелочь                         |
| 7   | Дельта протокола дописана в конец файла — влить в тело §11.2 / §11.4                                                                            | мелочь                         |

### Гигиена одним коммитом

Неиспользуемые `API, AUTH` в menu-manager · fallback-меню выдаёт права administrator (урезать до create/open/closed) · `outboxQueue.markRetry` → `getAllCommands`, удалить шим `getAllPending` · `outboxQueue.getCounts` до 4 статусов или удалить · `\.` в `parseRuDateTime` · guard `status === "failed"` в `retryFailed` · мёртвые константы `OFFLINE.SYNC_BATCH_SIZE`, `MAX_SYNC_RETRIES`, `SYNC_COOLDOWN_MS`, `SYNC.VERSIONS_STORAGE_KEY`.

---

## 6. Открытые позиции — бэкенд

### Блокирующие волну 3

`get_user_settings` / `save_user_settings` — сейчас `unknown_action`. Без них серверная часть настроек выключена флагом.

### СПульт

`sound` по наличию `ticket_id` (одна строка в `NotificationsService::spultError`) · агрегация массовых расхождений (одно событие на смену адреса, не на лифт).

### Критичные из протокола

`id` в ответе `ticket` (§5.1) · `staff_id2/3` и `can_*` в списках (§17) — без них механик во 2/3 слоте не видит кнопки · общий слой проверки прав для online и sync (§20) · назначенность для engineer · два ключа версий вместо `tickets` (§11.3) · `reason` в `Response::error` (§16.1) · TTL-фильтры в SELECT · cron-чистка · `mapErrorCodeToReason` · `created_tickets` при `ignored` · идемпотентность `callnew` через `offline_uuid` · `AddComment` — дубль при таймауте нечем предотвратить.

---

## 7. Следующая фича — контекстное меню и быстрые действия

Спецификация согласована, не реализована. Оценка ~1 день.

### Объём

Наблюдатель `contextmenu` **только на таблице заявок** (`#dataTable`). Тач-логика вне объёма. Карточка, очередь, логин — вне объёма. Офлайн меню не открывается (одна неактивная строка «Ждём сети»).

### Состав меню

Контекстный блок по строке + системный блок через разделитель. Пункт «Обновить все данные» **исключён** (создавал второй путь применения версий). Остаётся «Проверить обновление приложения».

| Контекст                         | Пункты                                                                                                               |
| -------------------------------- | -------------------------------------------------------------------------------------------------------------------- |
| Открытая серверная заявка        | Посмотреть подробнее · Добавить комментарий (по праву) · Закрыть заявку (по праву)                                   |
| Строка `offline_` при живой сети | Посмотреть подробнее · Добавить комментарий (сворачивается в `CreateTicket`) · закрытие скрыто — паритет с карточкой |
| Закрытая заявка                  | только Посмотреть подробнее                                                                                          |

### Архитектура

**Сервис** (`components/context-menu.js`) — механизм: позиционирование с клампингом, закрытие на scroll/resize/blur/смену маршрута/перерисовку таблицы, клавиатура (Shift+F10, стрелки, Esc), `role="menu"`, фокус-трап и возврат, один инстанс, `createElement + textContent`. Про заявки не знает.

**Провайдер пунктов** — в `tickets-controller`, возвращает `[{id, label, disabled, hint, onSelect}]`. Права через общий `resolveTicketPermissions(ticket, user)` — тот же, что использует карточка; рефактор карточки входит в работу.

**Модалка** (`components/quick-action-modal.js`) — два режима (comment / close), чипсы шаблонов только для close, счётчик минимальной длины, Ctrl+Enter / Esc, игнор клика по фону при ≥3 символах.

### Обязательные условия

- Снапшот id + адрес в заголовок меню при открытии; **адрес брать из объекта в памяти**, не из DOM (колонка может быть скрыта). Подсветку строки не делать.
- Модалка: `_mountId` / `isStale()` после каждого await; **офлайн-ветка обязательна** — связь может пропасть пока модалка открыта; запись в outbox завершается даже если модалку закрыли.
- Валидация из `VALIDATION`: min 6 **и проверка капса** — паритет с карточкой.
- После офлайн-действия — явный `ctrl.refreshFromMemory(...)`: по `refreshSyncState` журнал не перерисовывается.
- После онлайн-закрытия — `sync:applied_reset` по `open_tickets` / `closed_tickets` + тик поллера.
- SW-пункт: три исхода (найдено сейчас / `waiting` уже был / актуальная версия), детект по сигналу `onNeedRefresh`, а не по состоянию `registration` сразу после `update()`; явный scope `/ui/`; dev-режим и отсутствие `serviceWorker` обработать; guard от повторных нажатий. Состояние SW и колбэк живут в `main.js`.
- `leaveAll()` → `menu.hide()` + `modal.close()`, close не отменяет начатое сохранение.
- z-index ниже тостов, выше липких `th`; цвета через переменные темы.
- `BUSINESS.QUICK_CLOSE_TEMPLATES` в `config.js`; заложить подмену из серверного `config` на будущее.

### Принятые риски

Дубль комментария при таймауте (у `AddComment` нет дубль-детекта) — persistent-тост «Сервер не подтвердил…» обязателен. Автовыход по неактивности закрывает модалку с набранным текстом — принято. Скрытие пунктов по правам — UX, не защита: в online-пути серверной проверки нет.

---

## 8. Переходные меры

| Мера                          | Где                                                    | Когда снять                         |
| ----------------------------- | ------------------------------------------------------ | ----------------------------------- |
| Нормализация id из `call_id`  | `ticket-repository.fetchById`, `normalizeTicketFields` | после `id` в ответе `ticket`        |
| `sv.tickets` → `open_tickets` | `notifications-poller`                                 | после двух ключей версий            |
| Разбор `reason` из `message`  | `sync-manager._reasonOf`                               | после поля `reason`                 |
| `resp.data \|\| resp`         | `sync-manager`                                         | после вложения под `data`           |
| `ticket_note` → `note_added`  | `notifications-poller`                                 | после унификации словаря на сервере |

---

## 9. Команды проверки

Из `frontend/`, Git Bash. Одинарные кавычки — иначе bash ловит `!` как history expansion.

```bash
npm run build

# Волна 3
grep -c 'export function\|export const' js/table/settings.js   # 22
grep -n 'localStorage' js/tickets-controller.js                # только комментарий
grep -n 'applyUserSettings\|resetSettings' main.js
grep -rn 'tableColumnOrder\|tableColumnHidden\|tableColumnWidths' js/

# СПульт
grep -n 'maxLength' js/notifications-poller.js
grep -n 'fullText\|maxLength' js/components/notify.js
grep -c 'dismiss' js/components/notify.js                      # 3

# Хвосты
ls vite.config.* ../vite.config.* 2>/dev/null                  # жду один
grep -rn '"auth:updated"' main.js js/                          # диспатчер в profile-controller
grep -n 'menu_structure' js/route/menu-manager.js              # гейт до записи сторов

# Артефакты (main.js в корне!)
grep -n '& &\|() = >' main.js
grep -rn '"pending "\|"CreateTicket "\|= >\|& &' js/
```

---

## 10. Приёмка

Волны 1 и 2 — по чек-листам `frontend.md` §5, закрыты.

Волна 3 — прогнать:

1. Два пользователя поочерёдно: свои колонки, сортировка, период, фильтр городов.
2. Ширины не пересекаются.
3. До логина настройки не применяются, ключи `lift:*` не создаются.
4. Смена пользователя без F5 — всё перечиталось, чужих строк нет.
5. `getFreezeLeftOffset("report") !== getFreezeLeftOffset("open")` при разной ширине id (из консоли, экрана отчётов ещё нет).

СПульт — прогнать: `ticket_id: null` + `timeout: 0` + `sound: 1` + текст > 200 символов → красный persistent без ссылки, полный текст по наведению; `ticket_id` есть + `sound: 0` → со ссылкой, без звука; `ticket_note` → info без warning; неизвестный тип → info + одна запись в истории.
