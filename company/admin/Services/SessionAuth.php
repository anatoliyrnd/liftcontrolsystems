<?php

declare(strict_types=1);

namespace Company\Admin\Services;

use App\Support\Password;
use Company\Admin\Repositories\Contracts\UserRepositoryInterface;
use Company\Admin\Support\Csrf;

/**
 * Сессия панели компании. Порог 10 неверных паролей → блокировка 20 минут.
 *
 * Роль сравнивается СЫРАЯ ('administrator'): нормализация Трека А
 * (mechanic → engineer, foreman → dispatcher) и fallback по user_localadmin
 * к панели не применяются — иначе легаси-флаг открыл бы настройки организации.
 */
final class SessionAuth
{
    private const MAX_ATTEMPTS = 10;
    private const LOCK_SECONDS = 1200;

    public function __construct(private readonly UserRepositoryInterface $repo)
    {
    }

    public function attempt(string $login, string $password): bool
    {
        $user = $this->repo->findByLogin($login);

        if ($user === null) {
            // Dummy-работа вместо проверки: одна KDF-операция ≈ одна verify.
            // Без неё неизвестный логин отвечал бы быстрее, и существование
            // учётки читалось бы по таймингу. Алгоритм и стоимость берутся
            // из Password, свой хэш не хардкодим.
            Password::hash($password);
            return false;
        }

        $userId = (int) $user['user_id'];

        // Блокировка — ДО пароля и БЕЗ инкремента: иначе каждый запрос
        // продлевал бы срок, и логин запирался навсегда без единой
        // верной попытки.
        if ($user['locked_until'] !== null) {
            if ($this->repo->isLocked($userId)) {
                return false;
            }
            // Срок вышел — чистый лист. Без сброса десять опечаток
            // за месяц накопились бы до порога.
            $this->repo->resetLoginState($userId);
            $user['login_attempts'] = 0;
        }

        if (!Password::verify($password, (string) $user['user_password'])) {
            if ($this->repo->registerFailedLogin($userId) >= self::MAX_ATTEMPTS) {
                $this->repo->lockUntil($userId, time() + self::LOCK_SECONDS);
            }
            return false;
        }

        // Пароль верный — счётчик снимаем ДО проверки роли.
        if ((int) $user['login_attempts'] > 0) {
            $this->repo->resetLoginState($userId);
        }

        if ((int) $user['user_block'] === 1 || ($user['user_role'] ?? '') !== 'administrator') {
            return false;
        }

        if (Password::needsRehash((string) $user['user_password'])) {
            $this->repo->updatePasswordHash($userId, Password::hash($password));
        }

        session_regenerate_id(true);
        $_SESSION['user_id'] = $userId;

        return true;
    }

    public function check(): bool
    {
        return $this->user() !== null;
    }

    /**
     * Пользователь читается из БД на каждом вызове: разжалование и
     * user_block действуют со следующего запроса, без ожидания cookie.
     *
     * locked_until здесь НЕ проверяется осознанно: иначе атакующий,
     * набив порог неверных паролей на форме входа, выбивал бы живую
     * сессию администратора. Блокировка — про вход, не про сессию.
     */
    public function user(): ?array
    {
        $id = (int) ($_SESSION['user_id'] ?? 0);
        if ($id === 0) {
            return null;
        }

        $user = $this->repo->findById($id);
        if (
            $user === null
            || (int) $user['user_block'] === 1
            || ($user['user_role'] ?? '') !== 'administrator'
        ) {
            $this->logout();
            return null;
        }

        return $user;
    }

    public function logout(): void
    {
        unset($_SESSION['user_id']);
        Csrf::rotate();
        session_regenerate_id(true);
    }
}