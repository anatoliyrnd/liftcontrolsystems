<?php
declare(strict_types=1);
namespace App\Service;

use App\Repository\UserRepository;
use App\Exceptions\ApiException;
use App\Http\ErrorCode;
use App\Support\Password;
use App\Support\Logger;

final class AuthService
{
    private const ACCESS_TTL = 7200; // 2 часа

    public function __construct(private readonly UserRepository $userRepo)
    {
    }

    public function login(?int $userId, string $login, string $password, string $webgl): array
    {
        $user = $userId !== null ? $this->userRepo->findById($userId) : $this->userRepo->findByLogin($login);

        if (!$user) {
            throw new ApiException(ErrorCode::InvalidCredentials, 'Пользователь не найден');
        }
        if ((int) $user['user_block'] === 1) {
            throw new ApiException(ErrorCode::UserBlocked, 'Учётная запись заблокирована');
        }

        if (!Password::verify($password, $user['user_password'])) {
            Logger::warning("Неудачная попытка входа: {$login}", ['ip' => $_SERVER['REMOTE_ADDR'] ?? '']);
            throw new ApiException(ErrorCode::InvalidCredentials, 'Неверный пароль');
        }

        // Автомиграция MD5 -> Bcrypt
        $passwordNeedsUpgrade = false;
        if (Password::needsRehash($user['user_password'])) {
            $newHash = Password::hash($password);
            $this->userRepo->updatePasswordHash((int) $user['user_id'], $newHash);
            $passwordNeedsUpgrade = true;
            Logger::info("Пароль ID:{$user['user_id']} обновлен на Bcrypt.", ['ip' => $_SERVER['REMOTE_ADDR'] ?? '']);
        }

        // Генерируем токен
        $token = bin2hex(random_bytes(32));
        $expires = time() + self::ACCESS_TTL;

        // Передаем сырой токен. UserRepository сам его захэширует перед записью в БД.
        $this->userRepo->updateApiToken((int) $user['user_id'], $token, $expires, $webgl);

        return [
            'access_token' => $token, // Отдаем клиенту сырой токен
            'expires_at' => $expires,
            'user' => $this->formatUser($user),
            'password_needs_upgrade' => $passwordNeedsUpgrade
        ];
    }

    public function validate(string $token): array
    {
        // UserRepository сам захэширует токен и найдет пользователя
        $user = $this->userRepo->findByApiToken($token);

        if (!$user) {
            throw new ApiException(ErrorCode::TokenInvalid, 'Токен недействителен');
        }
        if ((int) $user['user_block'] === 1) {
            throw new ApiException(ErrorCode::UserBlocked, 'Аккаунт заблокирован');
        }
        if ($user['api_token_expires'] < time()) {
            throw new ApiException(ErrorCode::TokenExpired, 'Токен истёк');
        }
        return $this->formatUser($user);
    }

    private function formatUser(array $u): array
    {
        $role = $u['user_role'] ?? 'guest';
        if (empty($role) || $role === 'guest') {
            if (!empty($u['user_localadmin']) || (int) $u['user_level'] === 0) {
                $role = 'administrator';
            } elseif (!empty($u['user_disppermission']) || (int) $u['user_level'] === 3) {
                $role = 'dispatcher';
            } elseif ((int) $u['user_level'] === 2) {
                $role = 'engineer';
            }
        }
        return ['id' => (int) $u['user_id'], 'name' => (string) $u['user_name'], 'surname' => null, 'patronymic' => null, 'role' => $role];
    }
}