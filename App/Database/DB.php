<?php
declare(strict_types=1);

namespace App\Database;

use App\Tenant;
use App\Exceptions\DbException;
use App\Support\Logger; // Подключаем наш новый логгер
use PDO;
use PDOException;
use Throwable;

final class DB
{
    private static array $instances = [];
    private PDO $pdo;

    /**
     * Приватный конструктор (паттерн Singleton).
     * Настраивает PDO подключение и отлавливает ошибки соединения.
     */
    private function __construct(Tenant $tenant)
    {
        $dsn = "mysql:host={$tenant->dbHost};port={$tenant->dbPort};dbname={$tenant->dbName};charset=utf8mb4";

        try {
            $this->pdo = new PDO($dsn, $tenant->dbUser, $tenant->dbPassword, [
                PDO::ATTR_ERRMODE => PDO::ERRMODE_EXCEPTION,
                PDO::ATTR_DEFAULT_FETCH_MODE => PDO::FETCH_ASSOC,
                PDO::ATTR_EMULATE_PREPARES => false,
                PDO::MYSQL_ATTR_FOUND_ROWS => false,
            ]);
        } catch (PDOException $e) {
            // Пишем ошибку подключения в единый лог
            Logger::error('CONNECT ERROR: ' . $e->getMessage(), ['db' => $tenant->dbName]);
            throw new DbException('Ошибка подключения к БД');
        }
    }

    /**
     * Возвращает экземпляр БД для конкретного тенанта (организации).
     */
    public static function forTenant(Tenant $tenant): self
    {
        if (!isset(self::$instances[$tenant->id])) {
            self::$instances[$tenant->id] = new self($tenant);
        }
        return self::$instances[$tenant->id];
    }

    /**
     * Выполняет SELECT запрос и возвращает массив строк.
     */
    public function fetchAll(string $sql, array $params = []): array
    {
        try {
            Logger::db($sql, $params); // Логируем запрос
            $stmt = $this->pdo->prepare($sql);
            $stmt->execute($params);
            return $stmt->fetchAll();
        } catch (PDOException $e) {
            Logger::error('SQL Error (fetchAll): ' . $e->getMessage(), ['sql' => $sql, 'params' => $params]);
            throw new DbException('Ошибка при выполнении SELECT запроса');
        }
    }

    /**
     * Выполняет SELECT запрос и возвращает одну строку (или null).
     */
    public function fetchOne(string $sql, array $params = []): ?array
    {
        try {
            Logger::db($sql, $params); // Логируем запрос
            $stmt = $this->pdo->prepare($sql);
            $stmt->execute($params);
            $res = $stmt->fetch();
            return $res === false ? null : $res;
        } catch (PDOException $e) {
            Logger::error('SQL Error (fetchOne): ' . $e->getMessage(), ['sql' => $sql, 'params' => $params]);
            throw new DbException('Ошибка при выполнении SELECT запроса');
        }
    }

    /**
     * Выполняет SELECT запрос и возвращает значение первой колонки.
     */
    public function fetchColumn(string $sql, array $params = []): mixed
    {
        try {
            Logger::db($sql, $params); // Логируем запрос
            $stmt = $this->pdo->prepare($sql);
            $stmt->execute($params);
            return $stmt->fetchColumn();
        } catch (PDOException $e) {
            Logger::error('SQL Error (fetchColumn): ' . $e->getMessage(), ['sql' => $sql, 'params' => $params]);
            throw new DbException('Ошибка при выполнении SELECT запроса');
        }
    }

    /**
     * Выполняет INSERT/UPDATE/DELETE запросы. Возвращает количество затронутых строк.
     */
    public function execute(string $sql, array $params = []): int
    {
        try {
            Logger::db($sql, $params); // Логируем запрос
            $stmt = $this->pdo->prepare($sql);
            $stmt->execute($params);
            return $stmt->rowCount();
        } catch (PDOException $e) {
            Logger::error('SQL Error (execute): ' . $e->getMessage(), ['sql' => $sql, 'params' => $params]);
            throw new DbException('Ошибка при выполнении INSERT/UPDATE/DELETE запроса');
        }
    }

    /**
     * Безопасная вставка данных в таблицу.
     */
    public function insert(string $table, array $data): int
    {
        $keys = array_keys($data);
        $sql = "INSERT INTO `$table` (`" . implode('`,`', $keys) . "`) VALUES (:" . implode(',:', $keys) . ")";
        $this->execute($sql, $data);
        return (int) $this->pdo->lastInsertId();
    }

    /**
     * Безопасное обновление данных.
     */
    public function update(string $table, array $data, array $where): int
    {
        $set = [];
        foreach ($data as $k => $v) {
            $set[] = "`$k` = :$k";
        }
        $cond = [];
        foreach ($where as $k => $v) {
            $cond[] = "`$k` = :w_$k";
        }

        $sql = "UPDATE `$table` SET " . implode(', ', $set) . " WHERE " . implode(' AND ', $cond);

        $params = [];
        foreach ($data as $k => $v) {
            $params[$k] = $v;
        }
        foreach ($where as $k => $v) {
            $params["w_$k"] = $v;
        }

        return $this->execute($sql, $params);
    }

    public function beginTransaction(): void
    {
        $this->pdo->beginTransaction();
    }

    public function commit(): void
    {
        $this->pdo->commit();
    }

    public function rollBack(): void
    {
        $this->pdo->rollBack();
    }

    public function inTransaction(): bool
    {
        return $this->pdo->inTransaction();
    }

    /**
     * Обертка для выполнения операций в транзакции с авто-откатом при ошибке.
     */
    public function transaction(callable $fn): mixed
    {
        $this->beginTransaction();
        try {
            $result = $fn($this);
            $this->commit();
            return $result;
        } catch (Throwable $e) {
            $this->rollBack();
            throw $e;
        }
    }
}