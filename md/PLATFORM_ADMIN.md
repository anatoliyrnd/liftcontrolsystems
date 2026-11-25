Отлично, теперь у меня есть полная картина. Начну с документа, затем дам код.

---

# 📋 PLATFORM_ADMIN.md — v1.0

```markdown
📋 PLATFORM_ADMIN.md — v1.0
Версия: 1.0
Дата: 26.11.2026
Статус: реализовано
Область: `admin/` (Platform Admin — super admin)
Связанные документы: `ORGANIZATION_ADMIN.md` v1.1, `REPORTS.md`, `ReportsAccess.php`

## 0. Назначение и границы

Platform Admin — интерфейс супер-администратора для управления тенантами (организациями) и системными настройками.

### Что это такое

| Плоскость                      | Что это                         | Где живёт                                                 |
| ------------------------------ | ------------------------------- | --------------------------------------------------------- |
| Platform Admin (этот документ) | Управление тенантами и системой | `admin/` (tenants.php, tenant_edit.php, tenants_save.php) |
| Organization Settings          | Настройки одного тенанта        | `company/setting.php`                                     |
| SPA диспетчера                 | Рабочее место диспетчера        | `frontend/mobile/`                                        |

Platform Admin не пересекается с Organization Settings, не управляет пользователями внутри тенанта и не заменяет SPA.

### Принципы

- Авторизация — только `$_SESSION['admin_logged_in']`. JWT-инфраструктура отсутствует.
- CSRF — не реализован (наследие текущей реализации).
- Аудит — не реализован (отдельная итерация).
- Бизнес-логика — в сервисах (`App\Registry`), SQL — только в репозиториях.
- Уровни доступа к отчётам — свойство тенанта в центральной БД, не пользователя.

## 1. Структура файлов
```

admin/
├── index.php ← точка входа, авторизация
├── tenants.php ← список организаций
├── tenant_edit.php ← редактирование организации
├── tenants_save.php ← сохранение изменений
└── cleanup_tenant.php ← очистка уведомлений тенанта

````

## 2. Авторизация

Проверка на каждом запросе:

```php
session_start();
if (empty($_SESSION['admin_logged_in'])) {
    header('Location: /admin/');
    exit;
}
````

Выход через `?logout=1` — очистка сессии.

## 3. Таблица `organizations` (центральная БД)

Единственная таблица Platform Admin.

| Колонка              | Тип                                                               | Назначение                                      |
| -------------------- | ----------------------------------------------------------------- | ----------------------------------------------- |
| `id`                 | `INT(11) NOT NULL AUTO_INCREMENT`                                 | Первичный ключ                                  |
| `subdomain`          | `VARCHAR(63) NOT NULL UNIQUE`                                     | Поддомен тенанта                                |
| `org_name`           | `VARCHAR(255) NOT NULL`                                           | Название организации                            |
| `db_host`            | `VARCHAR(255) NOT NULL`                                           | Хост БД тенанта                                 |
| `db_port`            | `INT(11) NOT NULL DEFAULT 3306`                                   | Порт БД тенанта                                 |
| `db_name`            | `VARCHAR(64) NOT NULL`                                            | Имя БД тенанта                                  |
| `db_user`            | `VARCHAR(64) NOT NULL`                                            | Логин БД тенанта                                |
| `db_password`        | `TEXT NOT NULL`                                                   | Пароль БД (шифрованный через `Crypto::encrypt`) |
| `is_active`          | `TINYINT(1) NOT NULL DEFAULT 1`                                   | Статус тенанта (активен/отключен)               |
| `created_at`         | `TIMESTAMP NULL DEFAULT CURRENT_TIMESTAMP`                        | Дата создания                                   |
| `legacy_compat`      | `TINYINT(1) NOT NULL DEFAULT 1`                                   | Режим легаси-прокси                             |
| `reports_level`      | `ENUM('light','standard','extended') NOT NULL DEFAULT 'standard'` | Уровень доступа к отчётам                       |
| `reports_access_rev` | `INT(10) UNSIGNED NOT NULL DEFAULT 1`                             | Счётчик доставки изменений уровня               |

### SQL-схема

```sql
CREATE TABLE `organizations` (
  `id` int(11) NOT NULL AUTO_INCREMENT,
  `subdomain` varchar(63) NOT NULL,
  `org_name` varchar(255) NOT NULL,
  `db_host` varchar(255) NOT NULL,
  `db_port` int(11) NOT NULL DEFAULT 3306,
  `db_name` varchar(64) NOT NULL,
  `db_user` varchar(64) NOT NULL,
  `db_password` text NOT NULL,
  `is_active` tinyint(1) NOT NULL DEFAULT 1,
  `created_at` timestamp NULL DEFAULT current_timestamp(),
  `legacy_compat` tinyint(1) NOT NULL DEFAULT 1,
  `reports_level` enum('light','standard','extended') NOT NULL DEFAULT 'standard',
  `reports_access_rev` int(10) UNSIGNED NOT NULL DEFAULT 1,
  PRIMARY KEY (`id`),
  UNIQUE KEY `idx_subdomain` (`subdomain`)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;
```

## 4. Управление тенантами

### 4.1. Список тенантов (`tenants.php`)

Отображает все организации с колонками:

- Поддомен (ссылка на `https://{subdomain}.liftcs.ru`)
- Название
- БД
- Legacy (бейдж)
- Статус (Активен/Отключен)
- **Уровень отчётов** (select + бейдж rev)
- Действия (Изменить, Вкл/Выкл, Очистка уведомлений)

Форма добавления новой организации внизу страницы.

### 4.2. Редактирование организации (`tenant_edit.php`)

Форма редактирования полей:

- `subdomain` (с предупреждением при изменении)
- `org_name`
- `db_host`, `db_port`, `db_name`, `db_user`
- `db_password` (опционально, пустое = не менять)
- `legacy_compat` (чекбокс с предупреждением)
- **`reports_level`** (select из трёх значений)

Валидация:

- Обязательные поля
- Поддомен: `[a-z0-9-]+`, уникальность
- Порт: число

### 4.3. Сохранение (`tenants_save.php`)

Поддерживает действия:

- `action=add` — добавление новой организации
- `action=toggle` — переключение `is_active`
- `action=reports_level` — изменение уровня отчётов

## 5. Уровни доступа к отчётам

### 5.1. Назначение

Уровень доступа к отчётам — свойство организации/тенанта в центральной БД. Управление выполняется в Platform Admin.

К `company/setting.php` и админке конкретного тенанта эта функциональность не относится.

### 5.2. Допустимые значения

| Значение   | Подпись     | Константа                 |
| ---------- | ----------- | ------------------------- |
| `light`    | Лёгкий      | `ReportsAccess::LIGHT`    |
| `standard` | Стандарт    | `ReportsAccess::STANDARD` |
| `extended` | Расширенный | `ReportsAccess::EXTENDED` |

Источник истины: `App\Support\ReportsAccess::RANKS`.

### 5.3. Атомарное обновление

Единственный разрешённый запрос:

```sql
UPDATE organizations
   SET reports_level      = :level,
       reports_access_rev = reports_access_rev + 1
 WHERE id = :tenant_id
   AND reports_level <> :level;
```

Правила:

1. Только один `UPDATE`. Раздельные обновления запрещены.
2. `reports_access_rev` никогда не уменьшается.
3. `reports_access_rev` не задаётся абсолютным значением из UI.
4. Если уровень не изменился, запись не выполняется и ревизия не увеличивается.
5. Транзакция не требуется: одна строка, один атомарный `UPDATE`.

### 5.4. Валидация

Сервер проверяет значение уровня по белому списку:

```php
['light', 'standard', 'extended']
```

Если приходит недопустимое значение, сервер нормализует в `light` с записью предупреждения в лог.

### 5.5. Клиентское применение

`reports_access_rev` нужен клиентским вкладкам для перечитывания прав без перелогина. Клиент сравнивает применённую ревизию с новой по принципу «больше — перечитать».

После изменения уровня:

1. В центральной БД: `reports_level` равен новому значению, `reports_access_rev` увеличен на 1.
2. В открытой вкладке отчётов изменения подхватываются без перелогина за один цикл опроса уведомлений.
3. Ответ конфига отчётов содержит новые значения `reports_level`, `reports_features`, `reports_limits`.

### 5.6. Подсказка в UI

Текст под селектом уровня:

> Уровень применяется ко всем пользователям организации и не зависит от их ролей. Изменение вступает в силу в открытых вкладках автоматически в течение одного цикла опроса уведомлений; перелогин не требуется. Понижение уровня скрывает часть отчётов и выгрузок — данные не удаляются.

## 6. Безопасность

### 6.1. Сессия

Авторизация через `$_SESSION['admin_logged_in']`.

### 6.2. CSRF

Не реализован. Все формы отправляются без токенов (наследие текущей реализации).

### 6.3. Пароли БД

Пароли БД тенантов хранятся шифрованными через `App\Support\Crypto::encrypt()`. При редактировании:

- Пустое поле = не менять пароль (расшифровывается старый и передаётся в `save()`)
- Заполненное поле = новый пароль

### 6.4. Валидация ввода

- XSS: все выводы через `htmlspecialchars($value, ENT_QUOTES, 'UTF-8')`
- SQL: только prepared statements через `App\Registry`
- Поддомен: регулярное выражение `[a-z0-9-]+`

### 6.5. Что НЕ трогать при изменении уровня

При смене `reports_level` нельзя менять:

- `db_host`, `db_port`, `db_name`, `db_user`, `db_password`
- `is_active`
- `legacy_compat`
- `subdomain`, `org_name`

## 7. Класс `App\Registry`

Репозиторий для работы с таблицей `organizations`.

### Методы

```php
public function __construct()
public function findBySubdomain(string $subdomain): ?array
public function listAll(): array
public function save(array $data): void
public function delete(int $id): void
public function toggle(int $id, int $status): void
public function setReportsLevel(int $id, string $level): bool  // новый метод
```

### `setReportsLevel()`

```php
public function setReportsLevel(int $id, string $level): bool
{
    // Валидация
    $allowedLevels = ['light', 'standard', 'extended'];
    if (!in_array($level, $allowedLevels, true)) {
        return false;
    }

    $sql = "UPDATE organizations
               SET reports_level = :level,
                   reports_access_rev = reports_access_rev + 1
             WHERE id = :id
               AND reports_level <> :level";

    $stmt = self::$pdo->prepare($sql);
    $stmt->execute(['level' => $level, 'id' => $id]);

    return $stmt->rowCount() > 0;
}
```

Возвращает `true`, если уровень реально изменился (выполнился UPDATE), `false` — если уровень не изменился или невалиден.

## 8. Что НЕ делаем

| Что                                        | Почему                                      |
| ------------------------------------------ | ------------------------------------------- |
| JWT в Platform Admin                       | `$_SESSION` достаточно                      |
| CSRF                                       | Отдельная итерация                          |
| Аудит                                      | Отдельная итерация                          |
| Редактирование БД тенанта из UI            | Уровень — свойство тенанта, не пользователя |
| Привязка уровня к `user_role`              | Уровень применяется ко всей организации     |
| Ручное редактирование `reports_access_rev` | Только авто-инкремент                       |

## 9. Порядок выкатки

| Шаг | Действие                                                                                            |
| --- | --------------------------------------------------------------------------------------------------- |
| 1   | Применить SQL-миграцию (колонки `reports_level`, `reports_access_rev`)                              |
| 2   | Выложить обновлённый `App\Registry.php` с методом `setReportsLevel()`                               |
| 3   | Выложить обновлённые `admin/tenants.php`, `tenant_edit.php`, `tenants_save.php`                     |
| 4   | Проверить: открыть `https://<domain>/admin/tenants.php`, выбрать уровень для организации, сохранить |
| 5   | Проверить: в БД `reports_level` изменился, `reports_access_rev` увеличился на 1                     |
| 6   | Проверить: в открытой вкладке отчётов изменения применились без перелогина                          |

## 10. Приёмка

### 10.1. Список тенантов

- [ ] Открывается `admin/tenants.php`
- [ ] Отображаются все организации
- [ ] В каждой строке есть колонка «Уровень отчётов» с селектом
- [ ] Рядом с селектом отображается `reports_access_rev` как read-only бейдж

### 10.2. Редактирование организации

- [ ] Открывается `admin/tenant_edit.php?id=X`
- [ ] В форме есть селект «Уровень отчётов» с тремя значениями
- [ ] Можно выбрать уровень и сохранить
- [ ] После сохранения происходит редирект на `admin/tenants.php`

### 10.3. Изменение уровня

- [ ] Выбрать новый уровень в `tenants.php` или `tenant_edit.php`
- [ ] Нажать «Сохранить»
- [ ] В БД: `reports_level` равен новому значению
- [ ] В БД: `reports_access_rev` увеличился на 1
- [ ] В открытой вкладке отчётов изменения применились без F5

### 10.4. Холостая смена

- [ ] Выбрать тот же уровень, что уже установлен
- [ ] Сохранить
- [ ] В БД: `reports_access_rev` не изменился

### 10.5. Валидация

- [ ] Отправить `reports_level=invalid` через devtools
- [ ] Сервер вернул ошибку или нормализовал в `light`

## 11. Открытые вопросы

| №   | Вопрос                  | Решение            |
| --- | ----------------------- | ------------------ |
| 1   | CSRF для Platform Admin | Отдельная итерация |
| 2   | Аудит действий          | Отдельная итерация |
| 3   | Rate-limit логина       | Отдельная итерация |

## 12. Что осталось за рамками

| Плоскость             | Отдельный документ      |
| --------------------- | ----------------------- |
| Organization Settings | `ORGANIZATION_ADMIN.md` |
| Отчёты и экспорт      | `REPORTS.md`            |
| SPA диспетчера        | Вне текущего объёма     |

Конец PLATFORM_ADMIN.md v1.0.

````

---

Теперь код. Даю патчи для каждого файла:

---

### 1. `App/Registry.php` — добавить метод `setReportsLevel()`

```php
public function setReportsLevel(int $id, string $level): bool
{
    $allowedLevels = ['light', 'standard', 'extended'];
    if (!in_array($level, $allowedLevels, true)) {
        return false;
    }

    $sql = "UPDATE organizations
               SET reports_level = :level,
                   reports_access_rev = reports_access_rev + 1
             WHERE id = :id
               AND reports_level <> :level";

    $stmt = self::$pdo->prepare($sql);
    $stmt->execute(['level' => $level, 'id' => $id]);

    return $stmt->rowCount() > 0;
}
````

Вставить после метода `toggle()`.

---

### 2. `admin/tenants.php` — добавить колонку уровня

Найти строку с заголовками таблицы:

```php
<th>Поддомен</th>
<th>Название</th>
<th>БД</th>
<th>Legacy</th>
<th>Статус</th>
<th>Действия</th>
```

Добавить перед `<th>Действия</th>`:

```php
<th>Уровень отчётов</th>
```

Найти строку с выводом Legacy:

```php
<td>
    <?php if (!empty($t['legacy_compat'])): ?>
        <span class="legacy-badge">Legacy</span>
    <?php else: ?>
        —
    <?php endif; ?>
</td>
```

Добавить после неё новую ячейку:

```php
<td>
    <form action="/admin/tenants_save.php" method="POST" style="display:inline;">
        <input type="hidden" name="id" value="<?= $t['id'] ?>">
        <input type="hidden" name="action" value="reports_level">
        <select name="reports_level" onchange="this.form.submit()">
            <option value="light" <?= ($t['reports_level'] ?? 'standard') === 'light' ? 'selected' : '' ?>>Лёгкий</option>
            <option value="standard" <?= ($t['reports_level'] ?? 'standard') === 'standard' ? 'selected' : '' ?>>Стандарт</option>
            <option value="extended" <?= ($t['reports_level'] ?? 'standard') === 'extended' ? 'selected' : '' ?>>Расширенный</option>
        </select>
        <span class="legacy-badge">rev: <?= (int)($t['reports_access_rev'] ?? 1) ?></span>
    </form>
</td>
```

---

### 3. `admin/tenant_edit.php` — добавить селект уровня в форму

Найти блок с `legacy_compat`:

```php
<div class="form-group">
    <label>
        <input type="checkbox" name="legacy_compat" value="1" <?= $form['legacy_compat'] ? 'checked' : '' ?>>
        Legacy режим
    </label>
</div>
```

Добавить перед ним:

```php
<div class="form-group">
    <label for="reports_level">Уровень отчётов</label>
    <select id="reports_level" name="reports_level">
        <option value="light" <?= ($tenant['reports_level'] ?? 'standard') === 'light' ? 'selected' : '' ?>>Лёгкий</option>
        <option value="standard" <?= ($tenant['reports_level'] ?? 'standard') === 'standard' ? 'selected' : '' ?>>Стандарт</option>
        <option value="extended" <?= ($tenant['reports_level'] ?? 'standard') === 'extended' ? 'selected' : '' ?>>Расширенный</option>
    </select>
    <div class="hint">Уровень применяется ко всем пользователям организации. Изменение вступает в силу автоматически без перелогина.</div>
</div>
```

В блоке обработки POST добавить после валидации поддомена:

```php
// Валидация уровня отчётов
$allowedLevels = ['light', 'standard', 'extended'];
$reportsLevel = $post['reports_level'] ?? 'standard';
if (!in_array($reportsLevel, $allowedLevels, true)) {
    $reportsLevel = 'standard'; // fallback
}
```

В массиве `$data` перед вызовом `$registry->save($data)` добавить:

```php
// Сохраняем уровень отдельно, если он изменился
$currentLevel = $tenant['reports_level'] ?? 'standard';
if ($reportsLevel !== $currentLevel) {
    $registry->setReportsLevel($id, $reportsLevel);
}
```

---

### 4. `admin/tenants_save.php` — добавить action для уровня

Найти блок:

```php
} elseif ($action === 'toggle') {
    $id = (int) $_POST['id'];
    $newStatus = (int) !($_POST['current_status'] ?? 0);
    $registry->toggle($id, $newStatus);
}
```

Добавить перед `header('Location: ...')`:

```php
} elseif ($action === 'reports_level') {
    $id = (int) $_POST['id'];
    $level = $_POST['reports_level'] ?? '';

    $allowedLevels = ['light', 'standard', 'extended'];
    if (!in_array($level, $allowedLevels, true)) {
        die('Недопустимый уровень');
    }

    $registry->setReportsLevel($id, $level);
}
```

---
