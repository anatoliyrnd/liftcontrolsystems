<?php
declare(strict_types=1);

namespace App\Repository;

use App\Database\DB;
use App\Support\Period;

final class CallRepository
{
    public function __construct(private readonly DB $db)
    {
    }

    public function findById(int $id): ?array
    {
        return $this->db->fetchOne("SELECT * FROM lift_calls WHERE call_id = :id", ['id' => $id]);
    }

    public function listOpen(array $user): array
    {
        $readAll = ($user['role'] === 'administrator' || $user['role'] === 'dispatcher');

        $sql = "SELECT c.*, 
                    u1.user_name as staff_name, u2.user_name as staff_name2, u3.user_name as staff_name3,
                    d.type_name as department, r.type_name as request, g.type_name as group_name
                FROM lift_calls c
                LEFT JOIN lift_users u1 ON c.call_staff = u1.user_id
                LEFT JOIN lift_users u2 ON c.call_staff2 = u2.user_id
                LEFT JOIN lift_users u3 ON c.call_staff3 = u3.user_id
                LEFT JOIN lift_types d ON c.call_department = d.type_id
                LEFT JOIN lift_types r ON c.call_request = r.type_id
                LEFT JOIN lift_types g ON c.call_group = g.type_id
                WHERE c.call_status = 0 ";

        $params = [];
        if (!$readAll) {
            $sql .= " AND (c.call_staff = :uid OR c.call_staff2 = :uid OR c.call_staff3 = :uid) ";
            $params['uid'] = $user['id'];
        }

        $sql .= " ORDER BY c.call_id DESC";
        $calls = $this->db->fetchAll($sql, $params);

        return $this->formatList($calls, 'open');
    }

    public function listClosed(array $user, string|int|null $period): array
    {
        $dateClose = Period::resolve($period);
        $readAll = ($user['role'] === 'administrator' || $user['role'] === 'dispatcher');

        $sql = "SELECT c.*, 
                    u1.user_name as staff_name, u2.user_name as staff_name2, u3.user_name as staff_name3,
                    d.type_name as department, r.type_name as request, g.type_name as group_name
                FROM lift_calls c
                LEFT JOIN lift_users u1 ON c.call_staff = u1.user_id
                LEFT JOIN lift_users u2 ON c.call_staff2 = u2.user_id
                LEFT JOIN lift_users u3 ON c.call_staff3 = u3.user_id
                LEFT JOIN lift_types d ON c.call_department = d.type_id
                LEFT JOIN lift_types r ON c.call_request = r.type_id
                LEFT JOIN lift_types g ON c.call_group = g.type_id
                WHERE c.call_status = 1 AND c.call_date2 >= :date_close ";

        $params = ['date_close' => $dateClose];
        if (!$readAll) {
            $sql .= " AND (c.call_staff = :uid OR c.call_staff2 = :uid OR c.call_staff3 = :uid) ";
            $params['uid'] = $user['id'];
        }

        $sql .= " ORDER BY c.call_date2 DESC";
        $calls = $this->db->fetchAll($sql, $params);

        return $this->formatList($calls, 'close');
    }

    public function updateFields(int $id, array $fields): void
    {
        if (empty($fields))
            return;

        $set = [];
        foreach (array_keys($fields) as $key) {
            $set[] = "`$key` = :$key";
        }

        $fields['id'] = $id;
        $this->db->execute("UPDATE lift_calls SET " . implode(', ', $set) . " WHERE call_id = :id", $fields);
    }

    /**
     * Достает все заметки для переданного массива ID заявок одним запросом.
     */
    private function getNotesForCalls(array $callIds): array
    {
        if (empty($callIds))
            return [];

        // Создаем плейсхолдеры вида ?,?,? для IN
        $inQuery = implode(',', array_fill(0, count($callIds), '?'));

        $sql = "SELECT n.*, u.user_name 
                FROM lift_notes n 
                LEFT JOIN lift_users u ON n.note_post_user = u.user_id 
                WHERE n.note_relation IN ($inQuery) 
                ORDER BY n.note_post_date ASC";

        $notes = $this->db->fetchAll($sql, array_values($callIds));

        // Группируем заметки по ID заявки
        $grouped = [];
        foreach ($notes as $note) {
            $grouped[$note['note_relation']][] = $note;
        }
        return $grouped;
    }

    private function formatList(array $calls, string $type): array
    {
        if (empty($calls))
            return [];

        // Получаем заметки для всех заявок сразу
        $callIds = array_column($calls, 'call_id');
        $notesGrouped = $this->getNotesForCalls($callIds);

        $result = [];
        foreach ($calls as $c) {
            // Формируем объект заметок для текущей заявки
            $noteObj = [];
            $num = 0;
            if (isset($notesGrouped[$c['call_id']])) {
                foreach ($notesGrouped[$c['call_id']] as $note) {
                    $num++;
                    $noteObj[$num] = [
                        'id' => (int) $note['note_id'],
                        'user' => $note['user_name'] ?? 'Система',
                        'body' => $note['note_body'],
                        'date' => (int) $note['note_post_date'],
                        'type' => (int) $note['note_type']
                    ];
                }
            }

            $result[] = [
                'id' => (int) $c['call_id'],
                'type' => $type,
                'fullAddress' => $c['call_adres'],
                'city_id' => (int) $c['address_city'],
                'street_id' => (int) $c['address_street'],
                'home_id' => (int) $c['address_home'],
                'object_id' => (int) $c['address_lift'],
                'details' => $c['call_details'],
                'staff_id' => $c['call_staff'] ? (int) $c['call_staff'] : null,
                'staff_name' => $c['staff_name'],
                'notify_status' => $c['call_staff_status'] !== null ? (int) $c['call_staff_status'] : null,
                'notify_date' => $c['call_staff_date'] ? (int) $c['call_staff_date'] : null,
                'department' => $c['department'],
                'department_id' => (string) $c['call_department'],
                'group' => $c['group_name'],
                'group_id' => (string) $c['call_group'],
                'request' => $c['request'],
                'request_id' => (string) $c['call_request'],
                'date' => (int) $c['call_date'],
                'repair_time' => (int) $c['expected_repair_time'],
                'solution' => $type === 'close' ? $c['call_solution'] : '—',
                'close_name' => $type === 'close' ? $c['call_last_name'] : '—',
                'close_date' => $type === 'close' ? (int) $c['call_date2'] : null,
                'alert_level' => 1,
                'other' => $num > 0 ? "Есть заметки ($num)" : '—',
                'note_num' => $num,
                'note' => (object) $noteObj, // (object) гарантирует, что пустой массив станет {}, а не []
            ];
        }
        return $result;
    }
}