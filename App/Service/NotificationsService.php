<?php
declare(strict_types=1);

namespace App\Service;

use App\Database\DB;

/**
 * Очередь уведомлений для SPA.
 *
 * События живут 30 минут (вероятностная чистка при создании).
 * Клиент поллит notifications каждые 120 с, поэтому окна хватает.
 *
 * Важно: лента — best-effort канал. Если вкладка закрыта дольше 30 минут,
 * событие исчезнет. Долговременные каналы: таблица spult_events (30 дней)
 * и письмо админу через AdminAlert.
 */
final class NotificationsService
{
    /**
     * Системный автор. В БД пишем NULL, а не 0: у lift_notifications
     * может быть FK на lift_users, и нулевой id его нарушит.
     * В ответе actor_id приводится к int и станет 0 — как ждёт протокол.
     */
    private const SYSTEM_ACTOR = null;

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
     * sound дифференцирован по наличию заявки:
     *   ticket_id === null  — сигнал потерян, заявки нет, требует внимания → звук;
     *   ticket_id !== null  — заявка создана, диспетчер увидит её в журнале,
     *                         расхождение — вопрос к админу, письмо уже ушло → без звука.
     * Без этого переименование улицы в пульте даст звуковой тост на каждый лифт.
     *
     * timeout = 0 — persistent, сервер шлёт явно. Клиентский дефолт типа
     * не применяется, per-type override на клиенте запрещён (§11.1).
     *
     * Метод никогда не бросает: побочный канал не имеет права уронить приём
     * сигнала — пульт не ретраит.
     *
     * @param string   $message  готовый текст с адресом и причиной, формирует sp.php
     * @param int|null $ticketId заявка, если создана; null = сигнал потерян
     */
    public function spultError(string $message, ?int $ticketId = null): void
    {
        try {
            $this->create([
                'event_type' => 'spult_error',
                'ticket_id'  => $ticketId,
                'user_id'    => self::SYSTEM_ACTOR,
                'text'       => $this->fitText($message),
                'sound'      => $ticketId === null ? 1 : 0,
                'timeout'    => 0,
            ]);
        } catch (\Throwable $e) {
            error_log('NotificationsService: spultError failed — ' . $e->getMessage());
        }
    }
/**
     * Гарантия длины по §11.2.1: клиент текст не обрезает, значит предел
     * обеспечивает сервер. Обрезка с многоточием, чтобы не выглядело
     * как оборванное на середине слово.
     *
     * Адрес и причину sp.php ставит в начало текста — при обрезке
     * теряется хвост, а не то, что диспетчер передаёт голосом.
     */
    private function fitText(string $text): string
    {
        $text = trim($text);

        if (mb_strlen($text) <= self::TEXT_MAX) {
            return $text;
        }

        return mb_substr($text, 0, self::TEXT_MAX - 1) . '…';
    }
    /**
     * Уведомления начиная с указанного ID.
     *
     * B3.8: добавлены actor_id (user_id) и created_at.
     * Без actor_id клиент не может отфильтровать собственные действия
     * и показывает пользователю тосты о его же операциях, включая звуковые.
     *
     * Типы приводятся явно: PDO отдаёт строки, а "0" в JavaScript — truthy.
     * Без приведения sound срабатывал бы у всех событий подряд, включая
     * те, где он выключён (закрытие, правка, комментарий).
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
             WHERE id > :since_id
             ORDER BY id ASC
             LIMIT {$safeLimit}",
            ['since_id' => $sinceId]
        );

        $notifications = [];
        foreach ($rows as $row) {
            $notifications[] = [
                'id'         => (int) $row['id'],
                'event_type' => (string) $row['event_type'],
                'ticket_id'  => $row['ticket_id'] !== null ? (int) $row['ticket_id'] : null,
                // NULL системного автора → 0, как в контракте §11.1.
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

    /** Окно свежести — 30 минут. */
    public function cleanup(): void
    {
        $this->db->execute(
            "DELETE FROM lift_notifications WHERE created_at < :thirty_min_ago",
            ['thirty_min_ago' => time() - (30 * 60)]
        );
    }

    /** Внутреннее создание события. */
    private function create(array $data): void
    {
        // Вероятностная чистка: 20% шанс удалить протухшие записи.
        if (random_int(1, 100) <= 20) {
            $this->cleanup();
        }

        $this->db->execute(
            "INSERT INTO lift_notifications
                 (event_type, ticket_id, user_id, text, sound, timeout, created_at)
             VALUES
                 (:event_type, :ticket_id, :user_id, :text, :sound, :timeout, :created_at)",
            [
                'event_type' => $data['event_type'],
                'ticket_id'  => $data['ticket_id'] ?? null,
                'user_id'    => $data['user_id'] ?? null,
                'text'       => $data['text'],
                'sound'      => $data['sound'] ?? 0,
                'timeout'    => $data['timeout'] ?? null,
                'created_at' => time(),
            ]
        );
    }
}