<?php

declare(strict_types=1);

namespace App\Http;

use App\Support\Logger;

/**
 * Единственная точка выхода HTTP для api.php и auth.php.
 *
 * ИНВАРИАНТ ПРОТОКОЛА: код всегда 200, ошибка — в теле. Клиент
 * классифицирует по status/code/reason, а не по HTTP-коду; любой
 * иной код попал бы в его журнал как транспортный сбой и запустил
 * офлайн-ветку там, где её нет.
 *
 * Следствие: тело обязано быть валидным JSON ВСЕГДА. Пустое тело
 * клиент трактует как invalid_response — худший исход, потому что
 * теряются и данные, и причина.
 *
 * Компенсация «всегда 200»: Cache-Control no-store, иначе
 * промежуточный кэш не отличит ошибку от успеха по коду ответа.
 * Мониторинг строить по code в теле, а не по HTTP-статусу.
 *
 * ТЕРМИНАЛЬНАЯ ОПЕРАЦИЯ: send() — never, вызывает exit. Код после
 * её вызова не выполнится, finally-блоки выше по стеку тоже.
 * Метрику дописывать некуда — только до вызова. В тестах send()
 * не зовут: собирают объект и читают data.
 */
final readonly class Response
{
    public function __construct(private array $data)
    {
    }

    /**
     * Успех.
     *
     * Левый операнд «+» выигрывает: ключ 'status' из payload молча
     * маскируется служебным. Сегодня ни один сервис 'status' внутрь
     * не кладёт (callnew отдаёт 'ok', что совпадает), но порядок
     * операндов — часть контракта, менять его нельзя.
     */
    public static function ok(array $payload = []): self
    {
        return new self(['status' => 'ok'] + $payload);
    }

    /**
     * Ошибка. Плоские поля протокола (retry_after, existing_tickets)
     * приходят через $extra и ложатся на верхний уровень (§16.1).
     *
     * Четыре служебных ключа вырезаются из $extra явно. «+» и так
     * оставил бы левые значения, но только для ТЕХ ключей, что уже
     * есть в $payload: при $reason === null ключа 'reason' слева нет,
     * и $extra подсунул бы свой в обход параметра. Для единственной
     * точки выхода это должна быть защита, а не совпадение порядка.
     */
    public static function error(
        ErrorCode $code,
        string $message = '',
        ?string $reason = null,
        array $extra = []
    ): self {
        unset($extra['status'], $extra['code'], $extra['message'], $extra['reason']);

        $payload = [
            'status'  => 'error',
            'code'    => $code->value,
            'message' => $message ?: $code->value,
        ];

        if ($reason !== null && $reason !== '') {
            $payload['reason'] = $reason;
        }

        // retry_after, existing_tickets — плоско на верхнем уровне.
        return new self($payload + $extra);
    }

    public function send(): never
    {
        // RFC 8259: JSON всегда UTF-8, параметр charset избыточен.
        header('Content-Type: application/json');
        http_response_code(200); // Всегда 200 OK — осознанное решение.

        // API отдаёт данные организации: промежуточный прокси и браузер
        // не должны их кэшировать. При «всегда 200» это ещё и защита
        // от кэширования ошибки как успешного ответа.
        header('Cache-Control: no-store');

        // Defense in depth: браузер не станет распознавать ответ как
        // HTML, даже если в данных окажется </script>.
        header('X-Content-Type-Options: nosniff');

        // INVALID_UTF8_SUBSTITUTE — основная защита: битый байт даёт
        // U+FFFD вместо json_encode === false. Источники реальны:
        // обрезка utf8mb3-колонки посередине символа (call_adres
        // varchar(100), note_post_ip varchar(20)) и мусор в payload
        // офлайн-команды. Без флага echo false печатал пустую строку.
        //
        // UNESCAPED_SLASHES сохранён: base64 выгрузки и адреса полны
        // '/', экранирование раздувало бы каждый ответ экспорта, а
        // вектор </script> закрыт nosniff и Content-Type.
        //
        // JSON_THROW_ON_ERROR не используем осознанно: исключение
        // ушло бы в наружный catch(Throwable) api.php, который отдаст
        // internal_error уже без нашей литеральной гарантии. Нам нужен
        // контроль над fallback именно здесь.
        $json = json_encode(
            $this->data,
            JSON_UNESCAPED_UNICODE | JSON_UNESCAPED_SLASHES | JSON_INVALID_UTF8_SUBSTITUTE
        );

        if ($json === false) {
            // SUBSTITUTE не спасает только при исчерпании глубины или
            // памяти. Мы уже в аварийном режиме, и логгер — не то, на
            // что можно опереться: переполненный диск или недоступный
            // приёмник логов бросят исключение, выполнение прервётся
            // ДО присвоения $json, и клиент получит пустое тело — ровно
            // то, что эта ветка обязана предотвращать.
            try {
                Logger::error('Response::send: json_encode failed', [
                    'error' => json_last_error_msg(),
                ]);
            } catch (\Throwable) {
                // Логировать больше некуда, но ответ обязан уйти.
            }

            // Код берём из enum, а не литералом: иначе переименование
            // кейса разошлось бы с ответом. sprintf, а не повторный
            // json_encode — он мог бы упасть по той же причине.
            // Значение enum — ASCII-идентификатор без кавычек и слэшей,
            // поэтому подстановка в JSON-литерал безопасна; при смене
            // формата значения литерал придётся пересобрать.
            //
            // reason отличает эту аварию от обычной internal_error:
            // клиент может показать другой текст или иную логику повтора.
            $json = sprintf(
                '{"status":"error","code":"%s","reason":"json_encode_failed",'
                . '"message":"Ошибка формирования ответа"}',
                ErrorCode::InternalError->value
            );
        }

        echo $json;
        exit;
    }
}