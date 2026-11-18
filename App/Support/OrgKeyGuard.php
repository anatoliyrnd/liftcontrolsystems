<?php
declare(strict_types=1);

namespace App\Support;

/**
 * Защита публичного входа по ключу организации (B4.3 / B4.4).
 *
 * Эндпоинты check_org_key и get_org_users работают БЕЗ bearer:
 * единственный барьер — знание ключа. Поэтому нормализация,
 * timing-safe сравнение и ограничение перебора живут здесь,
 * а не размазаны по сервису и контроллеру.
 *
 * Состояние файловое, не в БД: лимит должен работать и когда
 * БД недоступна, и не зависит от схемы тенанта. Тот же приём,
 * что в AdminAlert.
 */
final class OrgKeyGuard
{
    /** Неудачных попыток до блокировки. */
    private const MAX_FAILS = 5;

    /** Окно накопления неудач и длительность блокировки, секунды. */
    private const BLOCK_SEC = 900;

    /**
     * Алфавит ключа: 32 символа, без 0/O и 1/I.
     * Диспетчер читает ключ с бумаги и вводит руками — визуально
     * похожие пары дают обращения «ключ не подходит» на верном ключе.
     */
    private const ALPHABET = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789';

    private const KEY_CHARS = 12;

    /**
     * Кириллические двойники латинских букв из алфавита.
     *
     * Диспетчер на русской раскладке набирает «АВСК…» кириллицей,
     * и визуально ключ совпадает. Без подмены hash_equals вернёт
     * false на правильном ключе — поддержать такой случай дешевле,
     * чем разбирать его вручную.
     *
     * Буквы O и I в алфавит не входят, поэтому их двойники
     * не映射ируем: после нормализации ключ всё равно не совпадёт.
     */
    private const LOOKALIKE = [
        'А' => 'A', 'В' => 'B', 'С' => 'C', 'Е' => 'E', 'Н' => 'H',
        'К' => 'K', 'М' => 'M', 'Р' => 'P', 'Т' => 'T', 'У' => 'Y',
        'Х' => 'X',
    ];

    /**
     * Каноническая форма ключа: верхний регистр, только буквы и цифры.
     *
     * Разделители и пробелы вырезаем: админ записал ABCD-EFGH-IJKL,
     * диспетчер ввёл abcd efgh ijkl — это один и тот же ключ.
     * Нормализация обязательна с ОБЕИХ сторон сравнения.
     */
    public static function normalize(?string $raw): string
    {
        $s = mb_strtoupper(trim((string) $raw), 'UTF-8');
        $s = strtr($s, self::LOOKALIKE);

        // Без /u намеренно: неASCII байты должны исчезнуть целиком,
        // а не породить невалидную последовательность.
        return preg_replace('/[^A-Z0-9]/', '', $s) ?? '';
    }

    /**
     * Сравнение с сохранённым ключом.
     *
     * hash_equals, а не ===: обычное сравнение возвращает управление
     * на первом несовпавшем символе, и время ответа утекает длину
     * верного префикса. Для секрета это лишняя поверхность.
     *
     * Пустой сохранённый ключ → false. Признак «функция выключена»
     * сервис проверяет отдельно, здесь он не должен выглядеть
     * как «пустой ввод подошёл».
     */
    public static function matches(string $input, string $stored): bool
    {
        $a = self::normalize($input);
        $b = self::normalize($stored);

        if ($a === '' || $b === '') {
            return false;
        }

        return hash_equals($b, $a);
    }

    /**
     * Заблокирован ли адрес.
     *
     * @return array{blocked:bool,retry_after:int}
     */
    public static function isBlocked(string $tenant): array
    {
        $dir = self::dir();
        if ($dir === '') {
            return ['blocked' => false, 'retry_after' => 0];
        }

        $state = self::read(self::stateFile($dir, $tenant));
        $until = (int) ($state['blocked_until'] ?? 0);
        $now   = time();

        if ($until > $now) {
            return ['blocked' => true, 'retry_after' => $until - $now];
        }

        return ['blocked' => false, 'retry_after' => 0];
    }

    /**
     * Зафиксировать неудачную попытку.
     *
     * Окно считается от ПЕРВОЙ неудачи, а не скользящее: иначе
     * атакующий, растянувший попытки, никогда не наберёт порог.
     * По истечении окна счётчик обнуляется — легитимный пользователь,
     * ошибшийся вчера, сегодня не заблокирован.
     */
    public static function recordFailure(string $tenant): void
    {
        $dir = self::dir();
        if ($dir === '') {
            return;
        }

        self::mutate(self::stateFile($dir, $tenant), static function (array $s): array {
            $now   = time();
            $first = (int) ($s['first_at'] ?? 0);

            if ($first === 0 || ($now - $first) > self::BLOCK_SEC) {
                $s = ['fails' => 0, 'first_at' => $now, 'blocked_until' => 0];
            }

            $s['fails'] = (int) ($s['fails'] ?? 0) + 1;

            if ($s['fails'] >= self::MAX_FAILS) {
                $s['blocked_until'] = $now + self::BLOCK_SEC;
            }

            return $s;
        });
    }

    /** Успех сбрасывает счётчик: серия опечаток не копится через дни. */
    public static function recordSuccess(string $tenant): void
    {
        $dir = self::dir();
        if ($dir === '') {
            return;
        }

        @unlink(self::stateFile($dir, $tenant));
    }

    /**
     * Сгенерировать ключ формата XXXX-XXXX-XXXX.
     *
     * random_int, не rand/uniqid: ключ — секрет, предсказуемость
     * обесценивает весь барьер. 12 символов из 32 ≈ 10^18 комбинаций,
     * при лимите 5 попыток / 15 минут перебор нереален.
     */
    public static function generate(): string
    {
        $max = strlen(self::ALPHABET) - 1;
        $out = '';

        for ($i = 0; $i < self::KEY_CHARS; $i++) {
            if ($i > 0 && $i % 4 === 0) {
                $out .= '-';
            }
            $out .= self::ALPHABET[random_int(0, $max)];
        }

        return $out;
    }

    // -----------------------------------------------------------------------
    // Состояние
    // -----------------------------------------------------------------------

    /**
     * Каталог вне web-root, рядом с _alerts и _spult.
     *
     * При недоступности — фолбэк во временную папку. Если и она
     * не пишется, лимит не работает: пишем CRITICAL и уведомляем
     * админа, но запрос НЕ блокируем.
     *
     * Компромисс осознанный: энтропия ключа 10^18 делает перебор
     * непрактичным и без лимита, а fail-closed обесточил бы вход
     * всем диспетчерам из-за прав на каталог. Строгий вариант —
     * вернуть blocked: true в isBlocked при пустом dir().
     */
    private static function dir(): string
    {
        $root = dirname(__DIR__, 3) . '/_orgkey';
        if (!is_dir($root)) {
            @mkdir($root, 0750, true);
        }
        if (is_dir($root) && is_writable($root)) {
            return $root;
        }

        $fallback = sys_get_temp_dir() . '/liftcs_orgkey';
        if (!is_dir($fallback)) {
            @mkdir($fallback, 0750, true);
        }
        if (is_dir($fallback) && is_writable($fallback)) {
            error_log('OrgKeyGuard WARNING: _orgkey unavailable, temp fallback in use');
            return $fallback;
        }

        error_log('OrgKeyGuard CRITICAL: no writable state dir, rate limit disabled');
        AdminAlert::notify(
            'orgkey_ratelimit_down',
            'Каталог состояния OrgKeyGuard недоступен для записи: ограничение перебора ключа организации не работает.',
            ['reason' => 'no_state_dir']
        );

        return '';
    }

    /**
     * REMOTE_ADDR, не X-Forwarded-For: заголовок подделывается,
     * и лимит обходился бы одной строкой в запросе. Доверять
     * forwarded можно только со списком доверенных прокси.
     */
    private static function stateFile(string $dir, string $tenant): string
    {
        $ip = (string) ($_SERVER['REMOTE_ADDR'] ?? 'cli');
        return $dir . '/' . md5($tenant . '|' . $ip) . '.json';
    }

    /** @return array<string,mixed> */
    private static function read(string $file): array
    {
        $fp = @fopen($file, 'r');
        if ($fp === false) {
            return [];
        }

        @flock($fp, LOCK_SH);
        $raw = (string) stream_get_contents($fp);
        @flock($fp, LOCK_UN);
        fclose($fp);

        $decoded = json_decode($raw, true);
        return is_array($decoded) ? $decoded : [];
    }

    /**
     * Чтение-изменение-запись под одним exclusive-локом.
     *
     * Без лока два параллельных запроса прочитали бы fails=4,
     * каждый записал 5 — и порог сработал бы на попытке позже
     * реальной. Замок короткий, contention здесь нет.
     */
    private static function mutate(string $file, callable $fn): void
    {
        $fp = @fopen($file, 'c+');
        if ($fp === false) {
            return;
        }

        if (!@flock($fp, LOCK_EX)) {
            fclose($fp);
            return;
        }

        $raw = (string) stream_get_contents($fp);
        $decoded = json_decode($raw, true);
        $state = $fn(is_array($decoded) ? $decoded : []);

        ftruncate($fp, 0);
        rewind($fp);
        fwrite($fp, (string) json_encode($state, JSON_UNESCAPED_UNICODE));
        fflush($fp);

        @flock($fp, LOCK_UN);
        fclose($fp);
    }
}