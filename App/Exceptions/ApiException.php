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
        ?Throwable $previous = null
    ) {
        parent::__construct($message ?: $errorCode->value, 0, $previous);
    }
}