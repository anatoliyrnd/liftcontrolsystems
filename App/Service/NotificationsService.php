<?php
declare(strict_types=1);

namespace App\Service;

use App\Database\DB;

/**
 * Сервис для управления очередью уведомлений
 * Уведомления сохраняются в БД и отдаются через эндпоинт notifications
 * Фронтенд поллит их каждые 120 секунд через NotificationsPoller
 */
final class NotificationsService
{
    public function __construct(private readonly DB $db)
    {
    }

    /**
     * Создать уведомление о создании заявки
     */
    public function ticketCreated(int $ticketId, string $address, string $creatorName, int $userId): void
    {
        $this->create([
            'event_type' => 'ticket_created',
            'ticket_id' => $ticketId,
            'user_id' => $userId,
            'text' => "Новая заявка №{$ticketId}: {$address} (создал: {$creatorName})",
            'sound' => 1,
            'timeout' => 8000,
        ]);
    }

    /**
     * Создать уведомление о закрытии заявки
     */
    public function ticketClosed(int $ticketId, string $solution, string $closerName, int $userId): void
    {
        $this->create([
            'event_type' => 'ticket_closed',
            'ticket_id' => $ticketId,
            'user_id' => $userId,
            'text' => "Заявка №{$ticketId} закрыта: {$solution} ({$closerName})",
            'sound' => 0,
            'timeout' => 6000,
        ]);
    }

    /**
     * Создать уведомление о редактировании заявки
     */
    public function ticketEdited(int $ticketId, string $editorName, int $userId): void
    {
        $this->create([
            'event_type' => 'ticket_edited',
            'ticket_id' => $ticketId,
            'user_id' => $userId,
            'text' => "Заявка №{$ticketId} отредактирована ({$editorName})",
            'sound' => 0,
            'timeout' => 5000,
        ]);
    }

    /**
     * Создать уведомление о добавлении комментария
     */
    public function ticketNote(int $ticketId, string $authorName, int $userId): void
    {
        $this->create([
            'event_type' => 'ticket_note',
            'ticket_id' => $ticketId,
            'user_id' => $userId,
            'text' => "Новый комментарий к заявке №{$ticketId} от {$authorName}",
            'sound' => 0,
            'timeout' => 5000,
        ]);
    }

    /**
     * Получить уведомления начинаяя с определённого ID
     * @param int $sinceId ID последнего полученного уведомления
     * @param int $limit Максимум уведомлений за раз
     * @return array{notifications: array, last_id: int}
     */
    public function getSince(int $sinceId, int $limit = 50): array
    {
        // $limit уже int — безопасно вставлять в SQL
        $safeLimit = max(1, min($limit, 100)); // защита: от 1 до 100

        $sql = "SELECT id, event_type, ticket_id, text, sound, timeout
            FROM lift_notifications
            WHERE id > :since_id
            ORDER BY id ASC
            LIMIT {$safeLimit}";

        $notifications = $this->db->fetchAll($sql, [
            'since_id' => $sinceId,
            // 'limit' убран — теперь в SQL
        ]);

        $lastId = $sinceId;
        if (!empty($notifications)) {
            $lastId = (int) end($notifications)['id'];
        }

        return [
            'notifications' => $notifications,
            'last_id' => $lastId,
        ];
    }

    /**
     * Очистить старые уведомления (старше 7 дней)
     */
    public function cleanup(): void
    {
        $weekAgo = time() - (7 * 24 * 3600);
        $this->db->execute(
            "DELETE FROM lift_notifications WHERE created_at < :week_ago",
            ['week_ago' => $weekAgo]
        );
    }

    /**
     * Внутренний метод создания уведомления
     */
    private function create(array $data): void
    {
        $sql = "INSERT INTO lift_notifications 
                (event_type, ticket_id, user_id, text, sound, timeout, created_at)
                VALUES 
                (:event_type, :ticket_id, :user_id, :text, :sound, :timeout, :created_at)";

        $this->db->execute($sql, [
            'event_type' => $data['event_type'],
            'ticket_id' => $data['ticket_id'] ?? null,
            'user_id' => $data['user_id'] ?? null,
            'text' => $data['text'],
            'sound' => $data['sound'] ?? 0,
            'timeout' => $data['timeout'] ?? null,
            'created_at' => time(),
        ]);
    }
}