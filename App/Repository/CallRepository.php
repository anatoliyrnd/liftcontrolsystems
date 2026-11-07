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

    /**
     * Получить заявку по ID
     */
    public function findById(int $id): ?array
    {
        return $this->db->fetchOne(
            "SELECT * FROM lift_calls WHERE call_id = :id",
            ['id' => $id]
        );
    }

    /**
     * Получить лифт по ID
     */
    public function findObjectById(int $id): ?array
    {
        return $this->db->fetchOne(
            "SELECT * FROM lift_object WHERE id = :id",
            ['id' => $id]
        );
    }

    /**
     * Разрешить адрес одним JOIN-запросом
     * Возвращает все названия + group_id + vis, или null при невалидном адресе
     */
    public function resolveAddress(int $cityId, int $streetId, int $homeId, int $liftId): ?array
    {
        $sql = "SELECT 
                    c.city_name, 
                    s.street_name, 
                    h.home_name, 
                    o.object_name,
                    o.group_id,
                    o.vis
                FROM lift_city c
                JOIN lift_street s ON s.city_id = c.id
                JOIN lift_home h ON h.street_id = s.id
                JOIN lift_object o ON o.home_id = h.id
                WHERE c.id = :city_id 
                  AND s.id = :street_id 
                  AND h.id = :home_id 
                  AND o.id = :lift_id";

        return $this->db->fetchOne($sql, [
            'city_id' => $cityId,
            'street_id' => $streetId,
            'home_id' => $homeId,
            'lift_id' => $liftId,
        ]);
    }

    /**
     * Создать заявку (через DB::insert — возвращает lastInsertId)
     */
    public function create(array $data): int
    {
        return $this->db->insert('lift_calls', $data);
    }

    /**
     * Список открытых заявок
     */
    public function listOpen(array $user): array
    {
        $readAll = ($user['role'] === 'administrator' || $user['role'] === 'dispatcher');

        $sql = "SELECT c.*,
                       COALESCE((t.type_report = 0), 0) AS is_emergency,
                       u1.user_name AS staff_name,
                       u2.user_name AS staff_name2,
                       u3.user_name AS staff_name3,
                       d.type_name AS department,
                       r.type_name AS request,
                       g.type_name AS group_name
                FROM lift_calls c
                LEFT JOIN lift_users u1 ON c.call_staff = u1.user_id
                LEFT JOIN lift_users u2 ON c.call_staff2 = u2.user_id
                LEFT JOIN lift_users u3 ON c.call_staff3 = u3.user_id
                LEFT JOIN lift_types d ON c.call_department = d.type_id
                LEFT JOIN lift_types r ON c.call_request = r.type_id
                LEFT JOIN lift_types g ON c.call_group = g.type_id
                LEFT JOIN lift_types t ON t.type_id = c.call_department AND t.type = 1
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

    /**
     * Список закрытых заявок за период
     */
    public function listClosed(array $user, string|int|null $period): array
    {
        $dateClose = Period::resolve($period);
        $readAll = ($user['role'] === 'administrator' || $user['role'] === 'dispatcher');

        $sql = "SELECT c.*,
                       COALESCE((t.type_report = 0), 0) AS is_emergency,
                       u1.user_name AS staff_name,
                       u2.user_name AS staff_name2,
                       u3.user_name AS staff_name3,
                       d.type_name AS department,
                       r.type_name AS request,
                       g.type_name AS group_name
                FROM lift_calls c
                LEFT JOIN lift_users u1 ON c.call_staff = u1.user_id
                LEFT JOIN lift_users u2 ON c.call_staff2 = u2.user_id
                LEFT JOIN lift_users u3 ON c.call_staff3 = u3.user_id
                LEFT JOIN lift_types d ON c.call_department = d.type_id
                LEFT JOIN lift_types r ON c.call_request = r.type_id
                LEFT JOIN lift_types g ON c.call_group = g.type_id
                LEFT JOIN lift_types t ON t.type_id = c.call_department AND t.type = 1
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

    /**
     * Обновить поля заявки
     */
    public function updateFields(int $id, array $fields): void
    {
        if (empty($fields)) {
            return;
        }

        $set = [];
        foreach (array_keys($fields) as $key) {
            $set[] = "`$key` = :$key";
        }
        $fields['id'] = $id;

        $this->db->execute(
            "UPDATE lift_calls SET " . implode(', ', $set) . " WHERE call_id = :id",
            $fields
        );
    }

    /**
     * Заметки для массива заявок одним запросом
     */
    private function getNotesForCalls(array $callIds): array
    {
        if (empty($callIds)) {
            return [];
        }

        $inQuery = implode(',', array_fill(0, count($callIds), '?'));

        $sql = "SELECT n.*, u.user_name
                FROM lift_notes n
                LEFT JOIN lift_users u ON n.note_post_user = u.user_id
                WHERE n.note_relation IN ($inQuery)
                ORDER BY n.note_post_date ASC";

        $notes = $this->db->fetchAll($sql, array_values($callIds));

        $grouped = [];
        foreach ($notes as $note) {
            $grouped[$note['note_relation']][] = $note;
        }

        return $grouped;
    }

    /**
     * Форматирование списка заявок для фронтенда
     */
    private function formatList(array $calls, string $type): array
    {
        if (empty($calls)) {
            return [];
        }

        $callIds = array_column($calls, 'call_id');
        $notesGrouped = $this->getNotesForCalls($callIds);

        $result = [];
        foreach ($calls as $c) {
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
                        'type' => (int) $note['note_type'],
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
                'alert_level' => (int) ($c['alert_level'] ?? 1),
                'is_emergency' => (bool) ($c['is_emergency'] ?? false),
                'other' => $num > 0 ? "Есть заметки ($num)" : '—',
                'note_num' => $num,
                'note' => (object) $noteObj,
            ];
        }

        return $result;
    }
    /**
     * Поиск ВСЕХ активных дубликатов заявок на конкретном объекте (лифте) (§5)
     * Возвращает список для формирования модального окна duplicate_detected на клиенте
     * @return array<int, array{call_id: int, call_details: string, call_date: int}>
     */
    public function findActiveDuplicates(int $liftId): array
    {
        $sql = "SELECT call_id, call_details, call_date 
                FROM lift_calls 
                WHERE address_lift = :lift_id 
                  AND call_status = 0 
                ORDER BY call_id DESC";

        return $this->db->fetchAll($sql, [
            'lift_id' => $liftId
        ]);
    }


    /**
     * Поиск существующей заявки по уникальному offline_uuid для предотвращения дублирования
     */
    public function findByOfflineUuid(string $offlineUuid): ?array
    {
        return $this->db->fetchOne(
            "SELECT call_id FROM lift_calls WHERE offline_uuid = :offline_uuid LIMIT 1",
            ['offline_uuid' => $offlineUuid]
        );
    }

    /**
     * Сохранить сериализованный JSON-слепок комментариев в карточку заявки при закрытии (§4.4)
     */
    public function saveNotesHistory(int $callId, string $jsonHistory): void
    {
        $this->db->execute(
            "UPDATE lift_calls SET call_full_note_history = :json_history WHERE call_id = :id",
            ['json_history' => $jsonHistory, 'id' => $callId]
        );
    }
}