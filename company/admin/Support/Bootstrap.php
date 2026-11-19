<?php
declare(strict_types=1);
namespace Company\Admin\Support;

use App\Database\DB;
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

        self::startSession();

        try {
            $tenant = Tenant::fromRequest();
        } catch (\Throwable) {
            http_response_code(404);
            echo 'Not Found';
            return;
        }

        try {
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
            // Стек наружу не отдаём: display_errors задаёт хостер, а
            // bootstrap превращает Warning в ErrorException — без обёртки
            // сбой БД показал бы пользователю пути и конфиг.
            error_log('CompanyAdmin FAIL: ' . $e->getMessage()
                . ' at ' . $e->getFile() . ':' . $e->getLine());
            http_response_code(500);
            echo 'Сервис временно недоступен';
        }
    }

    private static function startSession(): void
    {
        $secure = ($_SERVER['HTTPS'] ?? '') !== ''
            || (($_SERVER['HTTP_X_FORWARDED_PROTO'] ?? '') === 'https');

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
        $c->bind(DbUserRepository::class,       static fn() => new DbUserRepository($db));
        $c->bind(UserRepositoryInterface::class, static fn(Container $c) => $c->get(DbUserRepository::class));
        $c->bind(AuditService::class,            static fn() => new AuditService($db));
        $c->bind(SessionAuth::class,             static fn(Container $c) =>
            new SessionAuth($c->get(UserRepositoryInterface::class)));
        $c->bind(View::class,                    static fn() => new View());
        return $c;
    }
}