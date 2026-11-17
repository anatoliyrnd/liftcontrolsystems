<?php
declare(strict_types=1);

namespace App\Repository;

use App\Database\DB;
use App\Support\Address;
use App\Support\CallPolicy;
use App\Support\CallScope;
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
                    c.city_type,
                    s.street_name,
                    s.street_type, 
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


        $sql = "SELECT c.*,
               COALESCE((d.type_report = 0), 0) AS is_emergency,
               u1.user_name AS staff_name,  u1.user_phone AS staff_phone,
               u2.user_name AS staff_name2, u2.user_phone AS staff_phone2,
               u3.user_name AS staff_name3, u3.user_phone AS staff_phone3,
               d.type_name AS department,
               r.type_name AS request,
                g.type_name AS group_name,
               ac.city_name    AS addr_city_name,
               ast.street_name AS addr_street_name,
               ah.home_name    AS addr_home_name,
               ao.object_name  AS addr_object_name
        FROM lift_calls c
        LEFT JOIN lift_users u1 ON c.call_staff  = u1.user_id
        LEFT JOIN lift_users u2 ON c.call_staff2 = u2.user_id
        LEFT JOIN lift_users u3 ON c.call_staff3 = u3.user_id
        LEFT JOIN lift_types d ON c.call_department = d.type_id AND d.type = 1
        LEFT JOIN lift_types r ON c.call_request    = r.type_id AND r.type = 2
        LEFT JOIN lift_types g ON c.call_group      = g.type_id AND g.type = 3
        LEFT JOIN lift_city   ac  ON c.address_city   = ac.id
        LEFT JOIN lift_street ast ON c.address_street = ast.id
        LEFT JOIN lift_home   ah  ON c.address_home   = ah.id
        LEFT JOIN lift_object ao  ON c.address_lift   = ao.id
        WHERE c.call_status = 0 ";

              $params = [];
        $sql .= $this->ownershipFilter($user, $params);
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


        $sql = "SELECT c.*,
               COALESCE((d.type_report = 0), 0) AS is_emergency,
               u1.user_name AS staff_name,  u1.user_phone AS staff_phone,
               u2.user_name AS staff_name2, u2.user_phone AS staff_phone2,
               u3.user_name AS staff_name3, u3.user_phone AS staff_phone3,
               d.type_name AS department,
               r.type_name AS request,
                 g.type_name AS group_name,
               ac.city_name    AS addr_city_name,
               ast.street_name AS addr_street_name,
               ah.home_name    AS addr_home_name,
               ao.object_name  AS addr_object_name
        FROM lift_calls c
        LEFT JOIN lift_users u1 ON c.call_staff  = u1.user_id
        LEFT JOIN lift_users u2 ON c.call_staff2 = u2.user_id
        LEFT JOIN lift_users u3 ON c.call_staff3 = u3.user_id
        LEFT JOIN lift_types d ON c.call_department = d.type_id AND d.type = 1
        LEFT JOIN lift_types r ON c.call_request    = r.type_id AND r.type = 2
        LEFT JOIN lift_types g ON c.call_group      = g.type_id AND g.type = 3
        LEFT JOIN lift_city   ac  ON c.address_city   = ac.id
        LEFT JOIN lift_street ast ON c.address_street = ast.id
        LEFT JOIN lift_home   ah  ON c.address_home   = ah.id
        LEFT JOIN lift_object ao  ON c.address_lift   = ao.id
        WHERE c.call_status = 1 AND c.call_date2 >= :date_close ";

        $params = ['date_close' => $dateClose];
        $sql .= $this->ownershipFilter($user, $params);
        $sql .= " ORDER BY c.call_date2 DESC";

        $calls = $this->db->fetchAll($sql, $params);
        return $this->formatList($calls, 'close');
    }

       /**
     * SQL-фильтр «только свои заявки» — один на оба списка.
     *
     * Решение принимает CallScope, здесь только перевод в WHERE: раньше
     * одинаковый фильтр был вписан в listOpen и listClosed отдельно, и
     * правка одного списка забывалась во втором.
     *
     * Пустая строка = видит всё. Параметр uid добавляется только когда
     * фильтр нужен: лишний параметр дал бы ошибку привязки в fetchAll.
     *
     * РАСШИРЕНИЕ (группы лифтов): сюда добавится условие по
     * elevator_group_id, когда появится CallScope::allowedGroupIds().
     */
    private function ownershipFilter(array $user, array &$params): string
    {
        if (CallScope::readAll($user)) {
            return '';
        }

        $uid = (int) ($user['id'] ?? 0);

        // Битая сессия без id: «call_staff = 0» совпал бы с каждой
        // неназначенной заявкой. Пустой список честнее и совпадает
        // с CallScope::isAssigned(), который при id 0 тоже отказывает.
        if ($uid <= 0) {
            return ' AND 1 = 0 ';
        }

        $params['uid'] = $uid;

        return ' AND (c.call_staff = :uid OR c.call_staff2 = :uid OR c.call_staff3 = :uid) ';
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
                'address_sort_key' => $this->addressSortKey($c),
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
     * Ключ сортировки адреса. Имена берём из справочника, а не из
     * call_adres: хранимая строка собрана при создании и несёт маркеры
     * «д.»/«ул.», по которым сортировка снова соберёт дома под «д»,
     * а улицы под «у».
     *
     * null, когда JOIN не собрался (скрытый или удалённый родитель).
     * Пустую строку клиент принял бы за валидный ключ и обнулил порядок;
     * отсутствие значения включает фолбэк на видимый текст.
     */
    private function addressSortKey(array $row): ?string
    {
        $city   = $row['addr_city_name'] ?? null;
        $street = $row['addr_street_name'] ?? null;
        $home   = $row['addr_home_name'] ?? null;
        $object = $row['addr_object_name'] ?? null;

        if ($city === null || $street === null || $home === null || $object === null) {
            return null;
        }

        return \App\Support\Address::sortKey(
            (string) $city,
            (string) $street,
            (string) $home,
            (string) $object
        );
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
                             g.type_name AS group_name,
               ac.city_name    AS addr_city_name,
               ast.street_name AS addr_street_name,
               ah.home_name    AS addr_home_name,
               ao.object_name  AS addr_object_name
        FROM lift_calls c
        LEFT JOIN lift_users u1 ON c.call_staff  = u1.user_id
        LEFT JOIN lift_users u2 ON c.call_staff2 = u2.user_id
        LEFT JOIN lift_users u3 ON c.call_staff3 = u3.user_id
        LEFT JOIN lift_types d ON c.call_department = d.type_id AND d.type = 1
        LEFT JOIN lift_types r ON c.call_request    = r.type_id AND r.type = 2
        LEFT JOIN lift_types g ON c.call_group      = g.type_id AND g.type = 3
        LEFT JOIN lift_city   ac  ON c.address_city   = ac.id
        LEFT JOIN lift_street ast ON c.address_street = ast.id
        LEFT JOIN lift_home   ah  ON c.address_home   = ah.id
        LEFT JOIN lift_object ao  ON c.address_lift   = ao.id
        WHERE c.call_id = :id";

        $call = $this->db->fetchOne($sql, ['id' => $callId]);
        if (!$call) {
            return null;
        }

              // Видимость карточки = видимость в списке. Своя проверка здесь
        // уже расходилась с фильтром списка: механик открывал по ссылке
        // заявку, которой не было в его списке.
        // Отказ — null (§12.2), не 403: существование заявки не раскрываем.
        if (!CallScope::canView($user, $call)) {
            return null;
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

           // Права считает CallPolicy — тот же предикат, что отвечает на само
        // действие. Иначе кнопка есть, а сервер даёт 403: can_edit пускал
        // назначенного инженера, can_comment — вообще любого, включая гостя.
        //
        // Область чтения здесь НЕ участвует: флаг user_read_all_calls даёт
        // просмотр, а не право записи. Закрытая заявка финальна — can_* ложны.
        //
        // WARNING (согласовано, тест): назначенность engineer не проверяется,
        // поэтому механик с флагом чтения закрывает и комментирует чужие
        // заявки. Закрывается точкой C в CallPolicy — $call уже передаётся.
        // См. API_syncCommands §15.
        $isOpen = (int)$call['call_status'] === 0;
        $canEdit = $isOpen && CallPolicy::canEdit($user, $call);
        $canClose = $isOpen && CallPolicy::canClose($user, $call);
        $canComment = $isOpen && CallPolicy::canComment($user, $call);
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
            'address_sort_key' => $this->addressSortKey($call),
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
    // =======================================================================
    // Привязка объектов к СПульт (миграция 1.2)
    // =======================================================================

    /**
     * Каноническая форма GUID: 32 hex в верхнем регистре, без дефисов.
     *
     * Владелец формата — репозиторий: колонка char(32) ascii_bin,
     * сравнение побайтовое, поэтому 'faaf…' и 'FAAF…' — разные значения.
     * Нормализация обязательна до любого поиска и записи.
     *
     * @return string|null null = GUID отсутствует или невалиден
     */
    public static function normalizeGuid(?string $raw): ?string
    {
        $s = strtoupper(trim((string) $raw));
        $s = str_replace(['-', ' ', "\t", "\r", "\n"], '', $s);

        if ($s === '' || preg_match('/^[A-F0-9]{32}$/', $s) !== 1) {
            return null;
        }

        return $s;
    }

    /**
     * LIFT@ID — внешний идентификатор, не наше число.
     * Колонка varchar(32): числовой тип давал отказ приёма сигнала
     * на нечисловом или слишком большом значении.
     */
    public static function normalizeSpultId(?string $raw): ?string
    {
        $s = trim((string) $raw);
        if ($s === '') {
            return null;
        }

        return mb_substr($s, 0, 32);
    }

    /**
     * Объект по GUID — одним JOIN до города.
     *
     * Первичный путь приёма сигнала: адрес из XML не резолвим вообще,
     * все четыре id и название берём из БД. Переименование улицы или
     * лифта в пульте больше не отправляет сигнал в карантин.
     *
     * JOIN намеренно INNER: при битой иерархии (осиротевший home)
     * собрать адрес и city_id невозможно — возвращаем null, вызывающая
     * сторона уходит в адресный путь и далее в карантин.
     *
      * full_address собирается тем же Address::format, что и
 * CallService::validateAddress. Две копии формата расходились
 * и давали ложный guid_mismatch на каждом корректном сигнале.
 *
 * Сырые имена компонентов отдаются наружу: сравнение по ключам
 * возможно только по исходным именам, разбирать собранную строку
 * обратно нельзя.
 *
 * @return array{object_id:int,home_id:int,street_id:int,city_id:int,
 *               group_id:int,vis:bool,guid:string|null,spult_id:string|null,
 *               city_name:string,street_name:string,home_name:string,
 *               object_name:string,full_address:string}|null
     */
    public function findObjectByGuid(string $guid): ?array
    {
        $normalized = self::normalizeGuid($guid);
        if ($normalized === null) {
            return null;
        }

        $row = $this->db->fetchOne(
            "SELECT o.id AS object_id, o.object_name, o.home_id, o.group_id, o.vis,
                    o.guid, o.spult_id,
                    h.home_name, h.street_id,
                    s.street_name, s.city_id,
                    c.city_name
             FROM lift_object o
             JOIN lift_home   h ON h.id = o.home_id
             JOIN lift_street s ON s.id = h.street_id
             JOIN lift_city   c ON c.id = s.city_id
             WHERE o.guid = :guid
             LIMIT 1",
            ['guid' => $normalized]
        );

        if (!$row) {
            return null;
        }

        return [
            'object_id'    => (int) $row['object_id'],
            'home_id'      => (int) $row['home_id'],
            'street_id'    => (int) $row['street_id'],
            'city_id'      => (int) $row['city_id'],
            'group_id'     => (int) $row['group_id'],
            'vis'          => (bool) $row['vis'],
            'guid'         => $row['guid'] !== null ? (string) $row['guid'] : null,
            'spult_id'     => $row['spult_id'] !== null ? (string) $row['spult_id'] : null,
                       // Сырые имена — для сравнения по ключам. Собранную строку
            // разбирать обратно нельзя: форматирование пульта и
            // справочника различается, разбор дал бы ложные расхождения.
            'city_name'    => (string) $row['city_name'],
            'street_name'  => (string) $row['street_name'],
            'home_name'    => (string) $row['home_name'],
            'object_name'  => (string) $row['object_name'],

            // Прежний sprintf приклеивал «д.» безусловно: на строке
            // справочника «д. 20/1» получалось «д.д. 20/1».
            'full_address' => Address::format(
                (string) $row['city_name'],
                (string) $row['street_name'],
                (string) $row['home_name'],
                (string) $row['object_name']
            ),
        ];
    }

    /**
     * Привязать GUID к объекту. Только если поле пустое.
     *
     * Чужая привязка не перезаписывается никогда: молчаливая подмена
     * отправила бы заявки на другой лифт, и заметить это было бы нечем.
     *
     * UPDATE условный (AND guid IS NULL) — два параллельных сигнала
     * не перетирают друг друга. DB::execute не отдаёт число затронутых
     * строк, поэтому факт проверяем повторным чтением.
     *
     * UNIQUE(uq_object_guid) может сработать, если GUID успел привязаться
     * к другому объекту — это не ошибка, а гонка: возвращаем статус
     * и id владельца, вызывающая сторона создаст заявку на него.
     *
     * @return array{status:string,existing_guid:string|null,holder_object_id?:int|null}
     *   status: bound | already_bound | conflict | guid_taken | lost_race
     *           | invalid_guid | object_not_found
     */
    public function bindSpultGuid(int $objectId, string $guid, ?string $spultId = null): array
    {
        $normalized = self::normalizeGuid($guid);
        if ($normalized === null) {
            return ['status' => 'invalid_guid', 'existing_guid' => null];
        }

        $current = $this->db->fetchOne(
            "SELECT guid, spult_id FROM lift_object WHERE id = :id",
            ['id' => $objectId]
        );

        if (!$current) {
            return ['status' => 'object_not_found', 'existing_guid' => null];
        }

        $existing = $current['guid'] !== null ? (string) $current['guid'] : null;

        // Тот же GUID — идемпотентный повтор, только дозаполняем spult_id.
        if ($existing === $normalized) {
            $this->fillSpultId($objectId, $spultId);
            return ['status' => 'already_bound', 'existing_guid' => $existing];
        }

        // Другой GUID — конфликт, привязку не трогаем.
        if ($existing !== null && $existing !== '') {
            return ['status' => 'conflict', 'existing_guid' => $existing];
        }

        try {
            $this->db->execute(
                "UPDATE lift_object SET guid = :guid WHERE id = :id AND guid IS NULL",
                ['guid' => $normalized, 'id' => $objectId]
            );
        } catch (\Throwable $e) {
            if (!$this->isDuplicateKey($e)) {
                throw $e;   // не конфликт уникальности — наверх, это реальный сбой
            }

            $holder = $this->findObjectByGuid($normalized);

            return [
                'status'           => 'guid_taken',
                'existing_guid'    => $normalized,
                'holder_object_id' => $holder['object_id'] ?? null,
            ];
        }

        $after   = $this->db->fetchOne(
            "SELECT guid FROM lift_object WHERE id = :id",
            ['id' => $objectId]
        );
        $nowGuid = ($after && $after['guid'] !== null) ? (string) $after['guid'] : null;

        if ($nowGuid !== $normalized) {
            // Условие не выполнилось: между чтением и записью поле заняли.
            return ['status' => 'lost_race', 'existing_guid' => $nowGuid];
        }

        $this->fillSpultId($objectId, $spultId);

        return ['status' => 'bound', 'existing_guid' => $normalized];
    }

    /**
     * Дозаполнить spult_id, если он пуст. Существующее значение не меняем.
     *
     * @return bool true = поле теперь равно переданному значению
     */
    public function fillSpultId(int $objectId, ?string $spultId): bool
    {
        $normalized = self::normalizeSpultId($spultId);
        if ($normalized === null) {
            return false;
        }

        $this->db->execute(
            "UPDATE lift_object SET spult_id = :sid
             WHERE id = :id AND (spult_id IS NULL OR spult_id = '')",
            ['sid' => $normalized, 'id' => $objectId]
        );

        $row = $this->db->fetchOne(
            "SELECT spult_id FROM lift_object WHERE id = :id",
            ['id' => $objectId]
        );

        return $row && (string) $row['spult_id'] === $normalized;
    }

    /**
     * Отличить конфликт уникального индекса от настоящего сбоя БД.
     * Обёртка DB может отдавать PDOException или свой класс — смотрим текст.
     */
    private function isDuplicateKey(\Throwable $e): bool
    {
        $msg = $e->getMessage();

        return str_contains($msg, 'Duplicate entry')
            || str_contains($msg, '1062')
            || str_contains($msg, '23000');
    }
}