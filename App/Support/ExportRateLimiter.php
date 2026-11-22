<?php
declare(strict_types=1);

namespace App\Support;

/**
 * Первый rate-limiter проекта (§20): 1 экспорт на пользователя тенанта
 * в окно, заданное конструктором (csv/xlsx — 30 с, print — 10 с).
 * Состояние — файл вне web-root, как _alerts/_orgkey:
 * в web-root его быть не должно, иначе метку можно прочитать и согреть.
 *
 * flock обязателен: два параллельных экспорта одной учётки иначе оба
 * прошли бы проверку до записи метки.
 *
 * Деградация осознанная: каталог недоступен → лимит отключается
 * (return null), экспорт не блокируется. Отказ лимита не должен
 * обесточивать выгрузку из-за прав на папку; энтропия окна и так
 * делает злоупотребление дорогим.
 */
final class ExportRateLimiter
{
    public function __construct(private int $windowSec = 30)
    {
    }

    /** null = разрешено; int = секунд до конца окна (retry_after). */
    public function tryAcquire(string $tenantId, int $userId, string $bucket = 'csv'): ?int
    {
        // __DIR__ = …/app/Support → dirname(...,3) = …/domains (сосед web-root).
        $dir = dirname(__DIR__, 3) . '/_reports';
        if (!is_dir($dir) && !@mkdir($dir, 0750, true)) {
            $dir = sys_get_temp_dir();
        }
        // Бакет — из allowlist, не из входа: иначе имя файла стало бы
        // управляемым снаружи. Неизвестный бакет — отказ, а не подстановка.
        $allowed = ['csv', 'xlsx', 'print'];
        if (!in_array($bucket, $allowed, true)) {
            throw new \InvalidArgumentException('Неизвестный бакет экспорта: ' . $bucket);
        }

        $file = $dir . '/export_' . $bucket . '_' . md5($tenantId . ':' . $userId) . '.lock';

        $fp = @fopen($file, 'c');
        if ($fp === false) {
            return null;
        }
        try {
            if (!flock($fp, LOCK_EX)) {
                return null;
            }
            $now = time();
            $last = (int) @filemtime($file);
            $left = $last > 0 ? $last + $this->windowSec - $now : 0;
            if ($left > 0) {
                return max(1, $left);
            }
            touch($file, $now);
            return null;
        } finally {
            flock($fp, LOCK_UN);
            fclose($fp);
        }
    }
}