<?php

declare(strict_types=1);

namespace Company\Admin\Support;

use App\Database\DB;
use App\Support\Logger;
use App\Tenant;
use Company\Admin\Repositories\Contracts\UserRepositoryInterface;
use Company\Admin\Repositories\Db\DbUserRepository;
use Company\Admin\Services\AuditService;
use Company\Admin\Services\SessionAuth;

final class Bootstrap
{
    public static function run(): void
    {
        // Явный charset: default_charset задаёт ini хостера, а не мы.
        header('Content-Type: text/html; charset=utf-8');

        try {
            $tenant = Tenant::fromRequest();
        } catch (\Throwable $e) {
            // Класс в логе обязателен: Tenant бросает ApiException в четырёх
            // местах, и без класса «хост не зарегистрирован» не отличить
            // от «упала БД реестра». Разделение 404/500 — после того,
            // как будет известен FQCN ApiException.
            Logger::error('CompanyAdmin: tenant resolve failed', [
                'class' => $e::class,
                'msg'   => $e->getMessage(),
                'at'    => $e->getFile() . ':' . $e->getLine(),
                'host'  => (string) ($_SERVER['HTTP_HOST'] ?? ''),
            ]);
            http_response_code(404);
            echo 'Tenant not resolved';
            return;
        }

        try {
            // Сессия внутри обёртки: session_start умеет Warn'ить
            // (активная сессия, недоступный save_path), а bootstrap
            // превращает Warning в ErrorException.
            self::startSession();

            $db = DB::forTenant($tenant);
            $container = self::buildContainer($db);

            /** @var SessionAuth $auth */
            $auth = $container->get(SessionAuth::class);

            $page   = (string) ($_GET['page']   ?? 'dashboard');
            $action = (string) ($_GET['action'] ?? 'index');

            // Маршрут login доступен без авторизации.
            $isLogin = $page === 'login';

            if (!$isLogin && !$auth->check()) {
                header('Location: ?page=login');
                exit;
            }
            if ($_SERVER['REQUEST_METHOD'] === 'POST') {
                Csrf::check();
            }

            /** @var array<string, array{0:class-string,1:string}> $routes */
            $routes = require __DIR__ . '/../Config/routes.php';
            (new Router($routes, $container))->dispatch($page, $action);
        } catch (\Throwable $e) {
            // Стек наружу не отдаём. Если вывод уже начался, код 500
            // не выставится — ограничение любой обёртки, здесь не лечится.
            Logger::error('CompanyAdmin: request failed', [
                'class' => $e::class,
                'msg'   => $e->getMessage(),
                'at'    => $e->getFile() . ':' . $e->getLine(),
                'page'  => (string) ($_GET['page'] ?? ''),
            ]);
            http_response_code(500);
            echo 'Сервис временно недоступен';
        }
    }

    private static function startSession(): void
    {
        if (session_status() === PHP_SESSION_ACTIVE) {
            // Изоляция не удалась: имя ставится только до старта.
            // Кто-то открыл сессию раньше — это дефект, он должен быть виден.
            Logger::error('CompanyAdmin: session already active', [
                'name' => session_name(),
            ]);
            return;
        }

        $secure = ($_SERVER['HTTPS'] ?? '') !== ''
            || (($_SERVER['HTTP_X_FORWARDED_PROTO'] ?? '') === 'https');

        // Отказ от неинициализированных ID: иначе сервер примет навязанный SID.
        ini_set('session.use_strict_mode', '1');
        // Cookie живёт 8 часов — данные сессии должны жить столько же,
        // иначе дефолтный gc 1440 с выкинет админа через 24 минуты.
        ini_set('session.gc_maxlifetime', '28800');

        session_name('LIFTCS_ADMIN');
        session_set_cookie_params([
            'lifetime' => 8 * 3600,
            'path'     => '/',
            'secure'   => $secure,
            'httponly' => true,
            'samesite' => 'Strict',
        ]);
        session_start();
    }

    private static function buildContainer(DB $db): Container
    {
        $c = new Container();
        $c->bind(DbUserRepository::class, static fn() => new DbUserRepository($db));
        $c->bind(
            UserRepositoryInterface::class,
            static fn(Container $c) => $c->get(DbUserRepository::class)
        );
        $c->bind(AuditService::class, static fn() => new AuditService($db));
        $c->bind(
            SessionAuth::class,
            static fn(Container $c) => new SessionAuth($c->get(UserRepositoryInterface::class))
        );
        $c->bind(View::class, static fn() => new View());

        return $c;
    }
}