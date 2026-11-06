<?php
declare(strict_types=1);
namespace App\Http;

enum ErrorCode: string
{
    case InvalidInput = 'invalid_input';
    case Forbidden = 'forbidden';
    case NotFound = 'not_found';
    case Closed = 'closed';
    case TokenExpired = 'token_expired';
    case MissingToken = 'missing_token';
    case TokenInvalid = 'token_invalid';
    case DeviceMismatch = 'device_mismatch';
    case UserBlocked = 'user_blocked';
    case InvalidCredentials = 'invalid_credentials';
    case InternalError = 'internal_error';
    case UnknownAction = 'unknown_action';
    case MethodNotAllowed = 'method_not_allowed';
    case TenantNotFound = 'tenant_not_found';
    case RateLimited = 'rate_limited';
}