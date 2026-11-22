<?php

declare(strict_types=1);

namespace App\Support;

/**
 * Ограничение перебора ТЕКУЩЕГО пароля при его смене (§13.2).
 *
 * ЗАЧЕМ, хотя эндпоинт под Bearer: украденный access живёт два часа,
 * и за это время старый пароль подбирается свободно. Сменив его, вор
 * запирает настоящего владельца снаружи — смена пароля из защиты
 * превращается в инструмент захвата учётки.
 *
 * ПОЧЕМУ НЕ login_attempts / locked_until: те колонки про ВХОД.
 * Пять опечаток в профиле заблокировали бы авторизацию, то есть
 * пользователь, неверно введший старый пароль, не смог бы даже
 * перелогиниться. Разные действия — разные счётчики.
 *
 * ПОЧЕМУ НЕ ExportRateLimiter: его ключ md5(tenant:user) без признака
 * действия, файл export_<hash>.lock. Переиспользование связало бы
 * два независимых лимита: попытка пароля съела бы кулдаун экспорта,
 * и наоборот. Здесь свой каталог и свой префикс — два уровня разделения.
 *
 * Состояние файловое, не в БД: лимит обязан работать и когда БД
 * недоступна, и не требует миграции. Тот же приём, что OrgKeyGuard,
 * AdminAlert и ExportRateLimiter.
 *
 * Экземплярный, а не статический: внедряется в ProfileService через
 * конструктор, что позволяет подменить его в разборе. OrgKeyGuard
 * статический потому, что OrgLoginService зовёт его напрямую.
 */
final class PasswordChangeLimiter
{
    /**
     * Неудачных проверок старого пароля до блокировки.
     *
     * Порог низкий осознанно: легитимный пользователь опечатывается
     * один-два раза, а не пять. Подбор же упирается в 5 попыток за
     * окно — 600 в час против словаря популярных паролей.
     */
    private const MAX_FAILS = 5;

    /**
     * Окно накопления неудач и длительность блокировки, секунды.
     *
     * Одно число на оба смысла, как в OrgKeyGuard: окно от ПЕРВОЙ
     * неудачи и штраф той же длины. Разные значения дали бы ситуацию
     * «счётчик копится час, штраф минута» — подбор просто ждёт.
     */
    private const WINDOW_SEC = 30;

    /**
     * Каталог состояния, найденный один раз на процесс.
     *
     * retryAfter и recordFailure зовутся в одном запросе — без кэша
     * недоступная папка давала бы два stat, два mkdir и две строки
     * CRITICAL в логе на одну попытку.
     *
     * '' кэшируется тоже: права посреди процесса не поменяются.
     */
    private static ?string $stateDir = null;

    /**
     * Сколько секунд ждать до следующей попытки.
     *
     * null = разрешено. int = остаток блокировки, минимум 1: ноль
     * клиент прочитал бы как «можно сразу» и повторил бы в тот же тик.
     *
     * Замок разделяемый и БЛОКИРУЮЩИЙ, в отличие от OrgKeyGuard.
     * Там эндпоинт публичный и горячий, ожидание чужой записи
     * задерживало бы вход всем. Здесь действие редкое и под Bearer,
     * писатель держит лок микросекунды — точность счётчика важнее
     * экономии на ожидании.
     */
    public function retryAfter(string $tenantId, int $userId): ?int
    {
        $dir = $this->dir();
        if ($dir === '') {
            return null;
        }

        $state = $this->read($this->stateFile($dir, $tenantId, $userId));
        $left  = (int) ($state['blocked_until'] ?? 0) - time();

        return $left > 0 ? $left : null;
    }

    /**
     * Зафиксировать неверный текущий пароль.
     *
     * Окно считается от ПЕРВОЙ неудачи, не скользящее: иначе
     * атакующий, растянувший попытки, никогда не наберёт порог.
     * По истечении окна счётчик обнуляется — опечатка вчерашнего
     * дня не блокирует сегодняшнюю смену пароля.
     */
    public function recordFailure(string $tenantId, int $userId): void
    {
        $dir = $this->dir();
        if ($dir === '') {
            return;
        }

        $this->mutate($this->stateFile($dir, $tenantId, $userId), static function (array $s): array {
            $now = time();

            // Уже заблокирован — состояние не меняем. Иначе каждая
            // новая попытка сдвигала бы blocked_until ещё на окно, и
            // учётка оставалась бы закрытой бессрочно, пока идёт
            // перебор. Штраф фиксирован от момента достижения порога.
            //
            // ProfileService проверяет retryAfter ДО верификации, так
            // что сюда заблокированный запрос не доходит. Guard нужен
            // для параллельных запросов: два可同时 прошли проверку.
            if ((int) ($s['blocked_until'] ?? 0) > $now) {
                return $s;
            }

            $first = (int) ($s['first_at'] ?? 0);
            if ($first === 0 || ($now - $first) > self::WINDOW_SEC) {
                $s = ['fails' => 0, 'first_at' => $now, 'blocked_until' => 0];
            }

            $s['fails'] = (int) ($s['fails'] ?? 0) + 1;

            if ($s['fails'] >= self::MAX_FAILS) {
                $s['blocked_until'] = $now + self::WINDOW_SEC;
            }

            return $s;
        });
    }

    /**
     * Успешная проверка сбрасывает счётчик.
     *
     * Без сброса серия опечаток копились бы через дни: пользователь,
     * ошибившийся четыре раза в понедельник, сменил бы пароль во
     * вторник с первой попытки — и получил блокировку.
     *
     * Удаление файла, а не запись нулей: меньше записи и не оставляет
     * мусорную строку на каждую когда-либо ошибшуюся учётку.
     */
    public function reset(string $tenantId, int $userId): void
    {
        $dir = $this->dir();
        if ($dir === '') {
            return;
        }

        @unlink($this->stateFile($dir, $tenantId, $userId));
    }

    // -----------------------------------------------------------------------
    // Состояние
    // -----------------------------------------------------------------------

    /**
     * Каталог вне web-root, рядом с _alerts, _orgkey, _reports, _spult.
     *
     * __DIR__ = …/domains/<webroot>/App/Support → dirname 3 = …/domains.
     * Проверено по фактическому пути: webroot лежит прямо под domains,
     * поэтому арифметика совпадает с ExportRateLimiter и OrgKeyGuard.
     *
     * Фолбэк — именованный подкаталог во временной папке, не сам /tmp:
     * общий каталог замусоривается, а 0750 на нём не выставить.
     *
     * ДЕГРАДАЦИЯ ОСОЗНАННАЯ: каталог недоступен → лимит отключается,
     * смена пароля не блокируется. В отличие от OrgKeyGuard здесь
     * нельзя опереться на энтропию секрета — пароль бывает слабым.
     * Основной барьер другой: действие требует валидного Bearer, а
     * украденный access живёт два часа. Лимит — тормоз, а не стена.
     * Fail-closed забрал бы смену пароля из-за прав на папку, и
     * заметили бы это по жалобе пользователя, а не по логу.
     */
    private function dir(): string
    {
        if (self::$stateDir !== null) {
            return self::$stateDir;
        }

        $root = dirname(__DIR__, 3) . '/_profile';
        if (!is_dir($root)) {
            @mkdir($root, 0750, true);
        }
        if (is_dir($root) && is_writable($root)) {
            return self::$stateDir = $root;
        }

        $fallback = sys_get_temp_dir() . '/liftcs_profile';
        if (!is_dir($fallback)) {
            @mkdir($fallback, 0750, true);
        }
        if (is_dir($fallback) && is_writable($fallback)) {
            error_log('PasswordChangeLimiter WARNING: _profile unavailable, temp fallback in use');
            return self::$stateDir = $fallback;
        }

        error_log('PasswordChangeLimiter CRITICAL: no writable state dir, password attempt limit disabled');

        return self::$stateDir = '';
    }

    /**
     * Файл на пару тенант+пользователь.
     *
     * Префикс pwd_ — второй уровень разделения после каталога: при
     * фолбэке в /tmp имена не должны пересекаться с export_<hash>.lock.
     *
     * md5, а не сырые id: имя файла не должно раскрывать состав
     * учётных записей тому, кто получил листинг каталога.
     */
    private function stateFile(string $dir, string $tenantId, int $userId): string
    {
        return $dir . '/pwd_' . md5($tenantId . ':' . $userId) . '.json';
    }

    /** @return array<string,mixed> */
    private function read(string $file): array
    {
        $fp = @fopen($file, 'r');
        if ($fp === false) {
            return [];
        }

        if (!@flock($fp, LOCK_SH)) {
            fclose($fp);
            return [];
        }

        $raw = (string) stream_get_contents($fp);
        @flock($fp, LOCK_UN);
        fclose($fp);

        $decoded = json_decode($raw, true);

        return is_array($decoded) ? $decoded : [];
    }

    /**
     * Чтение-изменение-запись под одним exclusive-локом.
     *
     * Без лока два параллельных запроса прочитали бы fails=4, каждый
     * записал 5 — и порог сработал бы на попытку позже реальной.
     *
     * Порядок ftruncate → rewind → fwrite обязателен: запись поверх
     * без усечения оставила бы хвост прежнего JSON, и json_decode
     * вернул бы null — счётчик обнулился бы молча.
     */
    private function mutate(string $file, callable $fn): void
    {
        $fp = @fopen($file, 'c+');
        if ($fp === false) {
            return;
        }

        if (!@flock($fp, LOCK_EX)) {
            fclose($fp);
            return;
        }

        $raw     = (string) stream_get_contents($fp);
        $decoded = json_decode($raw, true);
        $state   = $fn(is_array($decoded) ? $decoded : []);

        $json = (string) json_encode($state);

        ftruncate($fp, 0);
        rewind($fp);

        // Короткая запись (кончилась квота) оставляет файл обрезанным:
        // счётчик обнулится, и перебор пойдёт с чистого листа. Молчать
        // об этом нельзя — лимит выглядит работающим, но не работает.
        $written = fwrite($fp, $json);
        if ($written === false || $written < strlen($json)) {
            error_log('PasswordChangeLimiter CRITICAL: state write truncated, limit unreliable — ' . $file);
        }

        fflush($fp);
        @flock($fp, LOCK_UN);
        fclose($fp);
    }
}