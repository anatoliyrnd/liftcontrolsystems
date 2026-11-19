<?php
declare(strict_types=1);
namespace Company\Admin\Support;

final class Csrf
{
    public static function token(): string
    {
        if (empty($_SESSION['csrf_token'])) {
            $_SESSION['csrf_token'] = bin2hex(random_bytes(32));
        }
        return $_SESSION['csrf_token'];
    }

    public static function check(): void
    {
        $given = (string) ($_POST['_csrf'] ?? '');
        $expected = (string) ($_SESSION['csrf_token'] ?? '');
        if ($expected === '' || !hash_equals($expected, $given)) {
            http_response_code(403);
            echo 'CSRF token mismatch';
            exit;
        }
    }

    public static function rotate(): void
    {
        $_SESSION['csrf_token'] = bin2hex(random_bytes(32));
    }
}