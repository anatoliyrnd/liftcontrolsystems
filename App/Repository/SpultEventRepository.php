<?php
declare(strict_types=1);

namespace App\Repository;

use App\Database\DB;

/**
 * Журнал событий интеграции СПульт (таблица spult_events).
 *
 * Три канала оповещения не заменяют друг друга:
 *   - spult_events — 30 дней, разбор постфактум через админ-панель;
 *   - лента notifications — 30 минут, только открытая вкладка;
 *   - письмо админу — единственный канал при закрытой вкладке.
 *
 * Метод записи НИКОГДА не бросает. Журнал — побочный канал: его сбой
 * не имеет права уронить приём сигнала. Пульт не ретраит, поэтому
 * любой необработанный эксепшн здесь = потерянная заявка.
 */
final class SpultEventRepository
{
    /**
     * Словарь типов. Он же — контракт для админ-панели: severity задаёт
     * цвет, ticket_expected объясняет, будет ли ссылка на карточку.
     *
     * admin_alert: false только у spult_id_conflict — расхождение
     * служебного идентификатора не мешает работе, письмо не нужно.
     */
    private const KINDS = [
        'guid_mismatch' => [
            'title'           => 'GUID найден, адрес в сигнале отличается',
            'severity'        => 'warning',
            'ticket_expected' => true,
            'admin_alert'     => true,
        ],
        'guid_conflict' => [
            'title'           => 'У объекта другой GUID, привязка не изменена',
            'severity'        => 'critical',
            'ticket_expected' => true,
            'admin_alert'     => true,
        ],
        'spult_id_conflict' => [
            'title'           => 'LIFT@ID отличается от сохранённого',
            'severity'        => 'info',
            'ticket_expected' => true,
            'admin_alert'     => false,
        ],
        'address_unresolved' => [
            'title'           => 'Адрес не распознан, XML_add запрещает создание',
            'severity'        => 'critical',
            'ticket_expected' => false,
            'admin_alert'     => true,
        ],
        'org_mismatch' => [
            'title'           => 'Имя организации не совпало с настройкой',
            'severity'        => 'critical',
            'ticket_expected' => false,
            'admin_alert'     => true,
        ],
        'pult_guid_mismatch' => [
            'title'           => 'GUID пульта не совпал с ожидаемым',
            'severity'        => 'critical',
            'ticket_expected' => false,
            'admin_alert'     => true,
        ],
        'bad_xml' => [
            'title'           => 'XML не распарсился',
            'severity'        => 'warning',
            'ticket_expected' => false,
            'admin_alert'     => true,
        ],
        'duplicate_note_failed' => [
            'title'           => 'Дубликат найден, заметка не записана',
            'severity'        => 'critical',
            'ticket_expected' => true,
            'admin_alert'     => true,
        ],
        'fatal' => [
            'title'           => 'Системный сбой приёма сигнала',
            'severity'        => 'critical',
            'ticket_expected' => false,
            'admin_alert'     => true,
        ],
    ];

    /**
     * Окно подавления повторов: одно событие одного типа по лифту
     * не чаще, чем раз в 15 минут.
     *
     * Зачем: если пульт переименует улицу, каждый сигнал каждого лифта
     * даст guid_mismatch. Без окна журнал вырастет на десятки тысяч
     * строк в сутки — ровно тот потребитель диска, ради которого
     * делался cron. Сырой XML при этом сохраняется по КАЖДОМУ сигналу,
     * информация не теряется.
     *
     * 0 = подавление выключено, писать всё.
     */
    private const SUPPRESS_SEC = 900;

    /** Потолок meta: longtext вмещает больше, но раздувать журнал нечем. */
    private const META_MAX_BYTES = 65535;

    // Ширины колонок из миграции 1.2. Обрезка обязательна: в strict mode
    // MariaDB длинное значение даёт 1406 Data too long → эксепшн → потеря сигнала.
    private const W_KIND       = 32;
    private const W_SPUST_ID   = 32;
    private const W_ADDRESS    = 512;
    private const W_MESSAGE    = 500;
    private const W_SPOOL_FILE = 255;

    public function __construct(private readonly DB $db)
    {
    }

    /**
     * Записать событие.
     *
     * Вызов с именованными аргументами читается на месте:
     *   $events->record('guid_mismatch', message: '...', liftId: 12, ticketId: 35732, ...)
     *
     * @param string      $kind       ключ из словаря KINDS
     * @param string      $message    человекочитаемое описание
     * @param int|null    $liftId     объект, если удалось определить
     * @param int|null    $ticketId   заявка, если создана
     * @param string|null $guid       GUID из XML (нормализуется)
     * @param string|null $spultId    LIFT@ID из XML
     * @param string|null $xmlAddress адрес как пришёл из пульта
     * @param string|null $dbAddress  адрес объекта в нашей БД
     * @param string|null $spoolFile  относительный путь в _spult/, напр. quarantine/2026….xml
     * @param array       $meta       диагностика: статусы, классификация, id
     * @return bool true = строка вставлена; false = подавлено, неизвестный тип или сбой
     */
    public function record(
        string $kind,
        string $message = '',
        ?int $liftId = null,
        ?int $ticketId = null,
        ?string $guid = null,
        ?string $spultId = null,
        ?string $xmlAddress = null,
        ?string $dbAddress = null,
        ?string $spoolFile = null,
        array $meta = []
    ): bool {
        try {
            $kind = $this->cut($kind, self::W_KIND);

            if (!isset(self::KINDS[$kind])) {
                // Не бросаем: событие всё равно фиксируем, иначе потеряем
                // диагностику из-за опечатки в вызывающем коде.
                error_log('SpultEventRepository: unknown kind "' . $kind . '"');
            }

            if ($this->isSuppressed($kind, $liftId)) {
                return false;
            }

            // Каноническая форма GUID — чтобы панель могла фильтровать
            // и джойнить с lift_object.guid (колонка ascii_bin, сравнение побайтовое).
            $normalizedGuid = CallRepository::normalizeGuid($guid);

            // Невалидный GUID не выбрасываем: сырое значение уходит в meta,
            // иначе нечем разобрать, что именно прислал пульт.
            if ($normalizedGuid === null && trim((string) $guid) !== '') {
                $meta['guid_raw'] = $this->cut((string) $guid, 64);
            }

            $this->db->execute(
                "INSERT INTO spult_events
                     (kind, lift_id, ticket_id, guid, spult_id,
                      xml_address, db_address, message, spool_file, meta)
                 VALUES
                     (:kind, :lift_id, :ticket_id, :guid, :spult_id,
                      :xml_address, :db_address, :message, :spool_file, :meta)",
                [
                    'kind'        => $kind,
                    'lift_id'     => $liftId,
                    'ticket_id'   => $ticketId,
                    'guid'        => $normalizedGuid,
                    'spult_id'    => $this->nullableCut($spultId, self::W_SPUST_ID),
                    'xml_address' => $this->nullableCut($xmlAddress, self::W_ADDRESS),
                    'db_address'  => $this->nullableCut($dbAddress, self::W_ADDRESS),
                    'message'     => $this->nullableCut($message, self::W_MESSAGE),
                    'spool_file'  => $this->nullableCut($spoolFile, self::W_SPOOL_FILE),
                    'meta'        => $this->encodeMeta($meta),
                ]
            );

            return true;

        } catch (\Throwable $e) {
            // Журнал не имеет права уронить приём сигнала.
            error_log('SpultEventRepository: record failed (' . $kind . ') — ' . $e->getMessage());
            return false;
        }
    }

    /**
     * Словарь типов для админ-панели: заголовок, severity, ожидание заявки.
     *
     * @return array<string, array{title:string,severity:string,ticket_expected:bool,admin_alert:bool}>
     */
    public static function kinds(): array
    {
        return self::KINDS;
    }

    /** severity для окраски в панели; неизвестный тип считаем warning. */
    public static function severity(string $kind): string
    {
        return self::KINDS[$kind]['severity'] ?? 'warning';
    }

    /**
     * Нужно ли письмо админу. Отдельно от severity: guid_mismatch —
     * warning по цвету, но письмо нужно (решение согласовано).
     */
    public static function shouldAlertAdmin(string $kind): bool
    {
        return self::KINDS[$kind]['admin_alert'] ?? true;
    }

    // -----------------------------------------------------------------------
    // Внутреннее
    // -----------------------------------------------------------------------

    /**
     * Было ли такое же событие по этому лифту внутри окна подавления.
     *
     * Запрос покрыт индексом idx_kind_lift (kind, lift_id, created_at).
     * lift_id IS NULL обрабатывается отдельно: у org_mismatch, bad_xml
     * и fatal объекта нет, а `= NULL` в SQL никогда не истинно.
     */
    private function isSuppressed(string $kind, ?int $liftId): bool
    {
        if (self::SUPPRESS_SEC <= 0) {
            return false;
        }

        $sql = sprintf(
            "SELECT id FROM spult_events
             WHERE kind = :kind
               AND lift_id %s
               AND created_at > NOW() - INTERVAL %d SECOND
             LIMIT 1",
            $liftId === null ? 'IS NULL' : '= :lift',
            self::SUPPRESS_SEC
        );

        $params = ['kind' => $kind];
        if ($liftId !== null) {
            $params['lift'] = $liftId;
        }

        return (bool) $this->db->fetchOne($sql, $params);
    }

    /**
     * meta в JSON. Битая кодировка не должна валить вставку: колонка
     * longtext без CHECK, но невалидный JSON сломал бы разбор в панели.
     */
    private function encodeMeta(array $meta): ?string
    {
        if ($meta === []) {
            return null;   // не храним пустой "{}"
        }

        $json = (string) json_encode(
            $meta,
            JSON_UNESCAPED_UNICODE | JSON_UNESCAPED_SLASHES | JSON_INVALID_UTF8_SUBSTITUTE
        );

        // Обрезать JSON нельзя — получится невалидная строка.
        // При превышении потолка пишем маркер, сырьё остаётся в спуле.
        if (strlen($json) > self::META_MAX_BYTES) {
            return '{"truncated":true}';
        }

        return $json;
    }

    private function cut(string $value, int $width): string
    {
        return mb_substr(trim($value), 0, $width);
    }

    /** Пустая строка → NULL: в журнале отсутствие значения и пустота — одно и то же. */
    private function nullableCut(?string $value, int $width): ?string
    {
        $cut = $this->cut((string) $value, $width);
        return $cut === '' ? null : $cut;
    }
}