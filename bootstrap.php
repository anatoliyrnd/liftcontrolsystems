<?php
declare(strict_types=1);
if (!defined('APP_ENTRY_POINT')) {
    http_response_code(404);
    exit;
}
// Единая бизнес-зона для строковых дат в lift_history и full_history.
// Unix-метки абсолютны и не зависят от этой настройки — она влияет
// только на date()/strftime при форматировании в текст.
date_default_timezone_set('Europe/Moscow');
// 1. Жесткая загрузка ключа шифрования (чтобы Crypto не падал при ленивой загрузке)
require_once __DIR__ . '/config/admin.php';

// 2. Автозагрузчик
require_once __DIR__ . '/autoload.php';

// 3. Настройка логгера (в проде поменять Logger::DEBUG на Logger::ERROR)
\App\Support\Logger::configure(
    __DIR__ . '/logs/app.log',
    \App\Support\Logger::ERROR
);

// 4. Превращаем все PHP-ошибки в исключения (чтобы они попадали в наш логгер)
set_error_handler(function ($severity, $message, $file, $line) {
    if (!(error_reporting() & $severity))
        return false;
    throw new \ErrorException($message, 0, $severity, $file, $line);
});