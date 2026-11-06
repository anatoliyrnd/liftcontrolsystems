<?php

declare(strict_types=1);

namespace App\Controller;

use App\Http\{Request, Response, ErrorCode};
use App\Registry;
use App\Support\Logger;

final class PublicController
{
    private const RATE_LIMIT_SECONDS = 10;
    private const COOKIE_NAME = 'tenant_info_last';

    private const RESERVED_SUBDOMAINS = [
        'www', 'api', 'admin', 'mail', 'test', 'dev', 'staging',
        'docs', 'cp', 'ftp', 'mysql', 'ns1', 'ns2', 'org'
    ];

    public static function create(): self
    {
        return new self();
    }

    public function handle(Request $request): Response
    {
        return match ($request->action) {
            'get_tenant_info' => $this->getTenantInfo(),
            default => Response::error(ErrorCode::UnknownAction, 'Неизвестное действие: ' . $request->action),
        };
    }

    private function getTenantInfo(): Response
    {
        // Rate limiting через cookies
        if (!$this->checkRateLimit()) {
            return Response::error(
                ErrorCode::RateLimited,
                'Слишком частые запросы. Повторите через ' . self::RATE_LIMIT_SECONDS . ' секунд.'
            );
        }

        try {
            $subdomain = $this->extractSubdomain();

            if ($subdomain === null) {
                return Response::error(
                    ErrorCode::TenantNotFound,
                    'Неверный формат домена. Ожидается поддомен.liftcs.ru'
                );
            }

            if (!$this->isValidSubdomain($subdomain)) {
                Logger::warning('get_tenant_info: reserved or invalid subdomain', [
                    'subdomain' => $subdomain
                ]);
                return Response::error(
                    ErrorCode::TenantNotFound,
                    'Недопустимый или зарезервированный поддомен'
                );
            }

            $registry = new Registry();
            $data = $registry->findBySubdomain($subdomain);

            if (!$data) {
                Logger::warning('get_tenant_info: tenant not found', [
                    'subdomain' => $subdomain
                ]);
                return Response::error(
                    ErrorCode::TenantNotFound,
                    'Организация для этого домена не найдена'
                );
            }

            Logger::info('get_tenant_info: success', [
                'subdomain' => $subdomain,
                'org_name' => $data['org_name']
            ]);

            return Response::ok([
                'data' => [
                    'org_name' => $data['org_name'],
                ]
            ]);

        } catch (\Throwable $e) {
            Logger::error('get_tenant_info: error', ['exception' => $e]);
            return Response::error(ErrorCode::InternalError, 'Внутренняя ошибка сервера');
        }
    }

    private function checkRateLimit(): bool
    {
        $lastRequest = (int) ($_COOKIE[self::COOKIE_NAME] ?? 0);
        $now = time();

        if ($now - $lastRequest < self::RATE_LIMIT_SECONDS) {
            Logger::warning('get_tenant_info: rate limited', [
                'last_request' => $lastRequest,
                'seconds_ago' => $now - $lastRequest
            ]);
            return false;
        }

        setcookie(
            self::COOKIE_NAME,
            (string) $now,
            [
                'expires' => $now + 60,
                'path' => '/',
                'domain' => '',
                'secure' => false,
                'httponly' => true,
                'samesite' => 'Strict'
            ]
        );

        return true;
    }

    private function extractSubdomain(): ?string
    {
        $host = $_SERVER['HTTP_HOST'] ?? '';
        $host = strtolower(preg_replace('/:\d+$/', '', $host) ?? '');
        $parts = explode('.', $host);

        if (count($parts) < 3) {
            Logger::warning('get_tenant_info: invalid domain format', [
                'host' => $host,
                'parts_count' => count($parts)
            ]);
            return null;
        }

        return $parts[0];
    }

    private function isValidSubdomain(string $subdomain): bool
    {
        if (in_array($subdomain, self::RESERVED_SUBDOMAINS, true)) {
            return false;
        }

        if (!preg_match('/^[a-z0-9][a-z0-9-]{0,30}$/', $subdomain)) {
            return false;
        }

        return true;
    }
}