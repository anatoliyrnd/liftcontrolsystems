<?php
declare(strict_types=1);
namespace App\Exceptions;

use App\Http\ErrorCode;
use RuntimeException;
use Throwable;

final class ApiException extends RuntimeException
{
    public function __construct(
        public readonly ErrorCode $errorCode,
        string $message = '',
        ?Throwable $previous = null,
        public readonly ?string $reason = null,
        public readonly array $details = []
    ) {
        parent::__construct($message ?: $errorCode->value, 0, $previous);
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
}