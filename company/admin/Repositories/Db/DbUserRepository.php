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
 */
final class DbUserRepository implements UserRepositoryInterface
{
    /**
     * Колонки, разрешённые к записи из панели. Ключи $fields в create/update
     * проверяются по этому списку; вне списка → InvalidArgumentException.
     * user_password здесь НЕТ — для него updatePasswordHash.
     */
    private const WRITABLE = [
        'user_login',
        'user_email',
        'user_name',
        'user_surname',
        'user_firstname',
        'user_patronymic',
        'user_phone',
        'user_role',
        'user_position',
        'user_block',
        'user_hiden',
        'allow_dispatcher_quick_login',
    ];

    /**
     * Легаси-колонки NOT NULL БЕЗ дефолта (SHOW COLUMNS: Null=NO, Default пуст).
     * В STRICT-режиме INSERT без них падает. Задаём явно пустыми значениями —
     * работает и в strict, и в non-strict, без опоры на sql_mode хостера.
     * user_phone здесь же: он writable, но в форме необязателен.
     */
    private const LEGACY_REQUIRED = [
        'user_address'     => '',
        'user_city'        => '',
        'user_state'       => '',
        'user_zip'         => '',
        'user_country'     => '',
        'user_phone'       => '',
        'user_email2'      => '',
        'user_company'     => '',
        'user_im_icq'      => '',
        'user_im_msn'      => '',
        'user_im_yahoo'    => '',
        'user_im_other'    => '',
        'user_msg_subject' => '',
        'last_ip'          => '',
        'user_token'       => '',
        'api_token'        => '',
        'webgl_info_spa'   => '',
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

        // Чтение обратно, а не «прочитанное + 1» в сервисе: решение
        // о блокировке принимается по состоянию БД.
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
        // Секреты (user_password, user_token, api_token) не выбираем вовсе.
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

        foreach (['user_login', 'user_email', 'user_name'] as $required) {
            if (trim((string) ($fields[$required] ?? '')) === '') {
                throw new InvalidArgumentException("Поле {$required} обязательно при создании");
            }
        }

        // Порядок слияния: легаси-заглушки → данные формы → пароль.
        // Ключи берутся только из WRITABLE и LEGACY_REQUIRED, то есть из
        // конечного литерального набора — интерполяция имён колонок безопасна.
        $data = array_merge(
            self::LEGACY_REQUIRED,
            $fields,
            ['user_password' => $passwordHash]
        );

        $columns = array_keys($data);
        $sql = 'INSERT INTO lift_users (`' . implode('`, `', $columns) . '`) VALUES ('
            . implode(', ', array_fill(0, count($columns), '?')) . ')';

        $this->db->execute($sql, array_values($data));

        // LAST_INSERT_ID(), а не метод обёртки: его наличие не подтверждено.
        // Значение привязано к соединению, а соединение одно на инстанс DB.
        $row = $this->db->fetchOne('SELECT LAST_INSERT_ID() AS id');

        return (int) ($row['id'] ?? 0);
    }

    public function update(int $userId, array $fields): void
    {
        $this->assertWritable($fields);

        if ($fields === []) {
            return;
        }

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

    public function findIdentityConflict(string $login, string $email, int $exceptId = 0): ?string
    {
        // Флаги считает MySQL, а не сравнение строк в PHP: collation
        // регистронезависимая, и 'Admin' против 'admin' в PHP не совпало бы.
        // LIMIT 1: при двух конфликтах сообщаем один, второй всплывёт
        // после исправления первого.
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
}