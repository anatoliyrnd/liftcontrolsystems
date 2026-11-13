<?php
declare(strict_types=1);

namespace App\Support;

use App\Database\DB;
use PHPMailer\PHPMailer\PHPMailer;

/**
 * Оповещение администратора о критических сбоях.
 *
 * Пять требований, определившие архитектуру:
 *
 *  1. Канал НЕ зависит от БД. Падение БД — основной повод написать письмо,
 *     поэтому адрес берётся из константы, а lift_options — лишь дополнение.
 *     Троттлинг тоже файловый, по той же причине.
 *
 *  2. Метод никогда не бросает. Оповещение не имеет права уронить запрос.
 *     В sp.php это критично: пульт обязан получить 200 при любом исходе.
 *
 *  3. Guard от рекурсии. Сбой внутри отправки не должен снова звать
 *     оповещение — иначе бесконечный цикл вместо письма.
 *
 *  4. Проверка «пора ли слать» и установка метки атомарны (flock).
 *     Иначе два параллельных процесса отправят два одинаковых письма.
 *
 *  5. Транспорт — авторизованный SMTP. Локальный sendmail в PHP-контейнере
 *     принимает письмо (mail() = true), но наружу не выпускает: ни доставки,
 *     ни bounce. SMTP идёт тем же путём, что вебмейл: AUTH → почтовый релей
 *     → DKIM-подпись → доставка. Отказ виден сразу как исключение.
 */
final class AdminAlert
{
    /** Guard рекурсии: ошибка внутри notify не должна звать notify. */
    private static bool $busy = false;

    /** Файлы PHPMailer подключаем один раз за запрос. */
    private static bool $mailerLoaded = false;

    /** Одно письмо на одинаковую причину раз в 15 минут. */
    private const THROTTLE_SEC = 900;

    /** Потолок на час — защита от лавины при массовом сбое. */
    private const HOURLY_CAP = 20;

    private const DEFAULT_TIMEOUT = 8;

    /**
     * @param string  $event   короткий код: spult_signal_lost, api_fatal, …
     * @param string  $message человекочитаемое описание
     * @param array   $context диагностика (reason, адрес, файл, id)
     * @param DB|null $db      если доступен — добавит админа тенанта
     * @param string  $tenant  поддомен, для темы и подписи
     * @return bool письмо реально отправлено (false = подавлено или сбой)
     */
    public static function notify(
        string $event,
        string $message,
        array $context = [],
        ?DB $db = null,
        string $tenant = ''
    ): bool {
        if (self::$busy) {
            return false;
        }
        self::$busy = true;

        try {
            return self::dispatch($event, $message, $context, $db, $tenant);
        } catch (\Throwable $e) {
            // Наружу не отдаём ничего: сбой оповещения не ломает обработку.
            // error_log, а не Logger — Logger может сам звать оповещение.
            error_log('AdminAlert failed: ' . $e->getMessage());
            return false;
        } finally {
            self::$busy = false;
        }
    }

    private static function dispatch(
        string $event,
        string $message,
        array $context,
        ?DB $db,
        string $tenant
    ): bool {
        $recipients = self::recipients($db);
        if ($recipients === []) {
            error_log('AdminAlert: no recipients configured, event=' . $event);
            return false;
        }

        // Подпись включает тенант и причину: сбой на одном тенанте
        // не должен подавлять такой же сбой на другом.
        $signature = md5($tenant . '|' . $event . '|' . (string) ($context['reason'] ?? ''));
        $dir = self::stateDir();

        if (!self::allow($dir, $signature)) {
            error_log('AdminAlert: throttled, event=' . $event);
            return false;
        }

        $subject = sprintf('[LiftCS%s] %s', $tenant !== '' ? ' ' . $tenant : '', $event);
        $body    = self::body($event, $message, $context, $tenant);

        // Основной транспорт. null = SMTP не настроен, переходим к фолбэку.
        $sent = self::sendSmtp($recipients, $subject, $body);

        if ($sent === null) {
            $sent = self::sendMail($recipients, $subject, $body);
        }

        if (!$sent) {
            // Сбой отправки не должен запирать канал на 15 минут.
            // Часовой потолок остаётся и ограничивает лавину.
            @unlink($dir . '/' . $signature . '.last');
        }

        return $sent;
    }

    // -----------------------------------------------------------------------
    // Транспорты
    // -----------------------------------------------------------------------

    /**
     * Авторизованный SMTP через PHPMailer.
     *
     * @return bool|null true — отправлено, false — ошибка, null — не настроен
     */
    private static function sendSmtp(array $recipients, string $subject, string $body): ?bool
    {
        $host = self::conf('ADMIN_SMTP_HOST');
        $user = self::conf('ADMIN_SMTP_USER');
        $pass = self::conf('ADMIN_SMTP_PASS');

        if ($host === '' || $user === '' || $pass === '') {
            error_log('AdminAlert: SMTP not configured, falling back to mail()');
            return null;
        }

        if (!self::loadMailer()) {
            error_log('AdminAlert: PHPMailer files missing, falling back to mail()');
            return null;
        }

        $from = self::sender();

        try {
            // true = исключения вместо возврата false: нам нужен текст отказа.
            $mail = new PHPMailer(true);

            $mail->isSMTP();
            $mail->Host       = $host;
            $mail->SMTPAuth   = true;
            $mail->Username   = $user;
            $mail->Password   = $pass;
            $mail->Port       = (int) (self::conf('ADMIN_SMTP_PORT') ?: '465');
            $mail->Timeout    = (int) (self::conf('ADMIN_SMTP_TIMEOUT') ?: (string) self::DEFAULT_TIMEOUT);
            $mail->CharSet    = 'UTF-8';

            $secure = strtolower(self::conf('ADMIN_SMTP_SECURE') ?: 'ssl');
            if ($secure === 'ssl' || $secure === 'tls') {
                $mail->SMTPSecure = $secure;
            }

            // Отладка протокола — только в error_log. По умолчанию выкл:
            // любой вывод в браузер сломает JSON ответа API.
            $debug = (int) self::conf('ADMIN_SMTP_DEBUG');
            if ($debug > 0) {
                $mail->SMTPDebug  = $debug;
                $mail->Debugoutput = 'error_log';
            }

            // From обязан совпадать с авторизованным ящиком, иначе
            // сервер отклонит по sender mismatch.
            $mail->setFrom($from, 'LiftCS Alerts');

            foreach ($recipients as $addr) {
                $mail->addAddress($addr);
            }

            $mail->Subject = $subject;   // PHPMailer сам кодирует заголовок
            $mail->Body    = $body;
            $mail->isHTML(false);

            $mail->send();

            error_log(sprintf(
                'AdminAlert: SMTP accepted, to=%s, subject=%s',
                implode(',', $recipients),
                $subject
            ));

            return true;

        } catch (\Throwable $e) {
            // PHPMailer\Exception, ErrorException из set_error_handler,
            // Error при отсутствии класса — всё сюда. Текст отказа сервера
            // виден в логе, а не «принято и пропало».
            error_log('AdminAlert: SMTP FAILED — ' . $e->getMessage());
            return false;
        }
    }

    /**
     * Фолбэк на mail(). На этом хостинге не доставляет, но оставлен:
     * если SMTP не настроен или недоступен, попытка лучше, чем ничего.
     */
    private static function sendMail(array $recipients, string $subject, string $body): bool
    {
        $from = self::sender();
        $host = preg_replace('/:\d+$/', '', (string) ($_SERVER['HTTP_HOST'] ?? 'localhost')) ?: 'localhost';

        // Date и Message-ID: без них провайдеры повышают спам-рейтинг.
        // uniqid вместо random_bytes — не бросает исключение.
        $headers = implode("\r\n", [
            'From: ' . $from,
            'Date: ' . date('r'),
            'Message-ID: <' . uniqid() . '.' . mt_rand(1000, 9999) . '@' . $host . '>',
            'MIME-Version: 1.0',
            'Content-Type: text/plain; charset=UTF-8',
            'Content-Transfer-Encoding: 8bit',
        ]);

        // -f задаёт envelope-sender (Return-Path): без него SPF проверяется
        // по домену системного пользователя, а bounce уходит в никуда.
        // Адрес прошёл filter_var, инъекция невозможна.
        $params  = '-f' . $from;
        $encoded = mb_encode_mimeheader($subject, 'UTF-8', 'B');

        $allOk = true;
        foreach ($recipients as $addr) {
            $ok = @mail($addr, $encoded, $body, $headers, $params);
            error_log(sprintf(
                'AdminAlert: mail(%s) -> %s',
                $addr,
                $ok ? 'accepted' : 'FAILED'
            ));
            if (!$ok) {
                $allOk = false;
            }
        }

        return $allOk;
    }

    /** Подключение PHPMailer. Без composer, порядок: Exception → SMTP → PHPMailer. */
    private static function loadMailer(): bool
    {
        if (self::$mailerLoaded) {
            return true;
        }

        $dir = __DIR__ . '/PHPMailer';
        foreach (['Exception.php', 'SMTP.php', 'PHPMailer.php'] as $file) {
            $path = $dir . '/' . $file;
            if (!is_file($path)) {
                return false;
            }
            require_once $path;
        }

        self::$mailerLoaded = true;
        return true;
    }

    // -----------------------------------------------------------------------
    // Конфигурация и получатели
    // -----------------------------------------------------------------------

    private static function conf(string $name): string
    {
        return defined($name) ? trim((string) constant($name)) : '';
    }

    /**
     * Получатели: системный админ (константа) + админ тенанта (lift_options).
     * Объединяются, а не подменяются — инфраструктурный сбой должен видеть
     * и владелец системы, и админ организации.
     *
     * @return list<string>
     */
    private static function recipients(?DB $db): array
    {
        $raw = self::conf('ADMIN_ALERT_EMAIL');

        // БД может лежать — это не ошибка, просто работаем без тенантского адреса.
        if ($db !== null) {
            try {
                $row = $db->fetchOne(
                    "SELECT option_value FROM lift_options WHERE option_name = 'admin_email' LIMIT 1"
                );
                $extra = trim((string) ($row['option_value'] ?? ''));
                if ($extra !== '') {
                    $raw .= ',' . $extra;
                }
            } catch (\Throwable $e) {
                // Молча: недоступность БД — как раз то, о чём пишем.
            }
        }

        $parts = preg_split('/[;,\s]+/', $raw) ?: [];

        $valid = [];
        foreach ($parts as $addr) {
            $addr = trim($addr);
            // filter_var отсекает и \r\n, поэтому инъекция заголовков невозможна.
            if ($addr !== '' && filter_var($addr, FILTER_VALIDATE_EMAIL) !== false) {
                $valid[$addr] = $addr;
            }
        }

        return array_values($valid);
    }

    private static function sender(): string
    {
        foreach (['ADMIN_ALERT_FROM', 'ADMIN_SMTP_USER'] as $name) {
            $value = self::conf($name);
            if ($value !== '' && filter_var($value, FILTER_VALIDATE_EMAIL) !== false) {
                return $value;
            }
        }

        $host = preg_replace('/:\d+$/', '', (string) ($_SERVER['HTTP_HOST'] ?? 'localhost')) ?: 'localhost';
        return 'no-reply@' . $host;
    }

    // -----------------------------------------------------------------------
    // Троттлинг
    // -----------------------------------------------------------------------

    /**
     * Папка состояния — вне web-root: метки времени и счётчики
     * из браузера читаться не должны.
     */
    private static function stateDir(): string
    {
        $dir = self::conf('ADMIN_ALERT_STATE_DIR');
        if ($dir === '') {
            $dir = dirname(__DIR__, 3) . '/_alerts';
        }

        if (!is_dir($dir)) {
            @mkdir($dir, 0750, true);
        }
        if (is_dir($dir) && is_writable($dir)) {
            return $dir;
        }

        // Фолбэк: лучше временная папка, чем отсутствие троттлинга.
        $fallback = sys_get_temp_dir() . '/liftcs_alerts';
        if (!is_dir($fallback)) {
            @mkdir($fallback, 0750, true);
        }

        return $fallback;
    }

    /**
     * Атомарная проверка «пора ли слать» с установкой метки.
     *
     * flock(LOCK_EX | LOCK_NB): второй параллельный процесс не ждёт,
     * а сразу отказывается — письмо уже отправляет первый.
     * Метка пишется ДО отправки: сбой транспорта не порождает лавину.
     */
    private static function allow(string $dir, string $signature): bool
    {
        $now = time();

        // Часовой потолок. Счётчик не атомарен — приблизительного
        // ограничения достаточно, лишний замок здесь не нужен.
        $hourFile = $dir . '/hour_' . date('YmdH') . '.cnt';
        $count    = (int) @file_get_contents($hourFile);
        if ($count >= self::HOURLY_CAP) {
            return false;
        }

        $lockFile = $dir . '/' . $signature . '.last';
        $fp = @fopen($lockFile, 'c+');
        if ($fp === false) {
            // Не смогли открыть — лучше отправить, чем потерять оповещение.
            return true;
        }

        if (!flock($fp, LOCK_EX | LOCK_NB)) {
            fclose($fp);
            return false;
        }

        $last = (int) stream_get_contents($fp);
        if ($last > 0 && ($now - $last) < self::THROTTLE_SEC) {
            flock($fp, LOCK_UN);
            fclose($fp);
            return false;
        }

        ftruncate($fp, 0);
        rewind($fp);
        fwrite($fp, (string) $now);
        fflush($fp);
        flock($fp, LOCK_UN);
        fclose($fp);

        @file_put_contents($hourFile, (string) ($count + 1), LOCK_EX);

        return true;
    }

    // -----------------------------------------------------------------------
    // Форматирование
    // -----------------------------------------------------------------------

    private static function body(string $event, string $message, array $context, string $tenant): string
    {
        $lines = [
            'Событие:  ' . $event,
            'Тенант:   ' . ($tenant !== '' ? $tenant : '—'),
            'Время:    ' . date('d.m.Y H:i:s') . ' (Europe/Moscow)',
            'Хост:     ' . ($_SERVER['HTTP_HOST'] ?? 'cli'),
            'Запрос:   ' . ($_SERVER['REQUEST_URI'] ?? '—'),
            'IP:       ' . ($_SERVER['REMOTE_ADDR'] ?? '—'),
            '',
            'Сообщение:',
            $message,
        ];

        if ($context !== []) {
            $lines[] = '';
            $lines[] = 'Контекст:';
            $lines[] = (string) json_encode(
                $context,
                JSON_UNESCAPED_UNICODE | JSON_UNESCAPED_SLASHES
                | JSON_PRETTY_PRINT | JSON_INVALID_UTF8_SUBSTITUTE
            );
        }

        $lines[] = '';
        $lines[] = '—';
        $lines[] = 'Письмо автоматическое. Повтор по этой же причине подавляется на 15 минут.';

        return implode("\n", $lines);
    }
}