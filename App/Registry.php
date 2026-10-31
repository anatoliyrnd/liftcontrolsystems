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
                PDO::ATTR_ERRMODE => PDO::ERRMODE_EXCEPTION,
                PDO::ATTR_DEFAULT_FETCH_MODE => PDO::FETCH_ASSOC,
                PDO::ATTR_EMULATE_PREPARES => false
            ]);
        }
    }

    public function findBySubdomain(string $subdomain): ?array
    {
        // ИСПОЛЬЗУЕМ self::$pdo
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
        if (isset($data['id']) && $data['id']) {
            $sql = "UPDATE organizations SET org_name=:org_name, db_host=:db_host, db_port=:db_port, 
                    db_name=:db_name, db_user=:db_user, db_password=:db_password, is_active=:is_active WHERE id=:id";
        } else {
            $sql = "INSERT INTO organizations (subdomain, org_name, db_host, db_port, db_name, db_user, db_password, is_active) 
                    VALUES (:subdomain, :org_name, :db_host, :db_port, :db_name, :db_user, :db_password, :is_active)";
        }

        $stmt = self::$pdo->prepare($sql);
        $params = [
            'org_name' => $data['org_name'],
            'db_host' => $data['db_host'],
            'db_port' => (int) $data['db_port'],
            'db_name' => $data['db_name'],
            'db_user' => $data['db_user'],
            'db_password' => \App\Support\Crypto::encrypt($data['db_password']),
            'is_active' => (int) ($data['is_active'] ?? 1)
        ];

        if (isset($data['id']) && $data['id']) {
            $params['id'] = $data['id'];
        } else {
            $params['subdomain'] = $data['subdomain'];
        }

        $stmt->execute($params);
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