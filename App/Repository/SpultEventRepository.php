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
     * admin_alert: false у spult_id_conflict (расхождение служебного
     * идентификатора не мешает работе) и у info_status (штатная работа
     * фильтра, а не расхождение).
     *
     * ОТСУТСТВИЕ kind В СЛОВАРЕ — НЕ НЕЙТРАЛЬНО. shouldAlertAdmin()
     * для неизвестного типа возвращает true (fail-safe: лучше лишнее
     * письмо, чем потерянный инцидент). Поэтому штатный kind, забытый
     * в словаре, шлёт письмо админу на каждое событие — ровно то, что
     * происходило с info_status. Новый kind обязан заводиться здесь,
     * даже если он информационный.
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
        // Штатная работа фильтра статусов, а не расхождение.
        //
        // ПОЧЕМУ В СЛОВАРЕ, хотя в ленту не показывается. Это два
        // независимых решения: словарь отвечает «как классифицировать,
        // какого цвета и кому письмо», а FEED_SKIP_KINDS в
        // NotificationsService — «показывать ли плашку». Заявка создана,
        // отфильтрованные статусы сохранены в истории и в этом журнале;
        // тостом их показывать нечего, но событие обязано быть
        // первоклассным, иначе shouldAlertAdmin вернёт фолбэк true.
        //
        // Подавление SUPPRESS_SEC работает по паре (kind, lift_id):
        // переименование улицы в пульте даёт сигнал на каждый лифт,
        // и разные лифты не подавляются. Без admin_alert=false это
        // письмо на каждый лифт улицы.
        'info_status' => [
            'title'           => 'Информационные статусы пульта не включены в описание',
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

    // Ширины колонок из миграции 1.2.
    //
    // ПОПРАВКА К ПРЕЖНЕМУ КОММЕНТАРИЮ: sql_mode сервера проверен и
    // STRICT_TRANS_TABLES в нём НЕТ. Переполнение varchar обрезается
    // МОЛЧА, а не даёт 1406 и не бросает исключение. Прежнее обоснование
    // («иначе эксепшн → потеря сигнала») описывало режим, которого на
    // этом сервере нет.
    //
    // Обрезка всё равно нужна, но по другой причине: без неё хвост
    // теряется по прихоти сервера и незаметно, а с ней — предсказуемо,
    // по границе символа и в одном месте кода.
    private const W_KIND       = 32;
    private const W_SPULT_ID   = 32;
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
     * @return bool true = строка вставлена; false = подавлено окном или сбой записи.
     *              Неизвестный тип НЕ отбрасывается: событие пишется, в лог уходит
     *              предупреждение. Прежняя формулировка «false = … неизвестный тип»
     *              расходилась с кодом — проверка ниже только логирует.
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
                // Не бросаем и не отбрасываем: событие всё равно фиксируем,
                // иначе потеряем диагностику из-за опечатки в вызывающем коде.
                // Но молчать нельзя и здесь: неизвестный kind получит
                // shouldAlertAdmin() === true и уйдёт письмом админу.
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
                    'spult_id'    => $this->nullableCut($spultId, self::W_SPULT_ID),
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
     * Словарь типов для админ-панели: заголовок, severity, ожидание заявки,
     * нужно ли письмо админу.
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
     *
     * Фолбэк true осознан: неизвестный kind — это дефект вызывающего
     * кода, и лучше лишнее письмо, чем потерянный инцидент. Цена —
     * штатный kind, забытый в словаре, шлёт почту на каждое событие.
     * Поэтому словарь обязан пополняться вместе с новым kind.
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
     *
     * created_at — TIMESTAMP: хранится в UTC и приводится к зоне сессии
     * при чтении, NOW() тоже в зоне сессии. Сравнение согласовано при
     * любой зоне, поэтому фиксация time_zone в PDO его не ломает.
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

    /**
     * Обрезка по ширине колонки.
     *
     * Кодировка задана явно: varchar(N) считает СИМВОЛЫ, а без аргумента
     * mb_substr берёт mb_internal_encoding — ширина обрезки начала бы
     * зависеть от default_charset хостера и резала кириллицу не там.
     */
    private function cut(string $value, int $width): string
    {
        return mb_substr(trim($value), 0, $width, 'UTF-8');
    }

    /** Пустая строка → NULL: в журнале отсутствие значения и пустота — одно и то же. */
    private function nullableCut(?string $value, int $width): ?string
    {
        $cut = $this->cut((string) $value, $width);

        return $cut === '' ? null : $cut;
    }
}