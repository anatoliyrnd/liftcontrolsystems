<?php
declare(strict_types=1);

namespace App;

use PDO;

final class Registry
{
    // Статическое свойство для Singleton-подключения
    private static ?PDO $pdo = null;

    public function __construct()
    {
        // Создаем подключение только один раз за жизнь скрипта
        if (self::$pdo === null) {
            $config = require __DIR__ . '/../config/db.php';
            $dsn = "mysql:host={$config['host']};port={$config['port']};dbname={$config['dbname']};charset=utf8mb4";
            self::$pdo = new PDO($dsn, $config['user'], $config['password'], [
                PDO::ATTR_ERRMODE            => PDO::ERRMODE_EXCEPTION,
                PDO::ATTR_DEFAULT_FETCH_MODE => PDO::FETCH_ASSOC,
                PDO::ATTR_EMULATE_PREPARES   => false,
            ]);
        }
    }

    /**
     * Инвариант колонки organizations.subdomain: varchar(63), UNIQUE,
     * значение уходит в Host-резолв Tenant::fromRequest().
     * Правило одно на всех: и tenant_edit.php, и add в tenants_save.php
     * (туда $_POST уходит без валидации) опираются на него,
     * а не заводят свои копии regex.
     */
    public static function isValidSubdomain(string $subdomain): bool
    {
        return preg_match('/^[a-z0-9-]+$/', $subdomain) === 1
            && strlen($subdomain) <= 63;
    }

    public function findBySubdomain(string $subdomain): ?array
    {
        $stmt = self::$pdo->prepare("SELECT * FROM organizations WHERE subdomain = :sub AND is_active = 1");
        $stmt->execute(['sub' => $subdomain]);

        return $stmt->fetch() ?: null;
    }

    public function listAll(): array
    {
        return self::$pdo->query("SELECT * FROM organizations ORDER BY id DESC")->fetchAll();
    }

    public function save(array $data): void
    {
        $isUpdate     = isset($data['id']) && $data['id'];
        $hasSubdomain = array_key_exists('subdomain', $data);

        if (!$isUpdate && !$hasSubdomain) {
            throw new \InvalidArgumentException('subdomain обязателен при создании организации');
        }

        $subdomain = null;
        if ($hasSubdomain) {
            $subdomain = trim((string) $data['subdomain']);
            if (!self::isValidSubdomain($subdomain)) {
                throw new \InvalidArgumentException('Некорректный поддомен: «' . $subdomain . '»');
            }
        }

        if ($isUpdate) {
            // subdomain пишем ТОЛЬКО если его передали. Вызовы save() без него
            // не затирают идентификацию тенанта; передан — значит меняем.
            $sql = "UPDATE organizations SET
                org_name=:org_name,
                db_host=:db_host,
                db_port=:db_port,
                db_name=:db_name,
                db_user=:db_user,
                db_password=:db_password,
                legacy_compat=:legacy_compat,
                is_active=:is_active"
                . ($hasSubdomain ? ",\n                subdomain=:subdomain" : '')
                . "\n                WHERE id=:id";
        } else {
            $sql = "INSERT INTO organizations (
                subdomain, org_name, db_host, db_port, db_name,
                db_user, db_password, legacy_compat, is_active
            ) VALUES (
                :subdomain, :org_name, :db_host, :db_port, :db_name,
                :db_user, :db_password, :legacy_compat, :is_active
            )";
        }

        $stmt = self::$pdo->prepare($sql);

        $params = [
            'org_name'      => $data['org_name'],
            'db_host'       => $data['db_host'],
            'db_port'       => (int) $data['db_port'],
            'db_name'       => $data['db_name'],
            'db_user'       => $data['db_user'],
            'db_password'   => \App\Support\Crypto::encrypt($data['db_password']),
            'legacy_compat' => (int) ($data['legacy_compat'] ?? 1),
            'is_active'     => (int) ($data['is_active'] ?? 1),
        ];

        if ($isUpdate) {
            $params['id'] = $data['id'];
            if ($hasSubdomain) {
                $params['subdomain'] = $subdomain;
            }
        } else {
            $params['subdomain'] = $subdomain;
        }

        $stmt->execute($params);
    }

    /**
     * REPORTS §17: смена уровня доступа к отчётам.
     *
     * Один атомарный statement: уровень без бампа ревизии оставил бы
     * открытые вкладки со старыми замками до F5. Ревизия только +1,
     * абсолютное значение извне не принимается. Условие <> гасит
     * холостую смену, чтобы не будить все вкладки почём зря.
     *
     * Два РАЗНЫХ имени плейсхолдера намеренно: ATTR_EMULATE_PREPARES=false,
     * а без эмуляции PDO не даёт использовать один именованный маркер
     * дважды (HY093).
     *
     * @return bool true — уровень реально изменён, false — холостая смена
     */
    public function setReportsLevel(int $id, string $level): bool
    {
        if (!\App\Support\ReportsAccess::isLevel($level)) {
            throw new \InvalidArgumentException('unknown reports level: ' . $level);
        }

        $sql = "UPDATE organizations
                   SET reports_level      = :level_set,
                       reports_access_rev = reports_access_rev + 1
                 WHERE id = :id
                   AND reports_level <> :level_cmp";

        $stmt = self::$pdo->prepare($sql);
        $stmt->execute([
            'level_set' => $level,
            'level_cmp' => $level,
            'id'        => $id,
        ]);

        return $stmt->rowCount() > 0;
    }

    public function delete(int $id): void
    {
        $stmt = self::$pdo->prepare("DELETE FROM organizations WHERE id = :id");
        $stmt->execute(['id' => $id]);
    }

    public function toggle(int $id, int $status): void
    {
        $stmt = self::$pdo->prepare("UPDATE organizations SET is_active = :status WHERE id = :id");
        $stmt->execute(['status' => $status, 'id' => $id]);
    }
}