<?php
declare(strict_types=1);
namespace App;

use App\Exceptions\ApiException;
use App\Http\ErrorCode;
use App\Support\Logger;

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
        // Битый Host — это сканеры, а не пользователи: SPA отдаётся с
        // поддомена тенанта и на apex не загружается вовсе. Прежний
        // RuntimeException ловился вторым catch как Throwable и писал
        // [FATAL API] на каждый такой запрос, забивая app.log. Штатный
        // ApiException перехватывается первым catch в api.php/auth.php
        // → обычный 4xx без записи в лог.
        if (count($parts) < 3) {
            throw new ApiException(
                ErrorCode::TenantNotFound,
                'Организация не найдена',
                reason: 'invalid_host_format'
            );
        }

        $subdomain = $parts[0];

        // Служебные имена (www, api, admin…) тенантами не являются.
        // Текст клиенту одинаковый во всех трёх отказах, конкретика —
        // в reason: она нужна поддержке, а не пользователю.
        if (in_array($subdomain, self::RESERVED, true) || !preg_match('/^[a-z0-9][a-z0-9-]{0,30}$/', $subdomain)) {
            throw new ApiException(
                ErrorCode::TenantNotFound,
                'Организация не найдена',
                reason: 'reserved_subdomain'
            );
        }

        $registry = new Registry();
        $data = $registry->findBySubdomain($subdomain);
        if (!$data) {
            // Единственный случай, который логируем: имя синтаксически
            // валидно и не зарезервировано, значит на него кто-то реально
            // пришёл. Отсутствие в реестре — ошибка конфигурации тенанта,
            // её нужно видеть. Битые Host выше не логируются сознательно.
            Logger::warning('Тенант не найден в реестре', [
                'subdomain' => $subdomain,
                'ip' => $_SERVER['REMOTE_ADDR'] ?? '',
            ]);
            throw new ApiException(
                ErrorCode::TenantNotFound,
                'Организация не найдена',
                reason: 'tenant_not_found'
            );
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