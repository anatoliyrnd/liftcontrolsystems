<?php
declare(strict_types=1);
namespace App\Http;

use App\Exceptions\ApiException;

final readonly class Request
{
    public function __construct(
        public string $action,
        public array $body,
        public ?string $bearer
    ) {
    }

    public static function fromGlobals(): self
    {
        $raw = file_get_contents('php://input') ?: '';
        $body = [];

        if ($raw !== '') {
            $body = json_decode($raw, true);
            // Если JSON пришел, но он битый — выдаем ошибку
            if (json_last_error() !== JSON_ERROR_NONE) {
                throw new ApiException(ErrorCode::InvalidInput, 'Некорректный формат JSON: ' . json_last_error_msg());
            }
            if (!is_array($body)) {
                $body = [];
            }
        }

        $action = $_GET['action'] ?? $body['action'] ?? $body['data'] ?? '';
        $authHeader = $_SERVER['HTTP_AUTHORIZATION'] ?? $_SERVER['REDIRECT_HTTP_AUTHORIZATION'] ?? '';
        $bearer = preg_match('/^Bearer\s+(.+)$/i', $authHeader, $m) ? trim($m[1]) : null;

        return new self((string) $action, $body, $bearer);
    }

    public function input(string $key, mixed $default = null): mixed
    {
        return $this->body[$key] ?? $default;
    }
}