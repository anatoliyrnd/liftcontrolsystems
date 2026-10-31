<?php
declare(strict_types=1);
namespace App\Repository;

use App\Database\DB;

final class UserRepository
{
    public function __construct(private readonly DB $db)
    {
    }

    public function findById(int $id): ?array
    {
        return $this->db->fetchOne("SELECT * FROM lift_users WHERE user_id = :id LIMIT 1", ['id' => $id]);
    }

    public function findByLogin(string $login): ?array
    {
        $field = str_contains($login, '@') ? 'user_email' : 'user_login';
        return $this->db->fetchOne("SELECT * FROM lift_users WHERE `$field` = :login LIMIT 1", ['login' => $login]);
    }

    /**
     * Ищет пользователя по токену. 
     * ВХОДЯЩИЙ ТОКЕН ХЭШИРУЕТСЯ, так как в БД лежит только хэш.
     */
    public function findByApiToken(string $token): ?array
    {
        $hash = hash('sha256', $token);
        return $this->db->fetchOne("SELECT * FROM lift_users WHERE api_token = :token LIMIT 1", ['token' => $hash]);
    }

    /**
     * Обновляет токен. 
     * В БД ЗАПИСЫВАЕТСЯ ХЭШ, а не сам токен.
     */
    public function updateApiToken(int $userId, string $rawToken, int $expires, string $webgl): void
    {
        $hash = hash('sha256', $rawToken);
        $sql = "UPDATE lift_users SET api_token = :token, api_token_expires = :expires, webgl_info_spa = :webgl WHERE user_id = :id";
        $this->db->execute($sql, ['token' => $hash, 'expires' => $expires, 'webgl' => $webgl, 'id' => $userId]);
    }

    public function updatePasswordHash(int $userId, string $newHash): void
    {
        $this->db->execute("UPDATE lift_users SET user_password = :hash WHERE user_id = :id", ['hash' => $newHash, 'id' => $userId]);
    }

    /**
     * Сохраняет хэш Refresh-токена в БД
     */
    public function saveRefreshToken(int $userId, string $rawToken, string $webgl): void
    {
        $hash = hash('sha256', $rawToken);
        $expires = date('Y-m-d H:i:s', time() + (30 * 86400)); // 30 дней
        $sql = "INSERT INTO lift_refresh_tokens (user_id, token_hash, device_fingerprint, expires_at, user_ip, user_agent) 
                VALUES (:uid, :hash, :webgl, :expires, :ip, :ua)";
        $this->db->execute($sql, [
            'uid' => $userId,
            'hash' => $hash,
            'webgl' => $webgl,
            'expires' => $expires,
            'ip' => $_SERVER['REMOTE_ADDR'] ?? '',
            'ua' => mb_substr($_SERVER['HTTP_USER_AGENT'] ?? '', 0, 255)
        ]);
    }

    /**
     * Ищет пользователя по Refresh-токену
     */
    public function findByRefreshToken(string $rawToken): ?array
    {
        $hash = hash('sha256', $rawToken);
        $sql = "SELECT u.* FROM lift_users u 
                JOIN lift_refresh_tokens rt ON u.user_id = rt.user_id 
                WHERE rt.token_hash = :hash AND rt.expires_at > NOW() LIMIT 1";
        return $this->db->fetchOne($sql, ['hash' => $hash]);
    }

    /**
     * Удаляет Refresh-токен при выходе (Logout)
     */
    public function deleteRefreshToken(string $rawToken): void
    {
        $hash = hash('sha256', $rawToken);
        $this->db->execute("DELETE FROM lift_refresh_tokens WHERE token_hash = :hash", ['hash' => $hash]);
    }
}