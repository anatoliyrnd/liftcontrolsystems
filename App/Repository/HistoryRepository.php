<?php
declare(strict_types=1);

namespace App\Repository;

use App\Database\DB;

final class HistoryRepository
{
    public function __construct(private readonly DB $db)
    {
    }



    public function listByCall(int $callId): array
    {
        return $this->db->fetchAll(
            "SELECT * FROM lift_history WHERE call_id = :id ORDER BY history_date ASC",
            ['id' => $callId]
        );
    }
    /**
     * Запись действия в историю заявки
     */
    public function add(int $callId, string $info, ?int $userId = null): void
    {
        $this->db->execute(
            "INSERT INTO lift_history (history_date, history_info, call_id) VALUES (?, ?, ?)",
            [time(), $info, $callId]
        );
    }
}