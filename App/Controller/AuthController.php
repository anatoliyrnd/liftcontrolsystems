<?php
declare(strict_types=1);
namespace App\Controller;

use App\Database\DB;
use App\Http\{Request, Response, ErrorCode};
use App\Tenant;
use App\Exceptions\ApiException;
use App\Repository\UserRepository;
use App\Service\AuthService;
use App\Support\Logger;

final class AuthController
{
    private const int REFRESH_TTL = 30 * 86400; // 30 дней
    private AuthService $authService;
    private UserRepository $userRepo;

    private function __construct(AuthService $authService, UserRepository $userRepo)
    {
        $this->authService = $authService;
        $this->userRepo = $userRepo;
    }

    public static function create(): self
    {
        $tenant = Tenant::fromRequest();
        $db = DB::forTenant($tenant);
        $userRepo = new UserRepository($db);
        return new self(new AuthService($userRepo), $userRepo);
    }

    public function handle(Request $request): Response
    {
        return match ($request->action) {
            'login' => $this->handleLogin($request),
            'refresh' => $this->handleRefresh($request),
            'logout' => $this->handleLogout($request),
            'validate' => $this->handleValidate($request),
            default => throw new ApiException(ErrorCode::UnknownAction, 'Неизвестное действие')
        };
    }

    private function handleLogin(Request $request): Response
    {
        $login    = (string) ($request->input('name') ?? '');
        $password = (string) ($request->input('pname') ?? '');
        $webgl    = (string) ($request->input('webGL') ?? '');
        $userId   = $request->input('user_id');

        if ($password === '') {
            throw new ApiException(ErrorCode::InvalidInput, 'Пароль обязателен');
        }

        $result = $this->authService->login(
            $userId ? (int) $userId : null, $login, $password, $webgl
        );
        $uid = (int) $result['user']['id'];

        $refreshToken = bin2hex(random_bytes(32));
        $this->userRepo->saveRefreshToken($uid, $refreshToken, $webgl);
        setcookie('lift_refresh', $refreshToken, [
            'expires'  => time() + self::REFRESH_TTL,
            'path'     => '/',
            'secure'   => true,
            'httponly' => true,
            'samesite' => 'Strict',
        ]);

        // Единственная генерация access и единственная запись в БД.
        $accessToken = bin2hex(random_bytes(32));
        $expires = time() + AuthService::ACCESS_TTL;
        $this->userRepo->saveAccessToken($uid, $accessToken, $expires);

        // user уже отформатирован в login() — повторный validate() не нужен.
        return Response::ok([
            'access_token' => $accessToken,
            'expires_at'   => $expires,
            'user'         => $result['user'],
        ]);
    }

    private function handleRefresh(Request $request): Response
    {
        $refreshToken = $_COOKIE['lift_refresh'] ?? '';
        if (!$refreshToken) {
            throw new ApiException(ErrorCode::MissingToken, 'Сессия не найдена');
        }

        $user = $this->userRepo->findByRefreshToken($refreshToken);
        if (!$user) {
            throw new ApiException(ErrorCode::TokenExpired, 'Сессия истекла, войдите заново');
        }

        $accessToken = bin2hex(random_bytes(32));
        $expires = time() + AuthService::ACCESS_TTL;
        $this->userRepo->saveAccessToken((int) $user['user_id'], $accessToken, $expires);

        return Response::ok([
            'access_token' => $accessToken,
            'expires_at'   => $expires,
            'user'         => $this->authService->validate($accessToken),
        ]);
    }

    private function handleLogout(Request $request): Response
    {
        // Отзываем access текущего устройства: иначе токен живёт до 2 часов
        // после выхода. Метод deleteAccessToken уже есть в репозитории.
        if ($request->bearer) {
            $this->userRepo->deleteAccessToken($request->bearer);
        }

        $refreshToken = $_COOKIE['lift_refresh'] ?? '';
        if ($refreshToken) {
            $this->userRepo->deleteRefreshToken($refreshToken);
        }

        // Параметры удаления зеркалят установку.
        setcookie('lift_refresh', '', [
            'expires'  => time() - 3600,
            'path'     => '/',
            'secure'   => true,
            'httponly' => true,
            'samesite' => 'Strict',
        ]);

        return Response::ok(['message' => 'Вы вышли из системы']);
    }

    private function handleValidate(Request $request): Response
    {
        if (!$request->bearer)
            throw new ApiException(ErrorCode::MissingToken, 'Нет токена');
        return Response::ok(['user' => $this->authService->validate($request->bearer)]);
    }
}