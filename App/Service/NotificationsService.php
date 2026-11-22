<?php

declare(strict_types=1);

namespace App\Service;

use App\Database\DB;

/**
 * Очередь уведомлений для SPA.
 *
 * События живут 30 минут (вероятностная чистка при создании).
 * Клиент поллит notifications каждые 120 с — окна хватает.
 *
 * Лента — best-effort канал: закрытая вкладка событие не увидит.
 * Долговременные каналы для сбоев интеграции: spult_events (30 дней)
 * и письмо админу через AdminAlert.
 *
 * ИНВАРИАНТ: методы событий (ticket*, spultError) и чтение ленты
 * НЕ БРОСАЮТ. Событие пишется ПОСЛЕ коммита бизнес-операции —
 * CallService зовёт ticket* в конце метода, транзакции в online-пути
 * нет. Throw отсюда превращал уже созданную заявку в ответ 500, а
 * в sp.php уводил сигнал в failed/ с письмом «сигнал потерян» — при
 * существующей заявке. Отказ канала обязан стоить только самого
 * уведомления.
 *
 * cleanup() — исключение из инварианта: публичный и бросающий,
 * его зовёт cron, где отказ должен быть виден, а не проглочен.
 */
final class NotificationsService
{
    /**
     * Системный автор. В БД пишем NULL (колонка nullable, FK нет),
     * в ответе приводим к int → 0, как в контракте §11.1.
     * Клиентский фильтр «не показывать свои действия» при 0 не срабатывает.
     */
    private const SYSTEM_ACTOR = null;

    /** Предел текста: колонка varchar(500). Клиент по §11.2.1 не обрезает. */
    private const TEXT_MAX = 500;

    /**
     * Окно свежести события. Одна константа на чистку и на выборку:
     * раньше «30 минут» было вписано литералом в cleanup(), а getSince()
     * окна не знал вовсе — два места одного правила разошлись бы.
     */
    private const TTL_SEC = 1800;

    /**
     * Окно агрегации расхождений: одно уведомление на kind за 15 минут.
     * Тенант отдельной БД, поэтому «на тенант» получается само собой.
     */
    private const AGGREGATE_SEC = 900;

    public function __construct(private readonly DB $db)
    {
    }

    /** Заявка создана. */
    public function ticketCreated(int $ticketId, string $address, string $creatorName, int $userId): void
    {
        $this->create([
            'event_type' => 'ticket_created',
            'ticket_id'  => $ticketId,
            'user_id'    => $userId,
            'text'       => "Новая заявка №{$ticketId}: {$address} (создал: {$creatorName})",
            'sound'      => 1,
            'timeout'    => 8000,
        ]);
    }

    /** Заявка закрыта. */
    public function ticketClosed(int $ticketId, string $solution, string $closerName, int $userId): void
    {
        $this->create([
            'event_type' => 'ticket_closed',
            'ticket_id'  => $ticketId,
            'user_id'    => $userId,
            'text'       => "Заявка №{$ticketId} закрыта: {$solution} ({$closerName})",
            'sound'      => 0,
            'timeout'    => 6000,
        ]);
    }

    /** Заявка отредактирована. */
    public function ticketEdited(int $ticketId, string $editorName, int $userId): void
    {
        $this->create([
            'event_type' => 'ticket_edited',
            'ticket_id'  => $ticketId,
            'user_id'    => $userId,
            'text'       => "Заявка №{$ticketId} отредактирована ({$editorName})",
            'sound'      => 0,
            'timeout'    => 5000,
        ]);
    }

    /** Добавлен комментарий. */
    public function ticketNote(int $ticketId, string $authorName, int $userId): void
    {
        $this->create([
            'event_type' => 'ticket_note',
            'ticket_id'  => $ticketId,
            'user_id'    => $userId,
            'text'       => "Новый комментарий к заявке №{$ticketId} от {$authorName}",
            'sound'      => 0,
            'timeout'    => 5000,
        ]);
    }

    /**
     * Сигнал СПульт не обработан либо обработан с расхождением (§11.2.1).
     *
     * sound по наличию заявки:
     *   ticket_id === null — сигнал потерян, заявки нет → звук;
     *   ticket_id !== null — заявка создана, диспетчер увидит её в журнале,
     *                        расхождение уходит админу письмом → без звука.
     *
     * Агрегация (вариант A): при созданной заявке — не более одного
     * уведомления на kind за 15 минут. Иначе переименование улицы в пульте
     * даст тост на каждый лифт. Потерянные сигналы уведомляются ВСЕГДА.
     *
     * timeout = 0 — persistent, сервер шлёт явно; per-type override
     * на клиенте запрещён (§11.1).
     *
     * try здесь оставлен, хотя create() уже безопасен: он покрывает
     * isAggregated() — это чтение, и оно падает отдельно от записи.
     *
     * @param string   $kind     ключ из словаря SpultEventRepository::kinds()
     * @param string   $message  текст с адресом и причиной, формирует sp.php
     * @param int|null $ticketId заявка, если создана; null = сигнал потерян
     */
    public function spultError(string $kind, string $message, ?int $ticketId = null): void
    {
        try {
            // Машинный маркер вида [SPult:guid_mismatch] — тот же формат,
            // что в lift_history. Нужен для агрегации: отдельной колонки
            // kind в lift_notifications нет, а по event_type все расхождения
            // неразличимы.
            $marker = '[SPult:' . $kind . '] ';

            // Обрезка здесь не нужна: предел длины обеспечивает create()
            // для ВСЕХ типов событий. Маркер стоит первым и переживает
            // обрезку — агрегация по INSTR(text, marker) = 1 не ломается.
            $text = $marker . trim($message);

            if ($ticketId !== null && $this->isAggregated($marker)) {
                return;
            }

            $this->create([
                'event_type' => 'spult_error',
                'ticket_id'  => $ticketId,
                'user_id'    => self::SYSTEM_ACTOR,
                'text'       => $text,
                'sound'      => $ticketId === null ? 1 : 0,
                'timeout'    => 0,
            ]);
        } catch (\Throwable $e) {
            error_log('NotificationsService: spultError failed — ' . $e->getMessage());
        }
    }

    /**
     * Уведомления начиная с указанного ID.
     *
     * B3.8: actor_id (user_id) и created_at. Без actor_id клиент
     * не фильтрует собственные действия и показывает пользователю
     * тосты о его же операциях, включая звуковые.
     *
     * Типы приводятся явно: PDO отдаёт строки, а "0" в JavaScript — truthy.
     * Без приведения sound срабатывал бы у всех событий, включая закрытие
     * и правку, где он выключён.
     *
     * timeout сравнивается с null, а не на truthy: 0 — это persistent
     * (§11.2.1). Truthy-проверка превратила бы ноль в null, клиент применил
     * бы дефолт типа 8 с, и persistent-тост закрывался бы сам.
     *
     * ОКНО СВЕЖЕСТИ проверяется здесь, а не только чисткой (§11.4.1:
     * «если вкладка была закрыта дольше 30 минут, событие в ленту
     * не попадёт»). Чистка вероятностная и запускается при СОЗДАНИИ:
     * на тихом тенанте она не выпадает вовсе, и вкладка после простоя
     * получала тосты часовой давности со звуком и persistent-очередью.
     *
     * Условие в SQL, а не отбор в PHP: курсор last_id двигается только
     * по отданным строкам. При отборе в PHP лимит 50 мог бы целиком
     * состоять из протухших строк — ответ пустой, курсор стоит на месте,
     * и свежие события с большим id не достигались бы никогда.
     *
     * Протухшие строки исчезает cleanup(); его стоит подключить к cron,
     * иначе на тихом тенанте они висят до следующего события и диапазон
     * id > since_id перечитывается на каждом тике. Таблица мала (TTL 30 мин,
     * есть idx_created_at), но бесплатной эта перечитка не является.
     *
     * @return array{notifications: array<int, array<string, mixed>>, last_id: int}
     */
    public function getSince(int $sinceId, int $limit = 50): array
    {
        // $limit уже int — безопасно вставлять в SQL.
        $safeLimit = max(1, min($limit, 100));

        $rows = $this->db->fetchAll(
            "SELECT id, event_type, ticket_id, user_id AS actor_id, text, sound, timeout, created_at
             FROM lift_notifications
             WHERE id > :since_id AND created_at > :cutoff
             ORDER BY id ASC
             LIMIT {$safeLimit}",
            [
                'since_id' => $sinceId,
                'cutoff'   => time() - self::TTL_SEC,
            ]
        );

        $notifications = [];
        foreach ($rows as $row) {
            $notifications[] = [
                'id'         => (int) $row['id'],
                'event_type' => (string) $row['event_type'],
                'ticket_id'  => $row['ticket_id'] !== null ? (int) $row['ticket_id'] : null,
                'actor_id'   => (int) ($row['actor_id'] ?? 0),
                'text'       => (string) $row['text'],
                'sound'      => (bool) $row['sound'],
                'timeout'    => $row['timeout'] !== null ? (int) $row['timeout'] : null,
                'created_at' => (int) $row['created_at'],
            ];
        }

        $lastId = $sinceId;
        if ($notifications !== []) {
            $lastId = (int) end($notifications)['id'];
        }

        return [
            'notifications' => $notifications,
            'last_id'       => $lastId,
        ];
    }

    /**
     * Окно свежести — TTL_SEC.
     *
     * Публичный и бросающий: вызывается из cron_cleanup.php, где отказ
     * должен быть виден. Внутри сервиса используется тихая обёртка
     * cleanupProbabilistic().
     */
    public function cleanup(): void
    {
        $this->db->execute(
            "DELETE FROM lift_notifications WHERE created_at < :cutoff",
            ['cutoff' => time() - self::TTL_SEC]
        );
    }

    // -----------------------------------------------------------------------
    // Внутреннее
    // -----------------------------------------------------------------------

    /**
     * Внутреннее создание события. Никогда не бросает.
     *
     * Причина отказа пишется в лог, но наружу не выходит: бизнес-операция
     * к этому моменту уже закоммичена. Молчать совсем нельзя — потерянное
     * уведомление иначе не отличить от «события не было».
     *
     * Текст события в лог не дублируем: DB::execute уже пишет SQL и params
     * через Logger::error, адрес и ФИО там есть.
     */
    private function create(array $data): void
    {
        try {
            // Предел длины — здесь, а не в одном вызывающем методе.
            // call_solution и call_details — TEXT без предела, колонка
            // varchar(500). sql_mode без STRICT_TRANS_TABLES обрезает
            // длинное значение МОЛЧА: раньше терялся хвост текста, а не
            // операция. Своя обрезка сохраняет маркер и осмысленное начало
            // и ставит многоточие — пользователь видит, что текст неполон.
            $text = $this->fitText((string) ($data['text'] ?? ''));

            // Показывать нечего, а NOT NULL дал бы 1048.
            if ($text === '') {
                return;
            }

            $this->cleanupProbabilistic();

            $this->db->execute(
                "INSERT INTO lift_notifications
                    (event_type, ticket_id, user_id, text, sound, timeout, created_at)
                 VALUES
                    (:event_type, :ticket_id, :user_id, :text, :sound, :timeout, :created_at)",
                [
                    'event_type' => $data['event_type'] ?? 'unknown',
                    'ticket_id'  => $data['ticket_id'] ?? null,
                    'user_id'    => $data['user_id'] ?? null,
                    'text'       => $text,
                    'sound'      => $data['sound'] ?? 0,
                    'timeout'    => $data['timeout'] ?? null,
                    'created_at' => time(),
                ]
            );
        } catch (\Throwable $e) {
            error_log(sprintf(
                'NotificationsService: create failed (event=%s, ticket=%s) — %s',
                (string) ($data['event_type'] ?? 'unknown'),
                isset($data['ticket_id']) ? (string) $data['ticket_id'] : 'null',
                $e->getMessage()
            ));
        }
    }

    /**
     * Вероятностная чистка: 20% шанс удалить протухшие записи.
     *
     * Отдельный try обязателен: без него сорванная уборка (блокировка
     * строки, моргнувшая БД) отменяла и сам INSERT — событие терялось
     * из-за работы, к которой оно отношения не имеет.
     */
    private function cleanupProbabilistic(): void
    {
        try {
            if (random_int(1, 100) <= 20) {
                $this->cleanup();
            }
        } catch (\Throwable $e) {
            error_log('NotificationsService: cleanup failed — ' . $e->getMessage());
        }
    }

    /**
     * Было ли уведомление с этим маркером внутри окна агрегации.
     *
     * Порядок условий не случаен: индекса по event_type нет, есть
     * idx_created_at. Диапазон по created_at отсекает почти всю таблицу
     * индексом, остальное дофильтровывается по строкам. Окно 15 минут
     * при TTL 30 — строк заведомо мало.
     *
     * INSTR вместо LIKE: в kind есть подчёркивание, а '_' в LIKE —
     * односимвольный wildcard. Через LIKE 'guid_mismatch' совпал бы
     * и с 'guidXmismatch'. INSTR сравнивает подстроку буквально.
     *
     * Гонка двух одновременных сигналов одного kind даст два тоста:
     * проверка и вставка не атомарны. Осознанно — канал best-effort,
     * а INSERT ... SELECT WHERE NOT EXISTS берёт gap-локи и на потоке
     * сигналов рискует дедлоком. Цена дубля — один лишний тост.
     */
    private function isAggregated(string $marker): bool
    {
        $row = $this->db->fetchOne(
            "SELECT id FROM lift_notifications
             WHERE created_at > :cutoff
               AND event_type = 'spult_error'
               AND INSTR(text, :marker) = 1
             LIMIT 1",
            [
                'cutoff' => time() - self::AGGREGATE_SEC,
                'marker' => $marker,
            ]
        );

        return (bool) $row;
    }

    /**
     * Гарантия длины по §11.2.1: клиент текст не обрезает, значит предел
     * обеспечивает сервер. Колонка varchar(500) NOT NULL.
     *
     * Маркер стоит первым и переживает обрезку; адрес и причину sp.php
     * ставит сразу за ним — теряется хвост, а не то, что передают голосом.
     *
     * Кодировка задана явно: varchar(500) считает СИМВОЛЫ, а без аргумента
     * mb_strlen берёт mb_internal_encoding — предел начал бы зависеть
     * от default_charset хостера и резал кириллицу не там.
     *
     * Таблица utf8mb4: 4-байтные символы проходят, отдельной фильтрации
     * не требуется. В отличие от lift_notes.note_body (utf8mb3), где
     * эмодзи обрезало бы строку на себе.
     */
    private function fitText(string $text): string
    {
        $text = trim($text);

        if (mb_strlen($text, 'UTF-8') <= self::TEXT_MAX) {
            return $text;
        }

        return mb_substr($text, 0, self::TEXT_MAX - 1, 'UTF-8') . '…';
    }
}