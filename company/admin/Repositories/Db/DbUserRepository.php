<?php

declare(strict_types=1);

namespace Company\Admin\Repositories\Db;

use App\Database\DB;
use Company\Admin\Repositories\Contracts\UserRepositoryInterface;

/**
 * Пользователи панели на MariaDB тенанта.
 *
 * SELECT * сохранён осознанно: контракт интерфейса — сырая строка
 * lift_users, включая login_attempts и locked_until. ApiUserRepository
 * Трека Б обязан вернуть те же ключи.
 */
final class DbUserRepository implements UserRepositoryInterface
{
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
        // о блокировке принимается по состоянию БД. Между UPDATE и
        // SELECT возможна гонка — параллельные запросы увидят одно
        // значение и заблокируют на попытку позже. Для порога 10
        // это несущественно.
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
        // Сравнение выполняет MySQL. PHP не разбирает DATETIME:
        // time_zone в PDO ещё SYSTEM, strtotime() дал бы скос на 3 часа.
        $row = $this->db->fetchOne(
            'SELECT (locked_until IS NOT NULL AND locked_until > NOW()) AS is_locked
             FROM lift_users WHERE user_id = ? LIMIT 1',
            [$userId]
        );

        return (int) ($row['is_locked'] ?? 0) === 1;
    }
}