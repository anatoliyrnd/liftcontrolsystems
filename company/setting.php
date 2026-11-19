<?php
declare(strict_types=1);
define('APP_ENTRY_POINT', true);

require_once __DIR__ . '/../bootstrap.php';

// Второй автозагрузчик под Company\Admin\, основной App\ не трогаем.
spl_autoload_register(static function (string $class): void {
    $prefix = 'Company\\Admin\\';
    if (!str_starts_with($class, $prefix)) {
        return;
    }
    $file = __DIR__ . '/admin/' . str_replace('\\', '/', substr($class, strlen($prefix))) . '.php';
    if (file_exists($file)) {
        require_once $file;
    }
});