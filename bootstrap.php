<?php
declare(strict_types=1);

// 1. Жесткая загрузка ключа шифрования (чтобы Crypto не падал при ленивой загрузке)
require_once __DIR__ . '/config/admin.php';

// 2. Автозагрузчик
require_once __DIR__ . '/autoload.php';

// 3. Настройка логгера (в проде поменять Logger::DEBUG на Logger::ERROR)
\App\Support\Logger::configure(
    __DIR__ . '/logs/app.log',
    \App\Support\Logger::DEBUG
);

// 4. Превращаем все PHP-ошибки в исключения (чтобы они попадали в наш логгер)
set_error_handler(function ($severity, $message, $file, $line) {
    if (!(error_reporting() & $severity))
        return false;
    throw new \ErrorException($message, 0, $severity, $file, $line);
});