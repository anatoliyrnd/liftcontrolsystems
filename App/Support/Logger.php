<?php
declare(strict_types=1);
namespace App\Support;

use InvalidArgumentException;
use RuntimeException;
use Throwable;

final class Logger
{
    // PSR-3 стандарт (меньше = важнее)
    public const EMERGENCY = 0;
    public const ALERT = 1;
    public const CRITICAL = 2;
    public const ERROR = 3;
    public const WARNING = 4;
    public const NOTICE = 5;
    public const INFO = 6;
    public const DEBUG = 7;

    private const SENSITIVE_KEYS = ['password', 'passwd', 'pass', 'token', 'access_token', 'refresh_token', 'auth_token', 'secret', 'api_key', 'apikey', 'client_secret', 'authorization', 'cookie'];
    private const MAX_LOG_SIZE = 10 * 1024 * 1024; // 10 МБ

    private static ?string $logFile = null;
    private static int $minLevel = self::INFO;
    private static bool $configured = false;

    // Кэш для предотвращения лишних вызовов filesize() и mkdir()
    private static ?string $currentTargetFile = null;
    private static int $writeCount = 0;

    public static function configure(string $logFile, int $minLevel = self::INFO): void
    {
        if ($logFile === '')
            throw new InvalidArgumentException('Путь к лог-файлу не может быть пустым');
        self::$logFile = $logFile;
        self::$minLevel = $minLevel;
        self::$configured = true;
    }

    public static function log(int $level, string $type, string $message, array $context = []): void
    {
        if ($level > self::$minLevel || !self::$configured || self::$logFile === null)
            return;

        // Проверяем файл и его размер только раз в 100 записей
        if (self::$currentTargetFile === null || self::$writeCount % 100 === 0) {
            self::$currentTargetFile = self::buildFilePath($level);
            $dir = dirname(self::$currentTargetFile);
            if (!is_dir($dir) && !mkdir($dir, 0755, true) && !is_dir($dir)) {
                throw new RuntimeException("Не удалось создать директорию лога: {$dir}");
            }
        }
        self::$writeCount++;

        $date = date('c');
        $ip = PHP_SAPI === 'cli' ? 'CLI' : ($_SERVER['REMOTE_ADDR'] ?? 'unknown');
        $tenant = $_SERVER['HTTP_HOST'] ?? 'CLI';
        $safeCtx = self::sanitizeContext($context);
        $ctxString = $safeCtx !== [] ? ' | ' . json_encode($safeCtx, JSON_UNESCAPED_UNICODE | JSON_UNESCAPED_SLASHES | JSON_THROW_ON_ERROR) : '';

        $levelName = self::getLevelName($level);
        $logLine = sprintf("[%s] [%s] [IP:%s] [TENANT:%s] [%s] %s%s" . PHP_EOL, $date, $levelName, $ip, $tenant, $type, $message, $ctxString);

        if (file_put_contents(self::$currentTargetFile, $logLine, FILE_APPEND | LOCK_EX) === false) {
            throw new RuntimeException('Не удалось записать в лог-файл: ' . self::$currentTargetFile);
        }
    }

    public static function emergency(string $msg, array $ctx = []): void
    {
        self::log(self::EMERGENCY, 'EMERGENCY', $msg, $ctx);
    }
    public static function alert(string $msg, array $ctx = []): void
    {
        self::log(self::ALERT, 'ALERT', $msg, $ctx);
    }
    public static function critical(string $msg, array $ctx = []): void
    {
        self::log(self::CRITICAL, 'CRITICAL', $msg, $ctx);
    }
    public static function error(string $msg, array $ctx = []): void
    {
        self::log(self::ERROR, 'ERROR', $msg, $ctx);
    }
    public static function warning(string $msg, array $ctx = []): void
    {
        self::log(self::WARNING, 'WARNING', $msg, $ctx);
    }
    public static function notice(string $msg, array $ctx = []): void
    {
        self::log(self::NOTICE, 'NOTICE', $msg, $ctx);
    }
    public static function info(string $msg, array $ctx = []): void
    {
        self::log(self::INFO, 'INFO', $msg, $ctx);
    }
    public static function debug(string $msg, array $ctx = []): void
    {
        self::log(self::DEBUG, 'DEBUG', $msg, $ctx);
    }
    public static function db(string $sql, array $params = []): void
    {
        self::log(self::DEBUG, 'DB', $sql, ['params' => $params]);
    }

    private static function buildFilePath(int $level): string
    {
        $dir = dirname(self::$logFile);
        $baseName = pathinfo(self::$logFile, PATHINFO_FILENAME);
        $ext = pathinfo(self::$logFile, PATHINFO_EXTENSION) ?: 'log';
        $date = date('Y-m-d');
        $levelName = self::getLevelName($level);

        $baseFile = sprintf('%s/%s_%s_%s.%s', $dir, $baseName, $date, $levelName, $ext);

        if (file_exists($baseFile) && filesize($baseFile) > self::MAX_LOG_SIZE) {
            $counter = 1;
            do {
                $file = sprintf('%s/%s_%s_%s_%d.%s', $dir, $baseName, $date, $levelName, $counter, $ext);
                $counter++;
            } while (file_exists($file) && filesize($file) > self::MAX_LOG_SIZE);
            return $file;
        }
        return $baseFile;
    }

    private static function getLevelName(int $level): string
    {
        return match ($level) {
            self::EMERGENCY => 'EMERGENCY', self::ALERT => 'ALERT', self::CRITICAL => 'CRITICAL',
            self::ERROR => 'ERROR', self::WARNING => 'WARNING', self::NOTICE => 'NOTICE',
            self::INFO => 'INFO', self::DEBUG => 'DEBUG', default => 'UNKNOWN',
        };
    }

    private static function sanitizeContext(array $context): array
    {
        $result = [];
        foreach ($context as $key => $value) {
            if ($value instanceof Throwable) {
                $result[$key] = ['class' => get_class($value), 'message' => $value->getMessage(), 'code' => $value->getCode(), 'file' => $value->getFile() . ':' . $value->getLine()];
                continue;
            }
            $isSensitive = is_string($key) && in_array(strtolower($key), self::SENSITIVE_KEYS, true);
            if (is_array($value)) {
                $result[$key] = self::sanitizeContext($value);
                continue;
            }
            if (is_resource($value)) {
                $result[$key] = '[resource]';
                continue;
            }
            if ($isSensitive) {
                $result[$key] = '***';
                continue;
            }
            if (is_string($value) && mb_strlen($value) > 500) {
                $result[$key] = mb_substr($value, 0, 500) . '...';
                continue;
            }
            $result[$key] = $value;
        }
        return $result;
    }
}