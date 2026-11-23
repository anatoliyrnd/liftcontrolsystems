<?php
declare(strict_types=1);
namespace App;

use App\Exceptions\ApiException;
use App\Http\ErrorCode;
use App\Support\Logger;
use App\Support\ReportsAccess;

final readonly class Tenant
{
    private const RESERVED = ['www', 'api', 'admin', 'mail', 'test', 'dev', 'staging', 'docs', 'cp', 'ftp', 'mysql', 'ns1', 'ns2', 'org'];

    /**
     * Базовый домен тенантов.
     *
     * Хардкод осознан: локальная разработка переводится на liftcs.ru
     * в OSPanel, отдельный конфиг не нужен. Если появится второй базовый
     * домен (white-label), оверрайд добавляется ЗДЕСЬ — константой из
     * bootstrap/config, а не правкой проверок ниже.
     */
    private const string BASE_DOMAIN = 'liftcs.ru';

    public function __construct(
        public string $id,
        public string $orgName,
        public string $dbHost,
        public int $dbPort,
        public string $dbName,
        public string $dbUser,
        public string $dbPassword,
        public bool $legacyCompat = true,
        // §16: уровень доступа к отчётам и его ревизия. Дефолты в конструкторе
        // сохраняют легаси-вызовы (тесты/CLI) на прежнем поведении standard;
        // боевой путь fromRequest() всегда передаёт нормализованные значения.
        public string $reportsLevel = ReportsAccess::STANDARD,
        public int $reportsAccessRev = 1
    ) {
    }

    public static function fromRequest(): self
    {
        $host = $_SERVER['HTTP_HOST'] ?? '';
        $host = strtolower(preg_replace('/:\d+$/', '', $host) ?? '');
        // FQDN с точкой на конце («l3.liftcs.ru.») — валидный Host, но
        // пустая последняя метка сдвинула бы разбор: базовый домен не
        // совпал бы и рабочий тенант ушёл бы в отказ.
        $host = rtrim($host, '.');
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

        // Без этой проверки любой трёхуровневый Host резолвился в тенант:
        // «l3.evil.com» отдавал данные организации l3. Поддомен берём из
        // первой метки, но принадлежность домену проверяем по двум
        // последним — именно последним, иначе «l3.liftcs.ru.evil.com»
        // прошёл бы по подстроке.
        //
        // Глубину НЕ ограничиваем (решение владельца): «l3.x.liftcs.ru»
        // остаётся валидным, поддомен по-прежнему первая метка.
        //
        // Не логируем: чужой Host — это сканеры, как и битый формат выше.
        $base = implode('.', array_slice($parts, -2));
        if ($base !== self::BASE_DOMAIN) {
            throw new ApiException(
                ErrorCode::TenantNotFound,
                'Организация не найдена',
                reason: 'foreign_domain'
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
            (bool) ($data['legacy_compat'] ?? true),
            // §16: нормализация здесь, а не в сервисах: один источник
            // истины на весь запрос. Registry отдаёт SELECT *, колонка
            // доезжает без правки SQL. NULL (код раньше миграции) →
            // fail-closed light + warning, см. ReportsAccess::normalizeLevel.
            ReportsAccess::normalizeLevel($data['reports_level'] ?? null),
            max(1, (int) ($data['reports_access_rev'] ?? 1))
        );
    }
}