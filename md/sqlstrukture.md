# СТРУКТУРА БАЗЫ ДАННЫХ — Новый бэкенд (PostgreSQL 16)

**Версия:** 3.0  
**Дата:** 01.11.2026  
**Принцип:** Schema-per-tenant. Каждый тенант — отдельная схема PostgreSQL.

---

## ОГЛАВЛЕНИЕ

1. Принципы организации
2. Схема `public` — общие таблицы
3. Схема тенанта — пользователи и права
4. Схема тенанта — группы и закрепления
5. Схема тенанта — лифты
6. Схема тенанта — адреса
7. Схема тенанта — заявки
8. Схема тенанта — справочники и настройки
9. Схема тенанта — аудит и история
10. Схема тенанта — офлайн-синхронизация
11. Сводная таблица индексов
12. Примечания по типам данных

---

## 1. ПРИНЦИПЫ ОРГАНИЗАЦИИ

### 1.1. Разделение схем

| Схема           | Назначение                                     | Кто создаёт               |
| --------------- | ---------------------------------------------- | ------------------------- |
| `public`        | Общие справочники, конфигурация, мастер-данные | При инициализации системы |
| `tenant_<name>` | Данные конкретного тенанта                     | При создании тенанта      |

### 1.2. Префиксы полей

| Префикс   | Категория               | Таблица                |
| --------- | ----------------------- | ---------------------- |
| `object_` | Идентификация лифта     | `lift_object`          |
| `core_`   | Основные сведения       | `lift_object_core`     |
| `extra_`  | Дополнительные сведения | `lift_object_extra`    |
| `ds_`     | Диспетчеризация         | `lift_object_dispatch` |

### 1.3. Правила именования

- Таблицы — `snake_case`, множественное число не используется (сохраняем совместимость с legacy).
- Поля — `snake_case`.
- Первичные ключи — `id` (исключение: таблицы с составным смыслом, как `lift_object_core`, где PK = `object_id`).
- Внешние ключи — `<таблица>_id`.
- Флаги — `is_*`, `can_*`, `allow_*`.
- Временные метки — `created_at`, `updated_at`, `deleted_at`.

---

## 2. СХЕМА `public` — ОБЩИЕ ТАБЛИЦЫ

### 2.1. `public.tenants` — реестр тенантов

| Поле             | Тип          | Ограничения                                         | Назначение                                   |
| ---------------- | ------------ | --------------------------------------------------- | -------------------------------------------- |
| id               | SERIAL       | PRIMARY KEY                                         | ID тенанта                                   |
| name             | VARCHAR(100) | UNIQUE, NOT NULL                                    | Техническое имя (для схемы: `tenant_<name>`) |
| display_name     | VARCHAR(255) | NOT NULL                                            | Отображаемое название                        |
| subdomain        | VARCHAR(100) | UNIQUE, NOT NULL                                    | Поддомен (`l3`, `sh`)                        |
| schema_name      | VARCHAR(100) | UNIQUE, NOT NULL                                    | Имя схемы в PostgreSQL                       |
| org_key          | VARCHAR(64)  | UNIQUE                                              | Ключ организации для быстрого входа          |
| is_active        | BOOLEAN      | DEFAULT true                                        | Активен ли тенант                            |
| backend_type     | VARCHAR(20)  | CHECK IN ('new_api', 'legacy_proxy', 'trimmed_php') | Куда маршрутизируется                        |
| legacy_proxy_url | VARCHAR(500) | NULL                                                | URL legacy для проксирования                 |
| created_at       | TIMESTAMPTZ  | DEFAULT now()                                       | Дата создания                                |
| settings         | JSONB        | DEFAULT '{}'                                        | Дополнительные настройки                     |

**Индексы:**

- `UNIQUE (subdomain)`
- `UNIQUE (schema_name)`
- `INDEX idx_tenants_active (is_active) WHERE is_active = true`

---

### 2.2. `public.object_fields_description` — справочник полей лифта

| Поле            | Тип           | Ограничения                            | Назначение                          |
| --------------- | ------------- | -------------------------------------- | ----------------------------------- |
| id              | SERIAL        | PRIMARY KEY                            | ID записи                           |
| field_key       | VARCHAR(100)  | UNIQUE, NOT NULL                       | Техническое имя поля                |
| field_label     | VARCHAR(200)  | NOT NULL                               | Название для UI                     |
| field_category  | VARCHAR(20)   | CHECK IN ('core', 'extra', 'dispatch') | Категория                           |
| field_type      | VARCHAR(50)   | NOT NULL                               | Тип: text, number, date, bool, enum |
| is_sensitive    | BOOLEAN       | DEFAULT false                          | Секретное поле или нет              |
| is_editable     | BOOLEAN       | DEFAULT true                           | Можно ли редактировать              |
| validation_rule | VARCHAR(255)  | NULL                                   | Правило валидации                   |
| display_order   | INT           | DEFAULT 0                              | Порядок отображения                 |
| description     | VARCHAR(1000) | NULL                                   | Подсказка для пользователя          |
| enum_values     | JSONB         | NULL                                   | Значения для типа enum              |

---

### 2.3. `public.users_description_row` — справочник полей пользователей

| Поле          | Тип          | Ограничения      | Назначение           |
| ------------- | ------------ | ---------------- | -------------------- |
| id            | SERIAL       | PRIMARY KEY      | ID записи            |
| field_key     | VARCHAR(100) | UNIQUE, NOT NULL | Техническое имя поля |
| field_label   | VARCHAR(200) | NOT NULL         | Название для UI      |
| field_type    | VARCHAR(50)  | NOT NULL         | Тип поля             |
| is_required   | BOOLEAN      | DEFAULT false    | Обязательное ли поле |
| display_order | INT          | DEFAULT 0        | Порядок отображения  |

---

### 2.4. `public.system_roles` — справочник ролей (для валидации)

| Поле        | Тип          | Ограничения      | Назначение |
| ----------- | ------------ | ---------------- | ---------- |
| id          | SERIAL       | PRIMARY KEY      | ID         |
| role_code   | VARCHAR(50)  | UNIQUE, NOT NULL | Код роли   |
| role_name   | VARCHAR(100) | NOT NULL         | Название   |
| description | VARCHAR(500) | NULL             | Описание   |

Записи: `administrator`, `dispatcher`, `engineer`, `guest`.

---

### 2.5. `public.system_positions` — справочник должностных типов

| Поле              | Тип          | Ограничения                 | Назначение              |
| ----------------- | ------------ | --------------------------- | ----------------------- |
| id                | SERIAL       | PRIMARY KEY                 | ID                      |
| position_code     | VARCHAR(50)  | UNIQUE, NOT NULL            | Код должности           |
| position_name     | VARCHAR(100) | NOT NULL                    | Название                |
| base_role         | VARCHAR(50)  | FK → system_roles.role_code | Базовая роль            |
| allow_quick_login | BOOLEAN      | DEFAULT false               | Попадает в быстрый вход |
| description       | VARCHAR(500) | NULL                        | Описание                |

Записи: `dispatcher`, `foreman`, `mechanic`, `dispatch_equipment_mechanic`, `electronics_engineer`, `admin`, `guest`.

---

### 2.6. `public.role_position_matrix` — допустимые пары роль↔должность

| Поле          | Тип         | Ограничения           | Назначение |
| ------------- | ----------- | --------------------- | ---------- |
| role_code     | VARCHAR(50) | FK → system_roles     | Роль       |
| position_code | VARCHAR(50) | FK → system_positions | Должность  |

Первичный ключ: `(role_code, position_code)`.

Записи:

- `administrator` ↔ `admin`
- `dispatcher` ↔ `dispatcher`
- `dispatcher` ↔ `foreman`
- `engineer` ↔ `mechanic`
- `engineer` ↔ `dispatch_equipment_mechanic`
- `engineer` ↔ `electronics_engineer`
- `guest` ↔ `guest`

---

### 2.7. `public.request_types_reference` — справочник типов заявок

| Поле          | Тип          | Ограничения      | Назначение                                   |
| ------------- | ------------ | ---------------- | -------------------------------------------- |
| id            | SERIAL       | PRIMARY KEY      | ID                                           |
| type_code     | VARCHAR(50)  | UNIQUE, NOT NULL | Код типа                                     |
| type_name     | VARCHAR(200) | NOT NULL         | Название                                     |
| department_id | INT          | NULL             | Отдел (22 = Электромеханики, 23 = Аварийная) |
| is_emergency  | BOOLEAN      | DEFAULT false    | Это аварийный тип?                           |

---

## 3. СХЕМА ТЕНАНТА — ПОЛЬЗОВАТЕЛИ И ПРАВА

### 3.1. `lift_users` — пользователи

| Поле                         | Тип          | Ограничения      | Назначение                        |
| ---------------------------- | ------------ | ---------------- | --------------------------------- |
| user_id                      | SERIAL       | PRIMARY KEY      | ID пользователя                   |
| user_login                   | VARCHAR(100) | UNIQUE, NOT NULL | Логин                             |
| user_password                | VARCHAR(255) | NOT NULL         | Хэш пароля (Bcrypt/MD5/phpass)    |
| user_name                    | VARCHAR(255) | NOT NULL         | ФИО                               |
| user_phone                   | VARCHAR(39)  | NULL             | Телефон                           |
| user_email                   | VARCHAR(200) | NULL             | Email                             |
| user_role                    | VARCHAR(50)  | NOT NULL         | Роль доступа                      |
| user_position                | VARCHAR(50)  | NOT NULL         | Должностной тип                   |
| allow_dispatcher_quick_login | BOOLEAN      | DEFAULT true     | Разрешён быстрый вход             |
| user_block                   | SMALLINT     | DEFAULT 0        | Заблокирован (0/1)                |
| user_hiden                   | SMALLINT     | DEFAULT 0        | Скрыт из списков                  |
| user_edit_obj                | SMALLINT     | DEFAULT 0        | **DEPRECATED** — наследие         |
| user_edit_user               | SMALLINT     | DEFAULT 0        | **DEPRECATED** — наследие         |
| user_disppermission          | SMALLINT     | DEFAULT 0        | **DEPRECATED** — наследие         |
| user_add_call                | SMALLINT     | DEFAULT 0        | **DEPRECATED** — наследие         |
| user_read_all_calls          | SMALLINT     | DEFAULT 0        | **DEPRECATED** — наследие         |
| force_reload                 | BOOLEAN      | DEFAULT false    | Принудительный выход              |
| last_login                   | TIMESTAMPTZ  | NULL             | Последний вход                    |
| last_ip                      | VARCHAR(45)  | NULL             | Последний IP                      |
| login_attempts               | SMALLINT     | DEFAULT 0        | Счётчик неудачных попыток         |
| locked_until                 | TIMESTAMPTZ  | NULL             | Заблокирован до (при >5 попытках) |
| created_at                   | TIMESTAMPTZ  | DEFAULT now()    | Дата создания                     |
| updated_at                   | TIMESTAMPTZ  | DEFAULT now()    | Дата обновления                   |

**Индексы:**

- `UNIQUE (user_login)`
- `INDEX idx_users_role (user_role)`
- `INDEX idx_users_position (user_position)`
- `INDEX idx_users_quick_login (user_role, user_position, allow_dispatcher_quick_login, user_block, user_hiden) WHERE user_block = 0 AND user_hiden = 0`

**Примечание:** Поля `user_edit_obj`, `user_edit_user`, `user_disppermission`, `user_add_call`, `user_read_all_calls` сохраняются для миграции, но логика прав через них НЕ используется.

---

### 3.2. `user_group_access` — права пользователей на группы

| Поле                       | Тип         | Ограничения                                            | Назначение                              |
| -------------------------- | ----------- | ------------------------------------------------------ | --------------------------------------- |
| id                         | SERIAL      | PRIMARY KEY                                            | ID записи                               |
| user_id                    | INT         | FK → lift_users, NOT NULL                              | Пользователь                            |
| group_id                   | INT         | FK → elevator_groups, NOT NULL                         | Группа                                  |
| role                       | VARCHAR(20) | CHECK IN ('dispatcher', 'engineer', 'guest'), NOT NULL | Базовая роль в группе                   |
| base_permissions           | JSONB       | DEFAULT '{}'                                           | Жёсткое ядро прав роли                  |
| extra_permissions          | JSONB       | DEFAULT '{}'                                           | Дополнительные права от Админа          |
| can_view_dispatch_system   | BOOLEAN     | DEFAULT false                                          | Доступ к диспетчеризации                |
| can_create_users           | BOOLEAN     | DEFAULT false                                          | Право создавать пользователей           |
| can_reassign_staff         | BOOLEAN     | DEFAULT false                                          | Право переназначать ответственных       |
| can_manage_contract_status | BOOLEAN     | DEFAULT false                                          | Право менять vis                        |
| can_edit_spult_id          | BOOLEAN     | DEFAULT false                                          | Право менять abbreviated_name           |
| can_bulk_update_objects    | BOOLEAN     | DEFAULT false                                          | Право массового обновления              |
| can_bulk_move_objects      | BOOLEAN     | DEFAULT false                                          | Право массового переноса между группами |
| can_create_dispatchers     | BOOLEAN     | DEFAULT false                                          | Старший диспетчер: создание             |
| can_edit_dispatchers       | BOOLEAN     | DEFAULT false                                          | Старший диспетчер: редактирование       |
| can_block_dispatchers      | BOOLEAN     | DEFAULT false                                          | Старший диспетчер: блокировка           |
| created_at                 | TIMESTAMPTZ | DEFAULT now()                                          | Дата создания                           |
| updated_at                 | TIMESTAMPTZ | DEFAULT now()                                          | Дата обновления                         |
| granted_by                 | INT         | FK → lift_users, NULL                                  | Кто назначил права                      |

**Индексы:**

- `UNIQUE (user_id, group_id)` — одна запись на пару
- `INDEX idx_uga_user (user_id)`
- `INDEX idx_uga_group (group_id)`

---

### 3.3. `lift_refresh_tokens` — refresh-токены

| Поле               | Тип          | Ограничения               | Назначение              |
| ------------------ | ------------ | ------------------------- | ----------------------- |
| id                 | SERIAL       | PRIMARY KEY               | ID                      |
| user_id            | INT          | FK → lift_users, NOT NULL | Пользователь            |
| token_hash         | CHAR(64)     | UNIQUE, NOT NULL          | SHA-256 хэш токена      |
| device_fingerprint | VARCHAR(500) | NULL                      | Отпечаток устройства    |
| user_ip            | VARCHAR(45)  | NULL                      | IP при создании         |
| user_agent         | VARCHAR(255) | NULL                      | Браузер                 |
| expires_at         | TIMESTAMPTZ  | NOT NULL                  | Истекает (30 дней)      |
| last_used_at       | TIMESTAMPTZ  | NULL                      | Последнее использование |
| created_at         | TIMESTAMPTZ  | DEFAULT now()             | Дата создания           |

**Индексы:**

- `UNIQUE (token_hash)`
- `INDEX idx_refresh_user (user_id)`
- `INDEX idx_refresh_expires (expires_at)`

---

### 3.4. `revoked_tokens` — отозванные токены

| Поле       | Тип          | Ограничения     | Назначение                    |
| ---------- | ------------ | --------------- | ----------------------------- |
| id         | SERIAL       | PRIMARY KEY     | ID                            |
| user_id    | INT          | FK → lift_users | Пользователь                  |
| token_hash | CHAR(64)     | NOT NULL        | Хэш отозванного токена        |
| reason     | VARCHAR(255) | NULL            | Причина отзыва                |
| created_at | TIMESTAMPTZ  | DEFAULT now()   | Когда отозван                 |
| expires_at | TIMESTAMPTZ  | NOT NULL        | Когда можно удалить (30 дней) |

**Индексы:**

- `INDEX idx_revoked_hash (token_hash)`
- `INDEX idx_revoked_expires (expires_at)`

**Примечание:** Записи старше `expires_at` удаляются по cron.

---

## 4. СХЕМА ТЕНАНТА — ГРУППЫ И ЗАКРЕПЛЕНИЯ

### 4.1. `elevator_groups` — группы лифтов

| Поле        | Тип          | Ограничения           | Назначение                      |
| ----------- | ------------ | --------------------- | ------------------------------- |
| id          | SERIAL       | PRIMARY KEY           | ID группы                       |
| name        | VARCHAR(255) | NOT NULL              | Название группы                 |
| description | TEXT         | NULL                  | Описание                        |
| is_system   | BOOLEAN      | DEFAULT false         | Системная группа («Без группы») |
| is_active   | BOOLEAN      | DEFAULT true          | Активна ли группа               |
| created_at  | TIMESTAMPTZ  | DEFAULT now()         | Дата создания                   |
| created_by  | INT          | FK → lift_users, NULL | Кто создал                      |

**Индексы:**

- `UNIQUE (name) WHERE is_active = true` — имя уникально только среди активных
- `INDEX idx_groups_active (is_active) WHERE is_active = true`

**Примечание:**

- Системная группа «Без группы» создаётся автоматически при инициализации схемы (`is_system = true`, `id = 1`).
- Группы не удаляются, только деактивируются (`is_active = false`).
- Деактивация блокируется, если в группе есть лифты.

---

### 4.2. `user_elevator_assignment` — закрепление за лифтами

| Поле            | Тип          | Ограничения                                                                      | Назначение             |
| --------------- | ------------ | -------------------------------------------------------------------------------- | ---------------------- |
| id              | SERIAL       | PRIMARY KEY                                                                      | ID записи              |
| user_id         | INT          | FK → lift_users, NOT NULL                                                        | Механик / специалист   |
| object_id       | INT          | FK → lift_object, NOT NULL                                                       | Лифт                   |
| assignment_type | VARCHAR(30)  | CHECK IN ('mechanic', 'dispatch_specialist', 'electronics_specialist'), NOT NULL | Тип закрепления        |
| is_primary      | BOOLEAN      | DEFAULT true                                                                     | Основной или резервный |
| assigned_at     | TIMESTAMPTZ  | DEFAULT now()                                                                    | Дата закрепления       |
| assigned_by     | INT          | FK → lift_users                                                                  | Кто закрепил           |
| is_active       | BOOLEAN      | DEFAULT true                                                                     | Активно ли закрепление |
| unassigned_at   | TIMESTAMPTZ  | NULL                                                                             | Дата открепления       |
| unassigned_by   | INT          | FK → lift_users, NULL                                                            | Кто открепил           |
| unassign_reason | VARCHAR(255) | NULL                                                                             | Причина открепления    |

**Индексы:**

- `UNIQUE (user_id, object_id, assignment_type) WHERE is_active = true` — **partial unique index**
- `INDEX idx_ua_object_active (object_id, assignment_type) WHERE is_active = true`
- `INDEX idx_ua_user_active (user_id, assignment_type) WHERE is_active = true`

**Правила:**

- `assignment_type = 'mechanic'` → `user_position = 'mechanic'`
- `assignment_type = 'dispatch_specialist'` → `user_position = 'dispatch_equipment_mechanic'`
- `assignment_type = 'electronics_specialist'` → `user_position = 'electronics_engineer'`
- Прораб (`foreman`) не может быть закреплён ни в одном типе.

---

## 5. СХЕМА ТЕНАНТА — ЛИФТЫ

### 5.1. `lift_object` — лифты (идентификация)

| Поле                    | Тип          | Ограничения                                           | Назначение                    |
| ----------------------- | ------------ | ----------------------------------------------------- | ----------------------------- |
| object_id               | SERIAL       | PRIMARY KEY                                           | ID лифта                      |
| object_name             | VARCHAR(100) | NOT NULL                                              | Название (например, «п.1»)    |
| home_id                 | INT          | FK → lift_home                                        | Дом                           |
| group_id                | INT          | FK → elevator_groups, DEFAULT 1                       | Группа лифтов                 |
| contractor_id           | INT          | FK → contractors, NULL                                | Контрагент (владелец)         |
| object_kind             | VARCHAR(50)  | CHECK IN ('real', 'virtual_dispatch'), DEFAULT 'real' | Тип объекта                   |
| vis                     | BOOLEAN      | DEFAULT true                                          | Статус договора (видим ли)    |
| contract_suspended_at   | TIMESTAMPTZ  | NULL                                                  | Дата расторжения/приостановки |
| contract_suspend_reason | VARCHAR(500) | NULL                                                  | Причина расторжения           |
| abbreviated_name        | VARCHAR(100) | NULL                                                  | SPult ID                      |
| created_at              | TIMESTAMPTZ  | DEFAULT now()                                         | Дата создания                 |
| updated_at              | TIMESTAMPTZ  | DEFAULT now()                                         | Дата обновления               |

**Индексы:**

- `INDEX idx_objects_home (home_id)`
- `INDEX idx_objects_group (group_id)`
- `INDEX idx_objects_contractor (contractor_id)`
- `INDEX idx_objects_vis (vis) WHERE vis = true`
- `INDEX idx_objects_kind (object_kind)`
- `INDEX idx_objects_spult (abbreviated_name) WHERE abbreviated_name IS NOT NULL`

---

### 5.2. `lift_object_core` — основные сведения лифта

| Поле                      | Тип          | Ограничения           | Назначение                    |
| ------------------------- | ------------ | --------------------- | ----------------------------- |
| object_id                 | INT          | PK, FK → lift_object  | ID лифта                      |
| core_factory_number       | VARCHAR(100) | NULL                  | Заводской номер               |
| core_registry_number      | VARCHAR(100) | NULL                  | Регистрационный номер         |
| core_manufacturer         | VARCHAR(200) | NULL                  | Производитель                 |
| core_model                | VARCHAR(200) | NULL                  | Модель                        |
| core_capacity_kg          | INT          | NULL                  | Грузоподъёмность, кг          |
| core_year_installed       | INT          | NULL                  | Год ввода в эксплуатацию      |
| core_stops_count          | INT          | NULL                  | Количество остановок          |
| core_assigned_mechanic_id | INT          | FK → lift_users, NULL | **Кэш:** закреплённый механик |
| core_next_inspection_date | INT          | NULL                  | Дата техосмотра (Unix)        |

**Примечание:** `core_assigned_mechanic_id` — денормализованный кэш. Источник истины — `user_elevator_assignment`.

---

### 5.3. `lift_object_extra` — дополнительные сведения лифта

| Поле                  | Тип  | Ограничения          | Назначение              |
| --------------------- | ---- | -------------------- | ----------------------- |
| object_id             | INT  | PK, FK → lift_object | ID лифта                |
| extra_service_note    | TEXT | NULL                 | Заметка по обслуживанию |
| extra_access_note     | TEXT | NULL                 | Особенности доступа     |
| extra_contract_info   | TEXT | NULL                 | Договор / участок       |
| extra_inspection_note | TEXT | NULL                 | Примечания по осмотрам  |
| extra_mechanic_note   | TEXT | NULL                 | Заметка для механика    |

---

### 5.4. `lift_object_dispatch` — диспетчеризация лифта

| Поле                      | Тип          | Ограничения           | Назначение                    |
| ------------------------- | ------------ | --------------------- | ----------------------------- |
| object_id                 | INT          | PK, FK → lift_object  | ID лифта                      |
| ds_terminal_id            | VARCHAR(100) | NULL                  | ID терминала                  |
| ds_login                  | VARCHAR(100) | NULL                  | Логин                         |
| ds_password_encrypted     | VARCHAR(500) | NULL                  | Зашифрованный пароль          |
| ds_secret_key_encrypted   | VARCHAR(500) | NULL                  | Зашифрованный ключ            |
| ds_sim_phone              | VARCHAR(39)  | NULL                  | Номер SIM-карты               |
| ds_ip_address             | VARCHAR(45)  | NULL                  | IP-адрес                      |
| ds_port                   | INT          | NULL                  | Порт                          |
| ds_protocol               | VARCHAR(50)  | NULL                  | Протокол                      |
| ds_equipment_type         | VARCHAR(100) | NULL                  | Тип оборудования              |
| ds_last_maintenance_month | SMALLINT     | CHECK (1-12), NULL    | Месяц планового ремонта       |
| ds_assigned_specialist_id | INT          | FK → lift_users, NULL | **Кэш:** закреплённый связист |

**Примечание:** Поля `ds_password_encrypted`, `ds_secret_key_encrypted` шифруются через `Crypto`. В логах значения НЕ отображаются.

---

### 5.5. `object_visibility_history` — история изменений статуса договора

| Поле       | Тип          | Ограничения                | Назначение          |
| ---------- | ------------ | -------------------------- | ------------------- |
| id         | SERIAL       | PRIMARY KEY                | ID записи           |
| object_id  | INT          | FK → lift_object, NOT NULL | Лифт                |
| old_vis    | BOOLEAN      | NOT NULL                   | Старое значение     |
| new_vis    | BOOLEAN      | NOT NULL                   | Новое значение      |
| reason     | VARCHAR(500) | NULL                       | Причина             |
| is_bulk    | BOOLEAN      | DEFAULT false              | Массовое изменение? |
| changed_by | INT          | FK → lift_users            | Кто изменил         |
| changed_at | TIMESTAMPTZ  | DEFAULT now()              | Когда               |

**Индексы:**

- `INDEX idx_ovh_object (object_id)`
- `INDEX idx_ovh_changed_at (changed_at)`

---

### 5.6. `contractors` — контрагенты

| Поле          | Тип          | Ограничения           | Назначение                 |
| ------------- | ------------ | --------------------- | -------------------------- |
| id            | SERIAL       | PRIMARY KEY           | ID контрагента             |
| name          | VARCHAR(255) | NOT NULL              | Название организации / ФИО |
| inn           | VARCHAR(20)  | NULL                  | ИНН                        |
| contact_phone | VARCHAR(39)  | NULL                  | Телефон                    |
| contact_email | VARCHAR(200) | NULL                  | Email                      |
| notes         | TEXT         | NULL                  | Заметки                    |
| is_active     | BOOLEAN      | DEFAULT true          | Активен ли                 |
| created_at    | TIMESTAMPTZ  | DEFAULT now()         | Дата создания              |
| created_by    | INT          | FK → lift_users, NULL | Кто создал                 |

**Примечание:** Деактивация блокируется, если у контрагента есть лифты.

---

## 6. СХЕМА ТЕНАНТА — АДРЕСА

### 6.1. `lift_city` — города

| Поле      | Тип          | Ограничения  | Назначение      |
| --------- | ------------ | ------------ | --------------- |
| city_id   | SERIAL       | PRIMARY KEY  | ID города       |
| city_name | VARCHAR(255) | NOT NULL     | Название города |
| is_active | BOOLEAN      | DEFAULT true | Активен ли      |

---

### 6.2. `lift_street` — улицы

| Поле        | Тип          | Ограничения              | Назначение     |
| ----------- | ------------ | ------------------------ | -------------- |
| street_id   | SERIAL       | PRIMARY KEY              | ID улицы       |
| city_id     | INT          | FK → lift_city, NOT NULL | Город          |
| street_name | VARCHAR(255) | NOT NULL                 | Название улицы |
| is_active   | BOOLEAN      | DEFAULT true             | Активна ли     |

**Индексы:**

- `INDEX idx_street_city (city_id)`

---

### 6.3. `lift_home` — дома

| Поле        | Тип         | Ограничения                | Назначение |
| ----------- | ----------- | -------------------------- | ---------- |
| home_id     | SERIAL      | PRIMARY KEY                | ID дома    |
| street_id   | INT         | FK → lift_street, NOT NULL | Улица      |
| home_number | VARCHAR(50) | NOT NULL                   | Номер дома |
| is_active   | BOOLEAN     | DEFAULT true               | Активен ли |

**Индексы:**

- `INDEX idx_home_street (street_id)`

---

## 7. СХЕМА ТЕНАНТА — ЗАЯВКИ

### 7.1. `lift_calls` — заявки

| Поле                   | Тип          | Ограничения                   | Назначение                            |
| ---------------------- | ------------ | ----------------------------- | ------------------------------------- |
| call_id                | SERIAL       | PRIMARY KEY                   | ID заявки                             |
| call_number            | VARCHAR(50)  | NULL                          | Номер заявки (для поиска)             |
| call_status            | SMALLINT     | CHECK IN (0, 1), DEFAULT 0    | 0 = открыта, 1 = закрыта              |
| call_date              | TIMESTAMPTZ  | DEFAULT now()                 | Дата создания                         |
| call_date2             | TIMESTAMPTZ  | NULL                          | Дата закрытия                         |
| object_id              | INT          | FK → lift_object, NOT NULL    | Лифт                                  |
| elevator_group_id      | INT          | FK → elevator_groups          | Группа на момент создания             |
| city_id                | INT          | FK → lift_city                | Город                                 |
| street_id              | INT          | FK → lift_street              | Улица                                 |
| home_id                | INT          | FK → lift_home                | Дом                                   |
| address_text           | VARCHAR(500) | NULL                          | Текстовый адрес (для офлайн)          |
| address_not_verified   | BOOLEAN      | DEFAULT false                 | Адрес не проверен                     |
| call_department        | INT          | NULL                          | Отдел (тип справочника 1)             |
| call_request           | INT          | NULL                          | Тип неисправности (тип справочника 3) |
| call_priority          | INT          | NULL                          | Приоритет (тип справочника 2)         |
| call_group             | INT          | NULL                          | Группа заявки (внутренняя)            |
| details                | TEXT         | NOT NULL                      | Описание (мин. 6 символов)            |
| call_phone             | VARCHAR(39)  | NULL                          | Телефон заявителя                     |
| call_first_name        | VARCHAR(100) | NULL                          | Имя заявителя                         |
| call_last_name         | VARCHAR(100) | NULL                          | Фамилия заявителя                     |
| call_staff             | INT          | FK → lift_users, NULL         | Ответственный                         |
| call_staff_date        | TIMESTAMPTZ  | NULL                          | Дата назначения ответственного        |
| call_staff_status      | SMALLINT     | DEFAULT 0                     | Статус работы ответственного          |
| expected_repair_time   | INT          | NULL                          | Ожидаемое время ремонта (Unix)        |
| notify_status          | SMALLINT     | DEFAULT 0                     | Способ уведомления (0-7)              |
| alert_level            | SMALLINT     | CHECK IN (1, 2, 3), DEFAULT 1 | Уровень тревоги                       |
| is_emergency           | BOOLEAN      | DEFAULT false                 | Заявка Аварийной службы               |
| offline_uuid           | VARCHAR(64)  | UNIQUE, NULL                  | UUID для офлайн-синхронизации         |
| call_solution          | TEXT         | NULL                          | Решение при закрытии                  |
| call_fullhistory       | TEXT         | NULL                          | Полная история при закрытии           |
| call_full_note_history | JSONB        | NULL                          | Комментарии при закрытии              |
| call_last_name         | VARCHAR(255) | NULL                          | Кто закрыл                            |
| created_by             | INT          | FK → lift_users               | Кто создал                            |
| created_at             | TIMESTAMPTZ  | DEFAULT now()                 | Дата создания записи                  |
| updated_at             | TIMESTAMPTZ  | DEFAULT now()                 | Дата обновления                       |

**Индексы:**

- `UNIQUE (offline_uuid) WHERE offline_uuid IS NOT NULL`
- `INDEX idx_calls_status (call_status)`
- `INDEX idx_calls_object (object_id)`
- `INDEX idx_calls_group (elevator_group_id)`
- `INDEX idx_calls_staff (call_staff)`
- `INDEX idx_calls_date (call_date)`
- `INDEX idx_calls_number (call_number)`
- `INDEX idx_calls_emergency (is_emergency) WHERE is_emergency = true`
- `INDEX idx_calls_search (call_number, call_date, call_status)`
- `INDEX idx_calls_open_by_group (elevator_group_id, call_status) WHERE call_status = 0`
- `INDEX idx_calls_alert (alert_level) WHERE alert_level >= 2`

**Примечания:**

- `elevator_group_id` денормализован — фиксирует группу на момент создания заявки. При переносе лифта в другую группу открытые заявки остаются в старой группе.
- `is_emergency` выставляется на основе `call_department` или `call_request` (Аварийная служба).
- `call_number` генерируется автоматически (например, `YYYYMMDD-NNNN`).

---

### 7.2. `lift_notes` — комментарии к заявкам

| Поле          | Тип          | Ограничения               | Назначение        |
| ------------- | ------------ | ------------------------- | ----------------- |
| note_id       | SERIAL       | PRIMARY KEY               | ID комментария    |
| note_relation | INT          | FK → lift_calls, NOT NULL | Заявка            |
| note          | TEXT         | NOT NULL                  | Текст комментария |
| img_name      | VARCHAR(255) | NULL                      | Имя файла фото    |
| user_id       | INT          | FK → lift_users           | Автор             |
| note_date     | TIMESTAMPTZ  | DEFAULT now()             | Дата              |

**Индексы:**

- `INDEX idx_notes_call (note_relation)`
- `INDEX idx_notes_user (user_id)`

**Примечание:** Лимит фото — максимум 2 на заявку. При закрытии заявки комментарии сериализуются в `call_full_note_history` и удаляются из таблицы.

---

### 7.3. `lift_history` — история действий по заявкам

| Поле       | Тип          | Ограничения               | Назначение      |
| ---------- | ------------ | ------------------------- | --------------- |
| history_id | SERIAL       | PRIMARY KEY               | ID записи       |
| call_id    | INT          | FK → lift_calls, NOT NULL | Заявка          |
| user_id    | INT          | FK → lift_users           | Кто сделал      |
| action     | VARCHAR(100) | NOT NULL                  | Действие        |
| old_value  | TEXT         | NULL                      | Старое значение |
| new_value  | TEXT         | NULL                      | Новое значение  |
| created_at | TIMESTAMPTZ  | DEFAULT now()             | Когда           |

**Индексы:**

- `INDEX idx_history_call (call_id)`
- `INDEX idx_history_user (user_id)`
- `INDEX idx_history_created (created_at)`

---

## 8. СХЕМА ТЕНАНТА — СПРАВОЧНИКИ И НАСТРОЙКИ

### 8.1. `lift_types` — справочники

| Поле          | Тип          | Ограничения  | Назначение                                 |
| ------------- | ------------ | ------------ | ------------------------------------------ |
| type_id       | SERIAL       | PRIMARY KEY  | ID записи                                  |
| type          | SMALLINT     | NOT NULL     | Категория (1=отделы, 2=приоритеты, 3=типы) |
| type_name     | VARCHAR(255) | NOT NULL     | Название                                   |
| type_value    | VARCHAR(100) | NULL         | Дополнительное значение                    |
| is_active     | BOOLEAN      | DEFAULT true | Активна ли запись                          |
| display_order | INT          | DEFAULT 0    | Порядок отображения                        |

**Индексы:**

- `INDEX idx_types_type (type)`
- `INDEX idx_types_active (type, is_active) WHERE is_active = true`

**Примеры записей:**

- `type=1, type_id=22`: Электромеханики
- `type=1, type_id=23`: Аварийная служба
- `type=3, type_id=24`: Неисправность дисп. об.

---

### 8.2. `lift_options` — настройки тенанта

| Поле         | Тип          | Ограничения   | Назначение      |
| ------------ | ------------ | ------------- | --------------- |
| option_key   | VARCHAR(100) | PRIMARY KEY   | Ключ настройки  |
| option_value | TEXT         | NULL          | Значение        |
| description  | VARCHAR(500) | NULL          | Описание        |
| updated_at   | TIMESTAMPTZ  | DEFAULT now() | Дата обновления |

**Примеры записей:**

- `min_length_text` = `6`
- `db_version` = `3.0`
- `groups_limit` = `32`
- `photo_limit_per_call` = `2`

---

### 8.3. `lift_upload` — загруженные файлы

| Поле        | Тип          | Ограничения     | Назначение      |
| ----------- | ------------ | --------------- | --------------- |
| upload_id   | SERIAL       | PRIMARY KEY     | ID файла        |
| call_id     | INT          | FK → lift_calls | Заявка          |
| file_path   | VARCHAR(500) | NOT NULL        | Путь к файлу    |
| file_name   | VARCHAR(255) | NOT NULL        | Имя файла       |
| file_size   | INT          | NULL            | Размер в байтах |
| mime_type   | VARCHAR(100) | NULL            | MIME-тип        |
| uploaded_by | INT          | FK → lift_users | Кто загрузил    |
| uploaded_at | TIMESTAMPTZ  | DEFAULT now()   | Когда           |
| is_archived | BOOLEAN      | DEFAULT false   | Архивирован?    |

**Индексы:**

- `INDEX idx_upload_call (call_id)`
- `INDEX idx_upload_archived (is_archived) WHERE is_archived = true`

---

### 8.4. `lift_telegram` — интеграция с Telegram

| Поле             | Тип         | Ограничения     | Назначение          |
| ---------------- | ----------- | --------------- | ------------------- |
| id               | SERIAL      | PRIMARY KEY     | ID                  |
| user_id          | INT         | FK → lift_users | Пользователь        |
| telegram_chat_id | VARCHAR(50) | NULL            | Chat ID             |
| is_active        | BOOLEAN     | DEFAULT true    | Активна ли подписка |
| created_at       | TIMESTAMPTZ | DEFAULT now()   | Дата                |

---

### 8.5. `reports_saved` — сохранённые отчёты

| Поле         | Тип          | Ограничения               | Назначение              |
| ------------ | ------------ | ------------------------- | ----------------------- |
| id           | SERIAL       | PRIMARY KEY               | ID отчёта               |
| user_id      | INT          | FK → lift_users, NOT NULL | Кто создал              |
| name         | VARCHAR(255) | NOT NULL                  | Название                |
| filters      | JSONB        | NOT NULL                  | Фильтры отчёта          |
| is_default   | BOOLEAN      | DEFAULT false             | По умолчанию            |
| created_at   | TIMESTAMPTZ  | DEFAULT now()             | Дата создания           |
| last_used_at | TIMESTAMPTZ  | NULL                      | Последнее использование |

**Структура `filters` (JSONB):**

```
{
  "call_number": "...",
  "object_id": 45,
  "home_id": 12,
  "mechanic_id": 5,
  "date_from": "2026-01-01",
  "date_to": "2026-12-31",
  "status": "open|closed|all",
  "exclude_emergency": true,
  "call_department": 22,
  "call_request": 4
}
```

---

## 9. СХЕМА ТЕНАНТА — АУДИТ

### 9.1. `audit_log` — общий аудит

| Поле           | Тип          | Ограничения           | Назначение                        |
| -------------- | ------------ | --------------------- | --------------------------------- |
| id             | BIGSERIAL    | PRIMARY KEY           | ID записи                         |
| user_id        | INT          | FK → lift_users, NULL | Кто сделал (может быть системным) |
| action         | VARCHAR(100) | NOT NULL              | Действие                          |
| entity_type    | VARCHAR(50)  | NOT NULL              | Тип сущности                      |
| entity_id      | INT          | NULL                  | ID сущности                       |
| old_value      | TEXT         | NULL                  | Старое значение                   |
| new_value      | TEXT         | NULL                  | Новое значение                    |
| ip_address     | VARCHAR(45)  | NULL                  | IP                                |
| user_agent     | VARCHAR(255) | NULL                  | Браузер/клиент                    |
| correlation_id | VARCHAR(64)  | NULL                  | Correlation ID запроса            |
| description    | VARCHAR(500) | NULL                  | Человекочитаемое описание         |
| created_at     | TIMESTAMPTZ  | DEFAULT now()         | Когда                             |

**Индексы:**

- `INDEX idx_audit_user (user_id)`
- `INDEX idx_audit_action (action)`
- `INDEX idx_audit_entity (entity_type, entity_id)`
- `INDEX idx_audit_created (created_at)`
- `INDEX idx_audit_correlation (correlation_id)`

**Примечание:** Таблица **только для записи (append-only)**. Удаление и редактирование записей запрещено на уровне интерфейса. Для больших объёмов — партиционирование по `created_at`.

**Правило для секретных полей:** При изменении `ds_password_encrypted`, `ds_secret_key_encrypted` поля `old_value` и `new_value` НЕ заполняются. Логируется только факт изменения.

---

### 9.2. Список действий аудита

| action                     | entity_type | Когда                         |
| -------------------------- | ----------- | ----------------------------- |
| `user.login`               | user        | Вход в систему                |
| `user.logout`              | user        | Выход                         |
| `user.create`              | user        | Создание пользователя         |
| `user.block`               | user        | Блокировка                    |
| `user.unblock`             | user        | Разблокировка                 |
| `rights.create`            | user        | Назначение прав на группу     |
| `rights.update`            | user        | Изменение прав                |
| `rights.delete`            | user        | Удаление прав                 |
| `call.create`              | call        | Создание заявки               |
| `call.edit`                | call        | Редактирование заявки         |
| `call.close`               | call        | Закрытие заявки               |
| `call.note`                | call        | Комментарий к заявке          |
| `call.reassign`            | call        | Переназначение ответственного |
| `offline.sync`             | call        | Офлайн-синхронизация          |
| `group.create`             | group       | Создание группы               |
| `group.update`             | group       | Редактирование группы         |
| `group.deactivate`         | group       | Деактивация группы            |
| `elevator.update`          | elevator    | Изменение лифта               |
| `elevator.bulk_update`     | elevator    | Массовое обновление           |
| `elevator.move_group`      | elevator    | Перенос лифта в другую группу |
| `elevator.bulk_move_group` | elevator    | Массовый перенос              |
| `assignment.create`        | assignment  | Закрепление механика          |
| `assignment.delete`        | assignment  | Открепление                   |
| `contractor.create`        | contractor  | Создание контрагента          |
| `contractor.update`        | contractor  | Изменение контрагента         |
| `contractor.deactivate`    | contractor  | Деактивация                   |
| `contract.suspend`         | elevator    | Расторжение договора          |
| `contract.resume`          | elevator    | Возобновление договора        |
| `dispatch.view_secret`     | elevator    | Просмотр секретного поля      |
| `report.export`            | report      | Экспорт отчёта                |
| `spult_id.change`          | elevator    | Изменение SPult ID            |

---

## 10. СХЕМА ТЕНАНТА — ОФЛАЙН-СИНХРОНИЗАЦИЯ

### 10.1. `offline_sync_log` — лог синхронизации

| Поле            | Тип         | Ограничения                                                             | Назначение                |
| --------------- | ----------- | ----------------------------------------------------------------------- | ------------------------- |
| id              | SERIAL      | PRIMARY KEY                                                             | ID записи                 |
| batch_id        | VARCHAR(64) | UNIQUE, NOT NULL                                                        | Уникальный ID пачки       |
| user_id         | INT         | FK → lift_users, NOT NULL                                               | Кто синхронизировал       |
| tickets_count   | INT         | NOT NULL                                                                | Количество заявок в пачке |
| status          | VARCHAR(20) | CHECK IN ('started', 'success', 'failed', 'partial'), DEFAULT 'started' | Статус                    |
| started_at      | TIMESTAMPTZ | DEFAULT now()                                                           | Начало                    |
| finished_at     | TIMESTAMPTZ | NULL                                                                    | Окончание                 |
| error_message   | TEXT        | NULL                                                                    | Текст ошибки              |
| tickets_created | INT         | DEFAULT 0                                                               | Создано                   |
| tickets_skipped | INT         | DEFAULT 0                                                               | Пропущено (дубликаты)     |
| tickets_failed  | INT         | DEFAULT 0                                                               | Ошибки                    |

**Индексы:**

- `UNIQUE (batch_id)`
- `INDEX idx_offline_user (user_id)`
- `INDEX idx_offline_status (status)`

---

## 11. СВОДНАЯ ТАБЛИЦА ИНДЕКСОВ

### 11.1. Уникальные ограничения

| Таблица                    | Поля                                    | Условие                          |
| -------------------------- | --------------------------------------- | -------------------------------- |
| `lift_users`               | `user_login`                            | —                                |
| `user_group_access`        | `(user_id, group_id)`                   | —                                |
| `user_elevator_assignment` | `(user_id, object_id, assignment_type)` | `WHERE is_active = true`         |
| `lift_calls`               | `offline_uuid`                          | `WHERE offline_uuid IS NOT NULL` |
| `elevator_groups`          | `name`                                  | `WHERE is_active = true`         |
| `offline_sync_log`         | `batch_id`                              | —                                |
| `lift_refresh_tokens`      | `token_hash`                            | —                                |
| `public.tenants`           | `subdomain`                             | —                                |
| `public.tenants`           | `schema_name`                           | —                                |

### 11.2. Ключевые индексы производительности

| Таблица                    | Индекс                                                   | Назначение                 |
| -------------------------- | -------------------------------------------------------- | -------------------------- |
| `lift_calls`               | `(call_status)`                                          | Фильтр по статусу          |
| `lift_calls`               | `(elevator_group_id, call_status) WHERE call_status = 0` | Открытые заявки по группам |
| `lift_calls`               | `(call_staff)`                                           | Заявки механика            |
| `lift_calls`               | `(call_number, call_date, call_status)`                  | Поиск по номеру            |
| `lift_calls`               | `(is_emergency) WHERE is_emergency = true`               | Фильтр Аварийной           |
| `lift_calls`               | `(alert_level) WHERE alert_level >= 2`                   | Критичные заявки           |
| `lift_object`              | `(group_id)`                                             | Лифты по группам           |
| `lift_object`              | `(vis) WHERE vis = true`                                 | Активные лифты             |
| `lift_object`              | `(contractor_id)`                                        | Лифты по контрагенту       |
| `user_elevator_assignment` | `(object_id, assignment_type) WHERE is_active = true`    | Закрепления лифта          |
| `user_elevator_assignment` | `(user_id, assignment_type) WHERE is_active = true`      | Закрепления механика       |
| `audit_log`                | `(created_at)`                                           | Сортировка по дате         |

---

## 12. ПРИМЕЧАНИЯ ПО ТИПАМ ДАННЫХ

### 12.1. Выбор типов

| Что             | Тип           | Почему                                                           |
| --------------- | ------------- | ---------------------------------------------------------------- |
| Временные метки | `TIMESTAMPTZ` | Всегда с таймзоной (хранится в UTC)                              |
| Флаги           | `BOOLEAN`     | В отличие от legacy (`TINYINT`), PostgreSQL нативно поддерживает |
| Статусы заявок  | `SMALLINT`    | Совместимость с legacy (`0`/`1`)                                 |
| JSON-данные     | `JSONB`       | Бинарный формат, поддержка индексов GIN                          |
| UUID офлайн     | `VARCHAR(64)` | Совместимость с legacy                                           |
| Хэши токенов    | `CHAR(64)`    | SHA-256 = 64 hex-символа                                         |

### 12.2. Правила миграции из МарияDB

| MariaDB              | PostgreSQL                                  | Примечание           |
| -------------------- | ------------------------------------------- | -------------------- |
| `TINYINT` (флаги)    | `BOOLEAN`                                   | 0 → false, 1 → true  |
| `DATETIME`           | `TIMESTAMPTZ`                               | Конвертация в UTC    |
| `JSON`               | `JSONB`                                     | Бинарный формат      |
| `TEXT`               | `TEXT`                                      | Без изменений        |
| `INT AUTO_INCREMENT` | `SERIAL` или `GENERATED ALWAYS AS IDENTITY` | Рекомендуется второе |

### 12.3. Особенности для схемы `public`

Таблицы в схеме `public` — только справочники и мастер-данные. Все бизнес-данные (заявки, пользователи, лифты) — в схемах тенантов.

Подключение к БД:

```
-- Переключение на схему тенанта
SET search_path TO tenant_l3, public;

-- Все запросы идут в tenant_l3, справочники берутся из public
SELECT * FROM lift_calls;        -- из tenant_l3
SELECT * FROM system_positions;  -- из public
```

### 12.4. Инициализация нового тенанта

При создании нового тенанта автоматически:

1. Создаётся схема `tenant_<name>`.
2. Применяются все миграции.
3. Создаётся системная группа «Без группы» (`id = 1`, `is_system = true`).
4. Создаётся пользователь-админ.
5. Заполняются справочники `lift_types`.
6. Заполняются настройки `lift_options`.
7. В `public.tenants` добавляется запись с `backend_type = 'new_api'`.

---

## СВОДКА ТАБЛИЦ

### Схема `public` (7 таблиц)

| Таблица                     | Назначение                     |
| --------------------------- | ------------------------------ |
| `tenants`                   | Реестр тенантов                |
| `object_fields_description` | Справочник полей лифта         |
| `users_description_row`     | Справочник полей пользователей |
| `system_roles`              | Роли доступа                   |
| `system_positions`          | Должностные типы               |
| `role_position_matrix`      | Допустимые пары роль↔должность |
| `request_types_reference`   | Типы заявок                    |

### Схема тенанта (24 таблицы)

**Пользователи и права (4):**

- `lift_users`
- `user_group_access`
- `lift_refresh_tokens`
- `revoked_tokens`

**Группы и закрепления (2):**

- `elevator_groups`
- `user_elevator_assignment`

**Лифты (6):**

- `lift_object`
- `lift_object_core`
- `lift_object_extra`
- `lift_object_dispatch`
- `object_visibility_history`
- `contractors`

**Адреса (3):**

- `lift_city`
- `lift_street`
- `lift_home`

**Заявки (3):**

- `lift_calls`
- `lift_notes`
- `lift_history`

**Справочники и настройки (5):**

- `lift_types`
- `lift_options`
- `lift_upload`
- `lift_telegram`
- `reports_saved`

**Аудит и офлайн (2):**

- `audit_log`
- `offline_sync_log`

---

**Конец документа.**
