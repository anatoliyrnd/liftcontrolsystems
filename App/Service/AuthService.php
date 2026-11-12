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
    public const int ACCESS_TTL = 7200; // 2 часа; используется и AuthController

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

        // Токен здесь больше не создаётся: единственный access выпускает
        // AuthController и пишет его в lift_access_tokens. Legacy-колонки
        // api_token / api_token_expires / webgl_info_spa не трогаем —
        // именно они ломали refresh через 2 часа после логина.
        return [
            'user' => $this->formatUser($user),
            'password_needs_upgrade' => $passwordNeedsUpgrade,
        ];
    }

    public function validate(string $token): array
    {
        $user = $this->userRepo->findByAccessToken($token);
        if (!$user) {
            throw new ApiException(ErrorCode::TokenInvalid, 'Токен недействителен');
        }
        if ((int) $user['user_block'] === 1) {
            throw new ApiException(ErrorCode::UserBlocked, 'Аккаунт заблокирован');
        }

        // Срок действия уже проверен в SQL: findByAccessToken фильтрует
        // a.expires_at > NOW(). Проверка lift_users.api_token_expires удалена:
        // колонка писалась только при логине и через 2 часа валила любой refresh.

        return $this->formatUser($user);
    }

    private function formatUser(array $u): array
    {
        $role = (string) ($u['user_role'] ?? '');

        // Legacy-значения приводим к словарю фронтенда:
        // неизвестная роль на клиенте нормализуется в guest.
        $role = match ($role) {
            'mechanic' => 'engineer',
            'foreman'  => 'dispatcher',
            default    => $role,
        };

        // Fallback только по явным флагам. user_level больше не используется:
        // необнулённый уровень 0 давал администратора.
        if ($role === '' || $role === 'guest') {
            if (!empty($u['user_localadmin'])) {
                $role = 'administrator';
            } elseif (!empty($u['user_disppermission'])) {
                $role = 'dispatcher';
            } else {
                $role = 'guest';
            }
        }

        $surname    = trim((string) ($u['user_surname'] ?? ''));
        $firstname  = trim((string) ($u['user_firstname'] ?? ''));
        $patronymic = trim((string) ($u['user_patronymic'] ?? ''));

        return [
            'id'           => (int) $u['user_id'],
            // Для незаполненных записей name остаётся полным ФИО —
            // шапка показывает то же, что и раньше.
            'name'         => $firstname !== '' ? $firstname : (string) $u['user_name'],
            'surname'      => $surname !== '' ? $surname : null,
            'patronymic'   => $patronymic !== '' ? $patronymic : null,
            'display_name' => (string) $u['user_name'],
            'role'         => $role,
        ];
    }
}