<?php
declare(strict_types=1);

namespace App\Support;

final class Password
{
    /**
     * Проверяет пароль, поддерживая Bcrypt, Argon2, Phpass и MD5.
     */
    public static function verify(string $plain, string $hash): bool
    {
        if (empty($hash) || $hash === '*') {
            return false;
        }

        // 1. Bcrypt / Argon2id (современные)
        if (str_starts_with($hash, '$')) {
            if (password_verify($plain, $hash)) {
                return true;
            }
            // Фоллбек на phpass (старые хэши)
            if (str_starts_with($hash, '$P$') || str_starts_with($hash, '$H$')) {
                return (new PasswordHash(8, true))->CheckPassword($plain, $hash);
            }
            return false;
        }

        // 2. Legacy MD5 (32 символа hex)
        if (strlen($hash) === 32 && ctype_xdigit($hash)) {
            return hash_equals(strtolower($hash), md5($plain));
        }

        return false;
    }

    /**
     * Проверяет, нуждается ли хэш в обновлении до Bcrypt.
     * Возвращает true, если это старый MD5 или Phpass.
     */
    public static function needsRehash(string $hash): bool
    {
        if ((strlen($hash) === 32 && ctype_xdigit($hash)) || str_starts_with($hash, '$P$') || str_starts_with($hash, '$H$')) {
            return true;
        }
        return false;
    }

    /**
     * Создает современный безопасный хэш (Bcrypt).
     */
    public static function hash(string $plain): string
    {
        return password_hash($plain, PASSWORD_BCRYPT);
    }
}