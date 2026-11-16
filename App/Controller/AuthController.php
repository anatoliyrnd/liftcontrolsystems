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
    // REFRESH_TTL переехал в AuthService: cookie и строка в БД обязаны
    // считаться от одних часов. Локальная константа давала расхождение —
    // «сессия истекла» при живой cookie либо разлогин ровно через месяц.
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

        // Семья объединяет всю цепочку преемников этого логина и уникальна
        // на логин, а не на пользователя: иначе выход одной вкладки гасил
        // бы сессию на другом устройстве.
        $familyId = bin2hex(random_bytes(16));
        $refreshToken = bin2hex(random_bytes(32));
        $this->userRepo->saveRefreshToken($uid, $refreshToken, $webgl, $familyId);
        $this->setRefreshCookie($refreshToken, time() + AuthService::REFRESH_TTL);

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

    /**
     * Обновление сессии: предъявленный refresh гасится, выпускается преемник.
     *
     * Многократное использование одного refresh закрывает ротация, а гонку
     * вкладок и потерянный ответ — grace-окно в репозитории. Здесь только
     * перевод исхода в код ошибки и установка cookie.
     */
    private function handleRefresh(Request $request): Response
    {
        $refreshToken = (string) ($_COOKIE['lift_refresh'] ?? '');
        if ($refreshToken === '') {
            throw new ApiException(ErrorCode::MissingToken, 'Сессия не найдена');
        }

        $webgl = (string) ($request->input('webGL') ?? '');
        $rotation = $this->userRepo->rotateRefreshToken($refreshToken, $webgl);

        if ($rotation['status'] !== 'ok') {
            $this->failRotation($rotation['status']);
        }

        $uid = (int) $rotation['user_id'];

        // Cookie ставим сразу после ротации: старый токен уже погашен.
        // Если отложить установку до конца метода, любая ошибка ниже
        // оставит клиент с мёртвым токеном, а преемника — сиротой на 30 дней.
        $this->setRefreshCookie($rotation['new_token'], time() + AuthService::REFRESH_TTL);

        $accessToken = bin2hex(random_bytes(32));
        $expires = time() + AuthService::ACCESS_TTL;
        $this->userRepo->saveAccessToken($uid, $accessToken, $expires);

        return Response::ok([
            'access_token' => $accessToken,
            'expires_at'   => $expires,
            // validate() проверяет user_block и форматирует пользователя —
            // единственная публичная точка, дублировать её здесь нельзя.
            // Заблокированный получит user_blocked, клиент разлогинит.
            'user'         => $this->authService->validate($accessToken),
        ]);
    }

    private function handleLogout(Request $request): Response
    {
        // Access текущего устройства отзываем сразу: иначе он живёт до
        // 2 часов после выхода. Остальные access дотекают (решение 2).
        if ($request->bearer) {
            $this->userRepo->deleteAccessToken($request->bearer);
        }

        $refreshToken = (string) ($_COOKIE['lift_refresh'] ?? '');
        if ($refreshToken !== '') {
            // Гасим ВСЮ семью, а не предъявленный токен: ротированные предки
            // иначе продолжат выпускать access после выхода пользователя.
            // findRefreshFamily без фильтра по срокам — истёкшая cookie
            // тоже должна приводить к чистке.
            $family = $this->userRepo->findRefreshFamily($refreshToken);
            if ($family) {
                $this->userRepo->revokeRefreshFamily($family['user_id'], $family['family_id']);
            }
        }

        $this->setRefreshCookie('', time() - 3600);

        return Response::ok(['message' => 'Вы вышли из системы']);
    }

    /**
     * Cookie refresh — единственная точка установки и снятия.
     *
     * Параметры при снятии обязаны совпадать с установкой: браузер
     * различает cookie по имени, домену и path, и «удаление» с другим
     * path оставит рабочую cookie рядом с пустой.
     *
     * secure=true означает, что по обычному http cookie не сохранится
     * вовсе — локальную отладку вести через localhost или https.
     */
    private function setRefreshCookie(string $token, int $expiresAt): void
    {
        setcookie('lift_refresh', $token, [
            'expires'  => $expiresAt,
            'path'     => '/',
            'secure'   => true,
            'httponly' => true,
            'samesite' => 'Strict',
        ]);
    }

    /**
     * Исход ротации → код ошибки, который клиент различает.
     *
     * reuse: семья уже отозвана репозиторием, cookie гасим — иначе клиент
     * будет предъявлять мёртвый токен на каждом запросе.
     *
     * busy: гонка не разрешилась за две попытки. Это НЕ потеря сессии,
     * поэтому rate_limited (клиент трактует как транспорт и повторит),
     * а не token_invalid — тот выбросил бы пользователя без причины.
     */
    private function failRotation(string $status): never
    {
        if ($status === 'reuse') {
            $this->setRefreshCookie('', time() - 3600);
            throw new ApiException(
                ErrorCode::TokenInvalid,
                'Сессия завершена из соображений безопасности, войдите заново',
                reason: 'refresh_reuse'
            );
        }

        if ($status === 'busy') {
            throw new ApiException(
                ErrorCode::RateLimited,
                'Сессия обновляется, повторите запрос',
                reason: 'refresh_busy',
                details: ['retry_after' => 1]
            );
        }

        $this->setRefreshCookie('', time() - 3600);
        throw new ApiException(ErrorCode::TokenExpired, 'Сессия истекла, войдите заново');
    }

    private function handleValidate(Request $request): Response
    {
        if (!$request->bearer)
            throw new ApiException(ErrorCode::MissingToken, 'Нет токена');
        return Response::ok(['user' => $this->authService->validate($request->bearer)]);
    }
}