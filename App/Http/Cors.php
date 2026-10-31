<?php
declare(strict_types=1);

namespace App\Http;

final class Cors
{
    /**
     * Настраивает CORS-заголовки, если запрос пришел с разрешенного Origin.
     * Если фронтенд и бэкенд на одном домене, можно передать пустой массив.
     *
     * @param array $allowedOrigins Список разрешенных доменов (например, ['https://sh.liftcs.ru'])
     */
    public static function apply(array $allowedOrigins = []): void
    {
        $origin = $_SERVER['HTTP_ORIGIN'] ?? '';

        if ($origin !== '' && in_array($origin, $allowedOrigins, true)) {
            header("Access-Control-Allow-Origin: $origin");
            header('Access-Control-Allow-Credentials: true');
            header('Access-Control-Allow-Methods: POST, GET, OPTIONS');
            header('Access-Control-Allow-Headers: Content-Type, Authorization');
            header('Vary: Origin');
        }
    }
}