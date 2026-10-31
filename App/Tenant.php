<?php
declare(strict_types=1);
namespace App;

use RuntimeException;

final readonly class Tenant
{
    private const RESERVED = ['www', 'api', 'admin', 'mail', 'test', 'dev', 'staging', 'docs', 'cp', 'ftp', 'mysql', 'ns1', 'ns2', 'org'];

    public function __construct(
        public string $id,
        public string $orgName,
        public string $dbHost,
        public int $dbPort,
        public string $dbName,
        public string $dbUser,
        public string $dbPassword,
        public bool $legacyCompat = true
    ) {
    }

    public static function fromRequest(): self
    {
        $host = $_SERVER['HTTP_HOST'] ?? '';
        $host = strtolower(preg_replace('/:\d+$/', '', $host) ?? '');

        $parts = explode('.', $host);
        if (count($parts) < 3) {
            throw new RuntimeException('Неверный формат домена. Ожидается поддомен.liftcs.ru');
        }

        $subdomain = $parts[0];

        if (in_array($subdomain, self::RESERVED, true) || !preg_match('/^[a-z0-9][a-z0-9-]{0,30}$/', $subdomain)) {
            throw new RuntimeException('Недопустимый или зарезервированный поддомен');
        }

        $registry = new Registry();
        $data = $registry->findBySubdomain($subdomain);

        if (!$data) {
            throw new RuntimeException('Организация не найдена');
        }

        return new self(
            $subdomain,
            $data['org_name'],
            $data['db_host'],
            $data['db_port'],
            $data['db_name'],
            $data['db_user'],
            \App\Support\Crypto::decrypt($data['db_password']),
            (bool) ($data['legacy_compat'] ?? true)
        );
    }
}