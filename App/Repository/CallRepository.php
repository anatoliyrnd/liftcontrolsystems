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
               COALESCE((d.type_report = 0), 0) AS is_emergency,
               u1.user_name AS staff_name,  u1.user_phone AS staff_phone,
               u2.user_name AS staff_name2, u2.user_phone AS staff_phone2,
               u3.user_name AS staff_name3, u3.user_phone AS staff_phone3,
               d.type_name AS department,
               r.type_name AS request,
               g.type_name AS group_name
        FROM lift_calls c
        LEFT JOIN lift_users u1 ON c.call_staff  = u1.user_id
        LEFT JOIN lift_users u2 ON c.call_staff2 = u2.user_id
        LEFT JOIN lift_users u3 ON c.call_staff3 = u3.user_id
        LEFT JOIN lift_types d ON c.call_department = d.type_id AND d.type = 1
        LEFT JOIN lift_types r ON c.call_request    = r.type_id AND r.type = 2
        LEFT JOIN lift_types g ON c.call_group      = g.type_id AND g.type = 3
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
               COALESCE((d.type_report = 0), 0) AS is_emergency,
               u1.user_name AS staff_name,  u1.user_phone AS staff_phone,
               u2.user_name AS staff_name2, u2.user_phone AS staff_phone2,
               u3.user_name AS staff_name3, u3.user_phone AS staff_phone3,
               d.type_name AS department,
               r.type_name AS request,
               g.type_name AS group_name
        FROM lift_calls c
        LEFT JOIN lift_users u1 ON c.call_staff  = u1.user_id
        LEFT JOIN lift_users u2 ON c.call_staff2 = u2.user_id
        LEFT JOIN lift_users u3 ON c.call_staff3 = u3.user_id
        LEFT JOIN lift_types d ON c.call_department = d.type_id AND d.type = 1
        LEFT JOIN lift_types r ON c.call_request    = r.type_id AND r.type = 2
        LEFT JOIN lift_types g ON c.call_group      = g.type_id AND g.type = 3
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
        if (empty($calls)) return [];

        // Для закрытых заметки уже сериализованы в слепок и удалены из lift_notes.
        // Запрос к lift_notes нужен только для открытых.
        $notesGrouped = $type === 'open'
            ? $this->getNotesForCalls(array_column($calls, 'call_id'))
            : [];

        $result = [];
        foreach ($calls as $c) {
            $noteArray = [];

            if ($type === 'open') {
                foreach ($notesGrouped[$c['call_id']] ?? [] as $note) {
                    $noteArray[] = [
                        'id'         => (int) $note['note_id'],
                        'user'       => $note['user_name'] ?? 'Система',
                        'body'       => $note['note_body'],
                        'date'       => (int) $note['note_post_date'],
                        'type'       => (int) $note['note_type'],
                        'is_offline' => (int) ($note['is_offline'] ?? 0),
                    ];
                }
                $num = count($noteArray);
            } else {
                // Тело заметок в списке не отдаём — только счётчик из слепка.
                $decoded = json_decode($c['call_full_note_history'] ?? '{}', true);
                $num = is_array($decoded) ? count($decoded) : 0;
            }

            $result[] = [
                'id' => (int) $c['call_id'],
                'call_id'     => (int) $c['call_id'],          // ← B1.1
                'call_number' => (string) $c['call_id'],       // ← B1.1
                'type' => $type,
                'fullAddress' => $c['call_adres'],
                'city_id' => (int) $c['address_city'],
                'street_id' => (int) $c['address_street'],
                'home_id' => (int) $c['address_home'],
                'object_id' => (int) $c['address_lift'],
                'details' => $c['call_details'],
                'staff_id'   => $c['call_staff'] ? (int) $c['call_staff'] : null,
                'staff_name' => $c['staff_name'] ?? null,
                'staff_phone'    => $c['staff_phone'] ?? null,

                'staff_id2'      => $c['call_staff2'] ? (int) $c['call_staff2'] : null,
                'staff_name2'    => $c['staff_name2'] ?? null,
                'staff_phone2'   => $c['staff_phone2'] ?? null,
                'notify_status2' => $c['call_staff_status2'] !== null ? (int) $c['call_staff_status2'] : null,
                'notify_date2'   => $c['call_staff_date2'] ? (int) $c['call_staff_date2'] : null,
                'staff_id3'      => $c['call_staff3'] ? (int) $c['call_staff3'] : null,
                'staff_name3'    => $c['staff_name3'] ?? null,
                'staff_phone3'   => $c['staff_phone3'] ?? null,
                'notify_status3' => $c['call_staff_status3'] !== null ? (int) $c['call_staff_status3'] : null,
                'notify_date3'   => $c['call_staff_date3'] ? (int) $c['call_staff_date3'] : null,
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
                'note' => $noteArray,
            ];
        }

        return $result;
    }
    /**
     * Поиск ВСЕХ активных дубликатов на объекте с учётом отдела (§5).
     *
     * БИЗНЕС-ПРАВИЛО (согласовано): дубликатом считается активная заявка
     * на том же объекте (address_lift) И в том же отделе (call_department).
     * Группа (call_group) в фильтр НЕ входит осознанно: группы могут
     * переназначаться диспетчером, а отдел определяет зону обслуживания.
     *
     * Метод вызывается из CallService::callnew ровно ОДИН раз до создания
     * заявки и используется в двух сценариях:
     *   a) force_create = false и список непустой → бросаем duplicate_detected,
     *      клиент показывает модалку с этим списком;
     *   b) force_create = true → исключение не бросаем, но список запоминаем
     *      для аудита (номера заявок попадут в историю после создания).
     *
     * ВАЖНО: выборка строго ДО INSERT. После создания новая заявка сама
     * становится активной (call_status = 0) и попала бы в собственный
     * список дубликатов, сделав аудит-пометку бессмысленной.
     *
     * Индекс idx_calls_active_object (address_lift, call_status) продолжает
     * работать: отдел досеивается после индексного поиска.
     *
     * @return array<int, array{call_id: int, call_details: string, call_date: int}>
     */
    public function findActiveDuplicates(int $liftId, int $departmentId): array
    {
        $sql = "SELECT call_id, call_details, call_date
                FROM lift_calls
                WHERE address_lift = :lift_id
                  AND call_department = :department_id
                  AND call_status = 0
                ORDER BY call_id DESC";

        return $this->db->fetchAll($sql, [
            'lift_id'       => $liftId,
            'department_id' => $departmentId,
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
    /**
     * Получить заявку по ID с полной историей и правами доступа (§12.2)
     */
    public function findByIdDetailed(int $callId, array $user): ?array
    {
        // Прямой запрос по ID без ограничений по дате
        $sql = "SELECT c.*,
               COALESCE((d.type_report = 0), 0) AS is_emergency,
               u1.user_name AS staff_name,  u1.user_phone AS staff_phone,
               u2.user_name AS staff_name2, u2.user_phone AS staff_phone2,
               u3.user_name AS staff_name3, u3.user_phone AS staff_phone3,
               d.type_name AS department,
               r.type_name AS request,
               g.type_name AS group_name
        FROM lift_calls c
        LEFT JOIN lift_users u1 ON c.call_staff  = u1.user_id
        LEFT JOIN lift_users u2 ON c.call_staff2 = u2.user_id
        LEFT JOIN lift_users u3 ON c.call_staff3 = u3.user_id
        LEFT JOIN lift_types d ON c.call_department = d.type_id AND d.type = 1
        LEFT JOIN lift_types r ON c.call_request    = r.type_id AND r.type = 2
        LEFT JOIN lift_types g ON c.call_group      = g.type_id AND g.type = 3
        WHERE c.call_id = :id";

        $call = $this->db->fetchOne($sql, ['id' => $callId]);
        if (!$call) {
            return null;
        }

        // Проверка прав доступа
        $readAll = ($user['role'] === 'administrator' || $user['role'] === 'dispatcher');
        if (!$readAll) {
            $assigned = [(int)$call['call_staff'], (int)$call['call_staff2'], (int)$call['call_staff3']];
            if (!in_array((int)$user['id'], $assigned)) {
                return null; // Нет прав
            }
        }

        // Загрузка заметок
        $notes = [];
        if ((int)$call['call_status'] === 0) {
            // Открытая — читаем из lift_notes
            $notes = $this->getNotesForCalls([$callId])[$callId] ?? [];
        } else {
            // Закрытая — читаем из call_full_note_history
            $jsonNotes = $call['call_full_note_history'] ?? '{}';
            $decoded = json_decode($jsonNotes, true);
            if (is_array($decoded)) {
                $notes = array_values($decoded); // Преобразуем в массив
            }
        }

        // Загрузка текстовой истории
        $historyRows = $this->db->fetchAll(
            "SELECT history_info, history_date, source FROM lift_history WHERE call_id = :id ORDER BY history_date ASC",
            ['id' => $callId]
        );
        $fullHistoryLines = [];
        foreach ($historyRows as $row) {
            $date = date('d.m.Y H:i', (int)$row['history_date']);
            $source = $row['source'] === 'offline_sync' ? '[Офлайн] ' : '';
            $fullHistoryLines[] = "[{$date}] {$source}{$row['history_info']}";
        }

        // Формирование заметок в единый контракт для открытых и закрытых.
        // 🌟 is_offline (пункт 4): фронтенд рисует маркер ⏳ у комментариев,
        // пришедших из офлайн-синхронизации.
        // Для открытых заявок поле приходит из lift_notes (выборка n.*),
        // для закрытых — из слепка call_full_note_history (ключ уже в JSON).
        // ?? 0 страхует старые слепки, где ключа ещё нет.
        $noteArray = [];
        foreach ($notes as $note) {
            $noteArray[] = [
                'id'         => (int)$note['note_id'],
                'user'       => $note['user_name'] ?? 'Система',
                'body'       => $note['note_body'],
                'date'       => (int)$note['note_post_date'],
                'type'       => (int)$note['note_type'],
                'is_offline' => (int)($note['is_offline'] ?? 0),
            ];
        }

        // Вычисление прав
        $isOpen = (int)$call['call_status'] === 0;
        $isAssigned = in_array((int)$user['id'], [(int)$call['call_staff'], (int)$call['call_staff2'], (int)$call['call_staff3']]);
        $canEdit = $isOpen && ($readAll || $isAssigned);
        $canClose = $isOpen && ($user['role'] === 'administrator' || $user['role'] === 'dispatcher' || $user['role'] === 'engineer' || $isAssigned);
        $canComment = $isOpen;

        return [
            'id'          => (int) $call['call_id'],   // ← B1.1
            'call_id' => (int)$call['call_id'],
            'call_number' => (string)$call['call_id'],
            'type' => $isOpen ? 'open' : 'close',
            'fullAddress' => $call['call_adres'],
            'city_id' => (int)$call['address_city'],
            'street_id' => (int)$call['address_street'],
            'home_id' => (int)$call['address_home'],
            'object_id' => (int)$call['address_lift'],
            'details' => $call['call_details'],
            'date' => (int)$call['call_date'],
            'repair_time' => (int)$call['expected_repair_time'],
            'department' => $call['department'],
            'department_id' => (string)$call['call_department'],
            'group' => $call['group_name'],
            'group_id' => (string)$call['call_group'],
            'elevator_group_id' => null,
            'elevator_group_name' => null,
            'request' => $call['request'],
            'request_id' => (string)$call['call_request'],
            'alert_level' => (int)($call['alert_level'] ?? 1),
            'is_emergency' => (bool)($call['is_emergency'] ?? false),
            'other' => count($noteArray) > 0 ? 'Есть заметки (' . count($noteArray) . ')' : '—',
            'note_num' => count($noteArray),
            'staff_id' => $call['call_staff'] ? (int)$call['call_staff'] : null,
            'staff_name' => $call['staff_name'],
            'staff_phone' => $call['staff_phone'] ?? null,
            'notify_status' => $call['call_staff_status'] !== null ? (int)$call['call_staff_status'] : null,
            'notify_date' => $call['call_staff_date'] ? (int)$call['call_staff_date'] : null,
            'staff_id2' => $call['call_staff2'] ? (int)$call['call_staff2'] : null,
            'staff_name2' => $call['staff_name2'],
            'staff_phone2' => $call['staff_phone2'] ?? null,
            'notify_status2' => $call['call_staff_status2'] !== null ? (int)$call['call_staff_status2'] : null,
            'notify_date2' => $call['call_staff_date2'] ? (int)$call['call_staff_date2'] : null,
            'staff_id3' => $call['call_staff3'] ? (int)$call['call_staff3'] : null,
            'staff_name3' => $call['staff_name3'],
            'staff_phone3' => $call['staff_phone3'] ?? null,
            'notify_status3' => $call['call_staff_status3'] !== null ? (int)$call['call_staff_status3'] : null,
            'notify_date3' => $call['call_staff_date3'] ? (int)$call['call_staff_date3'] : null,
            'solution' => !$isOpen ? $call['call_solution'] : '—',
            'close_name' => !$isOpen ? $call['call_last_name'] : '—',
            'close_date' => !$isOpen ? (int)$call['call_date2'] : null,
            'full_history' => implode("\n", $fullHistoryLines),
            'note' => $noteArray, // Массив, не объект
            'can_edit' => $canEdit,
            'can_close' => $canClose,
            'can_comment' => $canComment,
            'closureallowed' => 0,
        ];
    }
    public function findTypeCategory(int $typeId): ?array
    {
        return $this->db->fetchOne(
            "SELECT type FROM lift_types WHERE type_id = :id",
            ['id' => $typeId]
        );
    }

}