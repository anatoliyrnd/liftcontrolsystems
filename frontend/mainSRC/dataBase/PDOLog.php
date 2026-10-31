<?php
namespace mainSRC\dataBase;

use DateTime;

class PDOLog
{
    private string $path;

    public function __construct()
    {
        // ИСПРАВЛЕНО: dirname(__DIR__, 2) позволяет найти корень проекта
        // независимо от того, запущен скрипт через браузер или через консоль (cron)
        $baseDir = dirname(__DIR__, 2);
        $this->path = $baseDir . DIRECTORY_SEPARATOR . 'logs' . DIRECTORY_SEPARATOR . 'dataBase' . DIRECTORY_SEPARATOR;

        if (!is_dir($this->path)) {
            // ИСПРАВЛЕНО: Добавлен флаг true для рекурсивного создания папок
            @mkdir($this->path, 0770, true);
        }
    }

    public function write(string $message, string $fileSalt): void
    {
        $date = new DateTime();
        $log = $this->path . $date->format('Y-m-d') . "-" . md5($date->format('Y-m-d') . $fileSalt) . ".txt";

        if (is_dir($this->path)) {
            $logcontent = "Time : " . $date->format('H:i:s') . "\r\n" . $message . "\r\n\r\n";

            // ИСПРАВЛЕНО: Убран die(), лог пишется в конец файла с блокировкой (FILE_APPEND | LOCK_EX)
            @file_put_contents($log, $logcontent, FILE_APPEND | LOCK_EX);
        }
    }
}