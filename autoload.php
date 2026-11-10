<?php
declare(strict_types=1);
if (!defined('APP_ENTRY_POINT')) {
    http_response_code(404);
    exit;
}
spl_autoload_register(function (string $class) {
    $prefix = 'App\\';
    $baseDir = __DIR__ . '/App/';
    $len = strlen($prefix);

    if (strncmp($prefix, $class, $len) !== 0)
        return;

    $relativeClass = substr($class, $len);
    $file = $baseDir . str_replace('\\', '/', $relativeClass) . '.php';

    if (file_exists($file))
        require $file;
});