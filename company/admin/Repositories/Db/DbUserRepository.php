<?php

declare(strict_types=1);

namespace Company\Admin\Repositories\Db;

use App\Database\DB;
use Company\Admin\Repositories\Contracts\UserRepositoryInterface;
use InvalidArgumentException;

/**
 * Пользователи панели на MariaDB тенанта.
 *
 * findById/findByLogin возвращают сырую строку (контракт интерфейса).
 * list() возвращает урезанный набор: без user_password, user_token,
 * api_token — секреты не должны попадать в HTML таблицы.
 *
 * Роль НЕ выводится здесь: контроллер считает её через Position::role()
 * и передаёт вместе с позицией. Репозиторий только проверяет парность.
 */
final class DbUserRepository implements UserRepositoryInterface
{
    /**
     * Колонки, разрешённые к записи из панели. Ключ вне списка →
     * InvalidArgumentException. user_password здесь НЕТ — updatePasswordHash.
     * user_localadmin НЕТ намеренно: легаси-флаг не должен стать обходным
     * путём к правам.
     */
    private const WRITABLE = [
        'user_login',
        'user_email',
        'user_name',
        'user_surname',
        'user_firstname',
        'user_patronymic',
         'user_phone',
        'user_address',
        'user_telegram',
        'user_max',
        'user_vk',
        'user_role',
        'user_position',
        'user_block',
        'user_hiden',
        'allow_dispatcher_quick_login',
        'user_add_call',
        'user_read_all_calls',
        'user_disppermission',
        'user_edit_obj',
        'user_edit_user',
    ];

    /**
     * Флаги, приводимые к 0/1. PDO биндует false как '' — для tinyint
     * NOT NULL в STRICT это отказ. Чекбокс без value присылает 'on',
     * поэтому приведение через (bool), а не (int).
     */
    private const FLAGS = [
        'user_block',
        'user_hiden',
        'allow_dispatcher_quick_login',
        'user_add_call',
        'user_read_all_calls',
        'user_disppermission',
        'user_edit_obj',
        'user_edit_user',
    ];

    public function __construct(private readonly DB $db)
    {
    }

    public function findById(int $id): ?array
    {
        $row = $this->db->fetchOne(
            'SELECT * FROM lift_users WHERE user_id = ? LIMIT 1',
            [$id]
        );

        return is_array($row) ? $row : null;
    }

    public function findByLogin(string $login): ?array
    {
        // Две ветки вместо интерполяции имени поля: SQL не собирается
        // из данных даже частично.
        $row = str_contains($login, '@')
            ? $this->db->fetchOne('SELECT * FROM lift_users WHERE user_email = ? LIMIT 1', [$login])
            : $this->db->fetchOne('SELECT * FROM lift_users WHERE user_login = ? LIMIT 1', [$login]);

        return is_array($row) ? $row : null;
    }

    public function updatePasswordHash(int $userId, string $newHash): void
    {
        $this->db->execute(
            'UPDATE lift_users SET user_password = ? WHERE user_id = ?',
            [$newHash, $userId]
        );
    }

    public function registerFailedLogin(int $userId): int
    {
        $this->db->execute(
            'UPDATE lift_users SET login_attempts = login_attempts + 1 WHERE user_id = ?',
            [$userId]
        );

        $row = $this->db->fetchOne(
            'SELECT login_attempts FROM lift_users WHERE user_id = ?',
            [$userId]
        );

        return (int) ($row['login_attempts'] ?? 0);
    }

    public function lockUntil(int $userId, int $until): void
    {
        // FROM_UNIXTIME, не date(): конвертация и сравнение с NOW()
        // в одной зоне MySQL (API_PROTOCOL §1.2).
        $this->db->execute(
            'UPDATE lift_users SET locked_until = FROM_UNIXTIME(?) WHERE user_id = ?',
            [$until, $userId]
        );
    }

    public function resetLoginState(int $userId): void
    {
        $this->db->execute(
            'UPDATE lift_users SET login_attempts = 0, locked_until = NULL WHERE user_id = ?',
            [$userId]
        );
    }

    public function isLocked(int $userId): bool
    {
        $row = $this->db->fetchOne(
            'SELECT (locked_until IS NOT NULL AND locked_until > NOW()) AS is_locked
             FROM lift_users WHERE user_id = ? LIMIT 1',
            [$userId]
        );

        return (int) ($row['is_locked'] ?? 0) === 1;
    }

    public function list(): array
    {
        // is_locked считает MySQL: PHP не разбирает DATETIME (зона SYSTEM).
        // Флаги прав в список не берём — они нужны только форме.
        $rows = $this->db->fetchAll(
            'SELECT user_id, user_login, user_email, user_name,
                    user_surname, user_firstname, user_patronymic, user_phone,
                    user_role, user_position, user_block, user_hiden,
                    allow_dispatcher_quick_login, user_date, last_login,
                    login_attempts,
                    (locked_until IS NOT NULL AND locked_until > NOW()) AS is_locked
             FROM lift_users
             ORDER BY user_name'
        );

        return is_array($rows) ? $rows : [];
    }

    public function create(array $fields, string $passwordHash): int
    {
        $this->assertWritable($fields);
        $this->assertPositionRolePair($fields);

        $required = ['user_login', 'user_email', 'user_name', 'user_position', 'user_role'];
        foreach ($required as $key) {
            if (trim((string) ($fields[$key] ?? '')) === '') {
                throw new InvalidArgumentException("Поле {$key} обязательно при создании");
            }
        }

              // Только реальные поля формы + пароль + дата создания.
        // Обязательных колонок без дефолта в схеме нет (SHOW COLUMNS:
        // Null=NO AND Default IS NULL → 0 строк), sql_mode без STRICT.
        // Если на другом тенанте появится 1364 — лечится DEFAULT'ом
        // в той базе, а не усложнением этого кода.
        //
        // user_date пишем сами: DEFAULT 0 оставил бы «Создан» пустым навсегда.
        // Unix-метка абсолютна; в WRITABLE её нет — подделать из формы нельзя.
        // last_login не трогаем: 0 = ещё не входил.
        $data = array_merge(
            $this->normalizeFlags($fields),
            [
                'user_password' => $passwordHash,
                'user_date'     => time(),
            ]
        );

        // Ключи — только из WRITABLE и двух литералов выше.
        $columns = array_keys($data);
        $sql = 'INSERT INTO lift_users (`' . implode('`, `', $columns) . '`) VALUES ('
            . implode(', ', array_fill(0, count($columns), '?')) . ')';

        $this->db->execute($sql, array_values($data));

        // LAST_INSERT_ID(), а не метод обёртки: его наличие не подтверждено.
        $row = $this->db->fetchOne('SELECT LAST_INSERT_ID() AS id');

        return (int) ($row['id'] ?? 0);
    }

    public function update(int $userId, array $fields): void
    {
        $this->assertWritable($fields);
        $this->assertPositionRolePair($fields);

        if ($fields === []) {
            return;
        }

        $fields = $this->normalizeFlags($fields);

        $set = [];
        foreach (array_keys($fields) as $column) {
            $set[] = "`{$column}` = ?";
        }

        $params = array_values($fields);
        $params[] = $userId;

        $this->db->execute(
            'UPDATE lift_users SET ' . implode(', ', $set) . ' WHERE user_id = ?',
            $params
        );
    }

    public function setBlocked(int $userId, bool $blocked): void
    {
        $this->db->execute(
            'UPDATE lift_users SET user_block = ? WHERE user_id = ?',
            [$blocked ? 1 : 0, $userId]
        );
    }

    /**
     * Принудительная перезагрузка клиента: force_reload = 1.
     *
     * Флаг не входит в WRITABLE намеренно: иначе сохранение профиля
     * могло бы его выставить или снять мимо отдельного действия.
     *
     * Сброс в 0 — обязанность фронта (техдолг): SPA флаг пока не читает.
     * Сервер его не снимает, иначе команда потеряется до доставки.
     */
    public function setForceReload(int $userId): void
    {
        $this->db->execute(
            'UPDATE lift_users SET force_reload = 1 WHERE user_id = ?',
            [$userId]
        );
    }

    /**
     * То же для всех записей тенанта. Возврат — изменённые строки:
     * PDO::MYSQL_ATTR_FOUND_ROWS = false (подтверждено в docblock
     * App\Repository\UserRepository::updateProfile), поэтому у кого
     * флаг уже был 1, в число не попадёт. UI говорит «назначено N».
     */
    public function setForceReloadAll(): int
    {
        return $this->db->execute('UPDATE lift_users SET force_reload = 1');
    }

    public function findIdentityConflict(string $login, string $email, int $exceptId = 0): ?string
    {
        // Флаги считает MySQL: collation регистронезависимая, 'Admin'
        // против 'admin' в PHP не совпало бы. LIMIT 1: при двух конфликтах
        // сообщаем один, второй всплывёт после исправления первого.
        $row = $this->db->fetchOne(
            'SELECT (user_login = ?) AS login_taken, (user_email = ?) AS email_taken
             FROM lift_users
             WHERE (user_login = ? OR user_email = ?) AND user_id <> ?
             LIMIT 1',
            [$login, $email, $login, $email, $exceptId]
        );

        if (!is_array($row)) {
            return null;
        }

        if ((int) ($row['login_taken'] ?? 0) === 1) {
            return 'login';
        }

        return (int) ($row['email_taken'] ?? 0) === 1 ? 'email' : null;
    }

   
    /**
     * @param array<string, mixed> $fields
     */
    private function assertWritable(array $fields): void
    {
        foreach (array_keys($fields) as $column) {
            if (!in_array($column, self::WRITABLE, true)) {
                throw new InvalidArgumentException("Колонка {$column} не разрешена к записи");
            }
        }
    }

    /**
     * Позиция и роль идут вместе: смена должности без пересчёта роли
     * оставила бы расхождение с матрицей прав SPA.
     *
     * @param array<string, mixed> $fields
     */
    private function assertPositionRolePair(array $fields): void
    {
        $hasPosition = array_key_exists('user_position', $fields);
        $hasRole = array_key_exists('user_role', $fields);

        if ($hasPosition !== $hasRole) {
            throw new InvalidArgumentException(
                'user_position и user_role должны передаваться вместе'
            );
        }
    }

    /**
     * @param array<string, mixed> $fields
     * @return array<string, mixed>
     */
    private function normalizeFlags(array $fields): array
    {
        foreach (self::FLAGS as $flag) {
            if (array_key_exists($flag, $fields)) {
                $fields[$flag] = (int) ((bool) $fields[$flag]);
            }
        }

        return $fields;
    }
}