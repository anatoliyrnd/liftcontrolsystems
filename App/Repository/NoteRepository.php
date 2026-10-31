<?php
declare(strict_types=1);

namespace App\Repository;

use App\Database\DB;

final class NoteRepository
{
    public function __construct(private readonly DB $db)
    {
    }

    public function add(int $callId, int $userId, string $text): int
    {
        return $this->db->insert('lift_notes', [
            'note_title' => 'Заметка',
            'note_body' => $text,
            'note_relation' => $callId,
            'note_type' => 1,
            'note_post_date' => time(),
            'note_post_ip' => $_SERVER['REMOTE_ADDR'] ?? '',
            'note_post_user' => $userId
        ]);
    }

    public function listByCall(int $callId): array
    {
        return $this->db->fetchAll(
            "SELECT n.*, u.user_name 
             FROM lift_notes n 
             LEFT JOIN lift_users u ON n.note_post_user = u.user_id 
             WHERE n.note_relation = :id ORDER BY n.note_post_date ASC",
            ['id' => $callId]
        );
    }
}