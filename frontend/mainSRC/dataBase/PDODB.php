<?php
/*
 * PHP-PDO-MySQL-Class
 * https://github.com/lincanbin/PHP-PDO-MySQL-Class
 *
 * Copyright 2015 Canbin Lin (lincanbin@hotmail.com)
 * http://www.94cb.com/
 *
 * Licensed under the Apache License, Version 2.0:
 * http://www.apache.org/licenses/LICENSE-2.0
 *
 * changes made Zamotaev Anatoliy Nikolaevich zamotaev@list.ru @ 2023
 * adapted for PHP 8.3+ and named arguments @ 2026
 */

namespace mainSRC\dataBase;

// ИСПРАВЛЕНО: Используем __DIR__ для абсолютного пути. 
// Это спасает при запуске из cron или консоли из другой директории.
include_once __DIR__ . '/DBConfig.php';

use PDO;
use PDOException;

class PDODB
{
    private string $Host;
    private string $DBPort;
    private string $DBName;
    private string $DBUser;
    private string $DBPassword;

    private ?PDO $pdo = null;
    private ?\PDOStatement $sQuery = null;
    private bool $connectionStatus = false;
    private PDOLog $logObject;
    private array $parameters = [];

    public int $rowCount = 0;
    public int $columnCount = 0;
    public int $querycount = 0;

    private int $retryAttempt = 0;
    const AUTO_RECONNECT = true;
    const RETRY_ATTEMPTS = 3;

    private static ?PDODB $_instance = null;

    private function __construct()
    {
        $this->logObject = new PDOLog();
        $this->Host = DBHost;
        $this->DBPort = DBPort;
        $this->DBName = DBName;
        $this->DBUser = DBUser;
        $this->DBPassword = DBPassword;
        $this->Connect();
    }

    public static function getInstance(): PDODB
    {
        if (self::$_instance === null) {
            self::$_instance = new self();
        }
        return self::$_instance;
    }

    public function __clone()
    {
    }
    public function __wakeup()
    {
    }

    private function Connect(): void
    {
        try {
            $dsn = 'mysql:';
            $dsn .= 'host=' . $this->Host . ';';
            $dsn .= 'port=' . $this->DBPort . ';';
            if (!empty($this->DBName)) {
                $dsn .= 'dbname=' . $this->DBName . ';';
            }
            // ИСПРАВЛЕНО: Используем utf8mb4. MySQL сам сделает даунгрейд для старых таблиц,
            // но PHP 8.5+ не будет ругаться на устаревший utf8.
            $dsn .= 'charset=utf8mb4;';

            $this->pdo = new PDO(
                $dsn,
                $this->DBUser,
                $this->DBPassword,
                array(
                    PDO::ATTR_EMULATE_PREPARES => false,
                    PDO::ATTR_ERRMODE => PDO::ERRMODE_EXCEPTION,
                    PDO::MYSQL_ATTR_USE_BUFFERED_QUERY => true,
                    PDO::MYSQL_ATTR_FOUND_ROWS => true
                )
            );
            $this->connectionStatus = true;
        } catch (PDOException $e) {
            $this->ExceptionLog($e, '', 'Connect');
        }
    }

    private function SetFailureFlag(): void
    {
        $this->pdo = null;
        $this->connectionStatus = false;
    }

    public function closeConnection(): void
    {
        $this->pdo = null;
    }

    private function Init(string $query, ?array $parameters = null, array $driverOptions = []): void
    {
        if (!$this->connectionStatus) {
            $this->Connect();
        }
        try {
            $this->parameters = $parameters ?? [];
            $this->sQuery = $this->pdo->prepare($this->BuildParams($query, $this->parameters), $driverOptions);

            if (!empty($this->parameters)) {
                if (array_key_exists(0, $parameters)) {
                    $parametersType = true;
                    array_unshift($this->parameters, "");
                    unset($this->parameters[0]);
                } else {
                    $parametersType = false;
                }
                foreach ($this->parameters as $column => $value) {
                    $this->sQuery->bindValue($parametersType ? intval($column) : ":" . $column, $value);
                }
            }

            if (!isset($driverOptions[PDO::ATTR_CURSOR])) {
                $this->sQuery->execute();
            }
            $this->querycount++;
        } catch (PDOException $e) {
            $this->ExceptionLog($e, $this->BuildParams($query), 'Init', array('query' => $query, 'parameters' => $parameters));
        }
        $this->parameters = [];
    }

    private function BuildParams(string $query, ?array $params = null): string
    {
        if (!empty($params)) {
            $array_parameter_found = false;
            foreach ($params as $parameter_key => $parameter) {
                if (is_array($parameter)) {
                    $array_parameter_found = true;
                    $in = "";
                    foreach ($parameter as $key => $value) {
                        $name_placeholder = $parameter_key . "_" . $key;
                        $in .= ":" . $name_placeholder . ", ";
                        $params[$name_placeholder] = $value;
                    }
                    $in = rtrim($in, ", ");
                    $query = preg_replace("/:" . $parameter_key . "/", $in, $query);
                    unset($params[$parameter_key]);
                }
            }
            if ($array_parameter_found) {
                $this->parameters = $params;
            }
        }
        return $query;
    }

    public function beginTransaction(): bool
    {
        return $this->pdo->beginTransaction();
    }

    public function commit(): bool
    {
        return $this->pdo->commit();
    }

    public function rollBack(): bool
    {
        return $this->pdo->rollBack();
    }

    public function inTransaction(): bool
    {
        return $this->pdo->inTransaction();
    }

    public function query(string $query, array|string $params = "", int $fetchMode = PDO::FETCH_ASSOC): array|int|null
    {
        $query = trim($query);
        $this->Init($query, is_array($params) ? $params : null);

        if ($this->sQuery->columnCount() > 0) {
            return $this->sQuery->fetchAll($fetchMode);
        } else {
            return $this->sQuery->rowCount();
        }
    }

    public function iterator(string $query, ?array $params = null, int $fetchMode = PDO::FETCH_ASSOC): PDOIterator|int|null
    {
        $query = trim($query);
        $this->Init($query, $params, array(PDO::ATTR_CURSOR => PDO::CURSOR_SCROLL));

        if ($this->sQuery->columnCount() > 0) {
            return new PDOIterator($this->sQuery, $fetchMode);
        } else {
            return $this->sQuery->rowCount();
        }
    }

    public function insert(string $tableName, array $params = []): string|bool
    {
        $keys = array_keys($params);
        $rowCount = $this->query(
            'INSERT INTO `' . $tableName . '` (`' . implode('`,`', $keys) . '`)
             VALUES (:' . implode(',:', $keys) . ')',
            $params
        );
        if ($rowCount === 0) {
            return false;
        }
        return $this->lastInsertId();
    }

    public function insertMulti(string $tableName, array $params = []): bool
    {
        $rowCount = 0;
        if (!empty($params)) {
            $insParaStr = '';
            $insValueArray = array();

            foreach ($params as $addRow) {
                $insColStr = implode('`,`', array_keys($addRow));
                $insParaStr .= '(' . implode(",", array_fill(0, count($addRow), "?")) . '),';
                $insValueArray = array_merge($insValueArray, array_values($addRow));
            }
            $insParaStr = substr($insParaStr, 0, -1);
            $dbQuery = "INSERT INTO {$tableName} (
                            `$insColStr`
                        ) VALUES
                            $insParaStr";
            $rowCount = $this->query($dbQuery, $insValueArray);
        }
        return (bool) ($rowCount > 0);
    }

    public function update(string $tableName, array $params = [], array $where = []): int
    {
        $rowCount = 0;
        if (!empty($params)) {
            $updColStr = '';
            $whereStr = '';
            $updatePara = array();

            foreach ($params as $key => $value) {
                $updColStr .= "{$key}=?,";
            }
            $updColStr = substr($updColStr, 0, -1);
            $dbQuery = "UPDATE {$tableName} SET {$updColStr}";

            if (is_array($where)) {
                foreach ($where as $key => $value) {
                    $whereStr .= " AND {$key}=?";
                }
                $dbQuery .= " WHERE 1=1 {$whereStr}";
                $updatePara = array_merge(array_values($params), array_values($where));
            } else {
                $updatePara = array_values($params);
            }
            $rowCount = $this->query($dbQuery, $updatePara);
        }
        return $rowCount;
    }

    public function lastInsertId(): string
    {
        return $this->pdo->lastInsertId();
    }

    public function column(string $query, ?array $params = null): array
    {
        $this->Init($query, $params);
        $resultColumn = $this->sQuery->fetchAll(PDO::FETCH_COLUMN);
        $this->rowCount = $this->sQuery->rowCount();
        $this->columnCount = $this->sQuery->columnCount();
        $this->sQuery->closeCursor();
        return $resultColumn;
    }

    public function row(string $query, ?array $params = null, int $fetchmode = PDO::FETCH_ASSOC): mixed
    {
        $this->Init($query, $params);
        $resultRow = $this->sQuery->fetch($fetchmode);
        $this->rowCount = $this->sQuery->rowCount();
        $this->columnCount = $this->sQuery->columnCount();
        $this->sQuery->closeCursor();
        return $resultRow;
    }

    public function single(string $query, array|string $params = ''): mixed
    {
        $this->Init($query, is_array($params) ? $params : null);
        return $this->sQuery->fetchColumn();
    }

    private function ExceptionLog(PDOException $e, string $sql = "", string $method = '', array $parameters = []): void
    {
        $message = $e->getMessage();
        $exception = 'Unhandled Exception. <br />';
        $exception .= $message;
        $exception .= "<br /> You can find the error back in the log.";

        if (!empty($sql)) {
            $message .= "\r\nRaw SQL : " . $sql;
        }
        $this->logObject->write($message, $this->DBName . md5($this->DBPassword));

        if (
            self::AUTO_RECONNECT
            && $this->retryAttempt < self::RETRY_ATTEMPTS
            && stripos($message, 'server has gone away') !== false
            && !empty($method)
            && !$this->inTransaction()
        ) {
            $this->SetFailureFlag();
            $this->retryAttempt++;
            $this->logObject->write('Retry ' . $this->retryAttempt . ' times', $this->DBName . md5($this->DBPassword));

            // ИСПРАВЛЕНО: Добавлен array_values(), чтобы избежать Fatal error при Named Arguments в PHP 8+
            call_user_func_array(array($this, $method), array_values($parameters));
        } else {
            if (($this->pdo === null || !$this->inTransaction()) && php_sapi_name() !== "cli") {
                header("HTTP/1.1 500 Internal Server Error");
                header("Status: 500 Internal Server Error");
                echo $exception;
                exit();
            } else {
                throw $e;
            }
        }
    }
}