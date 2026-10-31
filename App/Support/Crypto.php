<?php
declare(strict_types=1);
namespace App\Support;

use RuntimeException;

final class Crypto
{
    private const CIPHER = 'aes-256-cbc';

    private static function getKey(): string
    {
        if (!defined('\REGISTRY_KEY')) {
            $cfg = dirname(__DIR__, 2) . '/config/admin.php';
            if (file_exists($cfg))
                require_once $cfg;
            if (!defined('\REGISTRY_KEY')) {
                throw new RuntimeException('КРИТИЧЕСКАЯ ОШИБКА: Константа REGISTRY_KEY не определена.');
            }
        }
        return hash('sha256', \REGISTRY_KEY, true);
    }

    public static function encrypt(string $plaintext): string
    {
        $iv = random_bytes(openssl_cipher_iv_length(self::CIPHER));
        $cipher = openssl_encrypt($plaintext, self::CIPHER, self::getKey(), OPENSSL_RAW_DATA, $iv);
        if ($cipher === false)
            throw new RuntimeException('Ошибка шифрования');
        return base64_encode($iv . $cipher);
    }

    public static function decrypt(string $encrypted): string
    {
        $decoded = base64_decode($encrypted);
        $ivLen = openssl_cipher_iv_length(self::CIPHER);
        if (strlen($decoded) < $ivLen)
            throw new RuntimeException('Ошибка данных');
        $res = openssl_decrypt(substr($decoded, $ivLen), self::CIPHER, self::getKey(), OPENSSL_RAW_DATA, substr($decoded, 0, $ivLen));
        if ($res === false)
            throw new RuntimeException('Ошибка расшифровки');
        return $res;
    }
}