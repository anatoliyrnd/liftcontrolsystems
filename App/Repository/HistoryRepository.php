<?php
declare(strict_types=1);

namespace App\Repository;

use App\Database\DB;

final class HistoryRepository
{
    public function __construct(private readonly DB $db)
    {
    }

    public function add(int $callId, string $info): void
    {
        $this->db->insert('lift_history', [
            'call_id' => $callId,
            'history_date' => time(),
            'history_info' => $info
        ]);
    }

    public function listByCall(int $callId): array
    {
        return $this->db->fetchAll(
            "SELECT * FROM lift_history WHERE call_id = :id ORDER BY history_date ASC",
            ['id' => $callId]
        );
    }
}