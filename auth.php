<?php
declare(strict_types=1);

require_once __DIR__ . '/bootstrap.php';


use App\Http\{Request, Response, ErrorCode, Cors};

use App\Controller\AuthController;
use App\Exceptions\ApiException;

try {
    $request = Request::fromGlobals();
    AuthController::create()->handle($request)->send();
} catch (ApiException $e) {
    Response::error($e->errorCode, $e->getMessage())->send();
} catch (Throwable $e) {
    \App\Support\Logger::error("[FATAL AUTH] " . $e->getMessage(), ['exception' => $e]);
    Response::error(ErrorCode::InternalError, 'Внутренняя ошибка сервера')->send();
}