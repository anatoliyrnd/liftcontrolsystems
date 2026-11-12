<?php

declare(strict_types=1);
define('APP_ENTRY_POINT', true);
require_once __DIR__ . '/bootstrap.php';

use App\Http\{Request, Response, ErrorCode, Cors};
use App\Controller\ApiController;
use App\Controller\PublicController;
use App\Exceptions\ApiException;

try {
    $request = Request::fromGlobals();

    // Публичные actions — без авторизации
    if ($request->action === 'get_tenant_info') {
        PublicController::create()->handle($request)->send();
        exit;
    }

    // Все остальные actions — через ApiController (с авторизацией)
    ApiController::create()->handle($request)->send();

} catch (ApiException $e) {
    Response::error($e->errorCode, $e->getMessage(), $e->reason, $e->details)->send();

} catch (Throwable $e) {
    \App\Support\Logger::error("[FATAL API] " . $e->getMessage(), ['exception' => $e]);
    Response::error(ErrorCode::InternalError, 'Внутренняя ошибка сервера')->send();
}