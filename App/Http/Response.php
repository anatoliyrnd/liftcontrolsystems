<?php
declare(strict_types=1);
namespace App\Http;

final readonly class Response
{
    public function __construct(private array $data)
    {
    }

    public static function ok(array $payload = []): self
    {
        return new self(['status' => 'ok'] + $payload);
    }

    public static function error(
        ErrorCode $code,
        string $message = '',
        ?string $reason = null,
        array $extra = []
    ): self {
        $payload = [
            'status'  => 'error',
            'code'    => $code->value,
            'message' => $message ?: $code->value,
        ];
        if ($reason !== null && $reason !== '') {
            $payload['reason'] = $reason;
        }
        // retry_after, existing_tickets — плоско на верхнем уровне.
        return new self($payload + $extra);
    }

    public function send(): never
    {
        header('Content-Type: application/json; charset=utf-8');
        http_response_code(200); // Всегда 200 OK
        echo json_encode($this->data, JSON_UNESCAPED_UNICODE | JSON_UNESCAPED_SLASHES);
        exit;
    }
}