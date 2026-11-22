<?php
declare(strict_types=1);

namespace App\Repository;

use App\Database\DB;
use App\Support\ReportsQueryBuilder;

/**
 * Чтение отчётов. Только SELECT: отчёты не меняют данные, поэтому
 * транзакции и идемпотентность здесь не нужны.
 *
 * Все JOIN — LEFT и БЕЗ vis: внешних ключей в БД нет, осиротевшие
 * ссылки штатны, а скрытый позже адрес обязан остаться в истории.
 * NULL-корзины группировок подписываются явно («Без отдела»): молча
 * потерять заявки диспетчер принял бы за пропажу.
 */
final class ReportsRepository
{
    /**
     * Порог «медленного» закрытия застревания, минуты.
     * Бизнес-число живёт здесь и уезжает клиенту в ответе: дублировать
     * его в js/config.js значит получить два источника, которые
     * разъедутся при первой же правке.
     */
    private const int SLOW_CLOSE_MINUTES = 50;

    /** Сколько строк уезжает в подсказку. Остальное — расширенный поиск. */
    private const int TIP_ROWS = 50;

    /**
     * Группы «застревание». Явные ID приоритетнее поиска по имени:
     * у тенантов свои type_id, хардкод одного номера сломал бы отчёт
     * на соседней организации. Пустой список → работаем по имени.
     */
    private const array ENTRAPMENT_GROUP_IDS = [];
    private const string ENTRAPMENT_NAME_LIKE = '%астреван%';

    public function __construct(private DB $db)
    {
    }

    /** @return array<int,array{type_id:int|string,type_name:string}> */
    private function entrapmentGroups(): array
    {
        $cond = [];
        $p = [];
        $ids = self::ENTRAPMENT_GROUP_IDS;
        if ($ids !== []) {
            $ph = [];
            foreach (array_values($ids) as $i => $id) {
                $ph[] = ":eg$i";
                $p["eg$i"] = (int) $id;
            }
            $cond[] = 'type_id IN (' . implode(', ', $ph) . ')';
        }
        if (self::ENTRAPMENT_NAME_LIKE !== '') {
            $cond[] = 'type_name LIKE :eg_like';
            $p['eg_like'] = self::ENTRAPMENT_NAME_LIKE;
        }
        if ($cond === []) {
            return [];
        }
        return $this->db->fetchAll(
            'SELECT type_id, type_name FROM lift_types
             WHERE type = 3 AND (' . implode(' OR ', $cond) . ')
             ORDER BY type_name',
            $p
        );
    }

    public function getFiltersData(): array
    {
        $departments = $this->db->fetchAll(
            'SELECT type_id, type_name FROM lift_types WHERE type = 1 ORDER BY type_name'
        );
        // user_hiden nullable: условие без IS NULL обнулило бы список.
        $staff = $this->db->fetchAll(
            'SELECT user_id, user_name, user_position FROM lift_users
             WHERE user_block <> 1 AND (user_hiden IS NULL OR user_hiden = 0)
             ORDER BY user_name, user_id'
        );
        $cities = $this->db->fetchAll(
            'SELECT id, city_name FROM lift_city WHERE vis = 1 ORDER BY city_name'
        );

        return [
            'departments' => array_map(
                static fn (array $r): array => ['id' => (string) $r['type_id'], 'name' => (string) $r['type_name']],
                $departments
            ),
            'staff' => array_map(
                static fn (array $r): array => [
                    'id' => (int) $r['user_id'],
                    'name' => (string) $r['user_name'],
                    'position' => ($r['user_position'] ?? '') !== '' ? (string) $r['user_position'] : null,
                ],
                $staff
            ),
            'cities' => array_map(
                static fn (array $r): array => ['id' => (int) $r['id'], 'name' => (string) $r['city_name']],
                $cities
            ),
        ];
    }

    public function getStats(array $f, array $user): array
    {
        $qb = new ReportsQueryBuilder($f, $user);
        [$where, $p] = $qb->buildWhere();

        $main = $this->db->fetchOne(
            "SELECT COUNT(*) AS total,
                    COALESCE(SUM(c.call_status = 0), 0) AS open_cnt,
                    COALESCE(SUM(c.call_status = 1), 0) AS close_cnt,
                    AVG(CASE WHEN c.call_status = 1 THEN c.call_date2 - c.call_date END) AS avg_close
             FROM lift_calls c WHERE $where",
            $p
        ) ?? [];

        $rep = $this->db->fetchOne(
            "SELECT COALESCE(SUM(c.repair_time_is_default = 1), 0) AS d_cnt,
                    COALESCE(SUM(c.repair_time_is_default = 0), 0) AS c_cnt,
                    AVG(CASE WHEN c.repair_time_is_default = 1 AND c.call_status = 1
                             THEN c.expected_repair_time - c.call_date END) AS d_avg,
                    AVG(CASE WHEN c.repair_time_is_default = 0 AND c.call_status = 1
                             THEN c.expected_repair_time - c.call_date END) AS c_avg
             FROM lift_calls c WHERE $where",
            $p
        ) ?? [];

        return [
            'total' => (int) ($main['total'] ?? 0),
            'open' => (int) ($main['open_cnt'] ?? 0),
            'closed' => (int) ($main['close_cnt'] ?? 0),
            'avg_close_time_seconds' => $main['avg_close'] !== null
                ? (int) round((float) $main['avg_close'])
                : null,
            'by_department' => $this->grouped(
                'LEFT JOIN lift_types d ON d.type_id = c.call_department AND d.type = 1',
                'd.type_id', 'd.type_name', $where, $p, 'Без отдела'
            ),
            'by_city' => $this->grouped(
                'LEFT JOIN lift_city ci ON ci.id = c.address_city',
                'ci.id', 'ci.city_name', $where, $p, 'Без адреса'
            ),
            'by_group' => $this->grouped(
                'LEFT JOIN lift_types g ON g.type_id = c.call_group AND g.type = 3',
                'g.type_id', 'g.type_name', $where, $p, 'Без группы'
            ),
            'by_request' => $this->grouped(
                'LEFT JOIN lift_types r ON r.type_id = c.call_request AND r.type = 2',
                'r.type_id', 'r.type_name', $where, $p, 'Без типа запроса'
            ),
            'by_alert_level' => array_map(
                static fn (array $r): array => ['level' => (int) $r['level'], 'count' => (int) $r['cnt']],
                $this->db->fetchAll(
                    "SELECT c.alert_level AS level, COUNT(*) AS cnt
                     FROM lift_calls c WHERE $where
                     GROUP BY c.alert_level ORDER BY c.alert_level ASC",
                    $p
                )
            ),
            'avg_repair_time' => [
                'default' => (int) ($rep['d_cnt'] ?? 0),
                'custom' => (int) ($rep['c_cnt'] ?? 0),
                'avg_default_seconds' => $rep['d_avg'] !== null ? (int) round((float) $rep['d_avg']) : null,
                'avg_custom_seconds' => $rep['c_avg'] !== null ? (int) round((float) $rep['c_avg']) : null,
            ],
        ];
    }

    /**
     * Сводка. Два независимых набора условий:
     *   срез   — открытые/просроченные на сейчас, без периода;
     *   период — закрытые/созданные за понедельник→сегодня и т.п.
     *
     * Просрочка = определение body-render, чтобы цифра и красная ячейка
     * в журнале не разошлись: открыта И срок > 0 И срок < now.
     * now приходит параметром из PHP time(): @@session.time_zone = SYSTEM
     * (§1.2) в сравнение не вмешивается.
     *
     * Три отдельных запроса вместо одного с CASE: в нативном prepare
     * нельзя повторить :p_from трижды (HY093), а плодить p_from1/2/3
     * нечитаемо. Сводка не hot path — шесть запросов дешевле путаницы.
     */
    public function getSummary(array $f, array $user, int $from, int $to, int $now): array
    {
        $qb = new ReportsQueryBuilder($f, $user);
        [$snapWhere, $snapP] = $qb->buildSnapshotWhere();
        $openWhere = "$snapWhere AND c.call_status = 0";

        // Просрочка считается один раз во вложенном SELECT: в нативном
        // prepare нельзя повторить :now шесть раз (HY093). Наружу
        // приходят готовые корзины — клиент их не пересчитывает.
        //
        // Диапазоны НЕпересекающиеся и в сумме дают overdue_now.
        // Накопительные («< 5 часов» вместе с «< часа») посчитали бы
        // одну заявку дважды, и сумма не сошлась бы с плиткой.
        // NULL od (срок не задан) во все SUM не попадает.
        $openP = $snapP;
        $openP['now'] = $now;
        $open = $this->db->fetchOne(
            "SELECT COUNT(*) AS open_now,
                    COALESCE(SUM(od > 0), 0) AS overdue_now,
                    COALESCE(SUM(od > 0 AND od < 3600), 0) AS b_hour,
                    COALESCE(SUM(od >= 3600 AND od < 18000), 0) AS b_5h,
                    COALESCE(SUM(od >= 18000 AND od < 86400), 0) AS b_day,
                    COALESCE(SUM(od >= 86400 AND od < 604800), 0) AS b_week,
                    COALESCE(SUM(od >= 604800), 0) AS b_old
             FROM (
                 SELECT CASE WHEN c.expected_repair_time > 0
                             THEN :now - c.expected_repair_time
                             ELSE NULL END AS od
                 FROM lift_calls c
                 WHERE $openWhere
             ) t",
            $openP
        ) ?? [];

        $closedP = $snapP;
        $closedP['c_from'] = $from;
        $closedP['c_to'] = $to;
        $closed = $this->db->fetchOne(
            "SELECT COUNT(*) AS cnt, AVG(c.call_date2 - c.call_date) AS avg_close
             FROM lift_calls c
             WHERE $snapWhere AND c.call_status = 1
               AND c.call_date2 >= :c_from AND c.call_date2 <= :c_to",
            $closedP
        ) ?? [];

        $createdP = $snapP;
        $createdP['n_from'] = $from;
        $createdP['n_to'] = $to;
        $created = (int) $this->db->fetchColumn(
            "SELECT COUNT(*) FROM lift_calls c
             WHERE $snapWhere AND c.call_date >= :n_from AND c.call_date <= :n_to",
            $createdP
        );

        // Медленные застревания — ПЕРИОДНАЯ метрика (закрытые за период),
        // в отличие от просрочки, которая является срезом «на сейчас».
        // Группы резолвятся один раз; если ни одной не нашлось, отдаём
        // честный ноль с пустым group_names, а не считаем всё подряд.
        $groups = $this->entrapmentGroups();
        $slow = [
            'threshold_minutes' => self::SLOW_CLOSE_MINUTES,
            'count' => 0,
            'group_names' => array_map(
                static fn (array $g): string => (string) $g['type_name'],
                $groups
            ),
            'items' => [],
            'truncated' => false,
        ];
        if ($groups !== []) {
            $gph = [];
            $gp = [];
            foreach ($groups as $i => $g) {
                $gph[] = ":sg$i";
                $gp["sg$i"] = (int) $g['type_id'];
            }
            $slowWhere = "$snapWhere AND c.call_status = 1"
                . ' AND c.call_date2 >= :s_from AND c.call_date2 <= :s_to'
                . ' AND c.call_group IN (' . implode(', ', $gph) . ')'
                . ' AND (c.call_date2 - c.call_date) > :s_sec';
            $slowP = $snapP + $gp + [
                    's_from' => $from,
                    's_to' => $to,
                    's_sec' => self::SLOW_CLOSE_MINUTES * 60,
                ];

            $slow['count'] = (int) $this->db->fetchColumn(
                "SELECT COUNT(*) FROM lift_calls c WHERE $slowWhere",
                $slowP
            );

            // +1 строка — признак обрезки. Молча резать нельзя: пользователь
            // должен знать, что в подсказке не всё.
            $rows = $this->db->fetchAll(
                "SELECT c.call_id, c.call_adres, c.call_date, c.call_date2
                 FROM lift_calls c WHERE $slowWhere
                 ORDER BY (c.call_date2 - c.call_date) DESC, c.call_id DESC
                 LIMIT " . (self::TIP_ROWS + 1),
                $slowP
            );
            $slow['truncated'] = count($rows) > self::TIP_ROWS;
            $slow['items'] = array_map(
                static fn (array $r): array => [
                    'id' => (int) $r['call_id'],
                    'address' => (string) $r['call_adres'],
                    'date' => (int) $r['call_date'],
                    'close_date' => (int) $r['call_date2'],
                    'minutes' => (int) round(((int) $r['call_date2'] - (int) $r['call_date']) / 60),
                ],
                array_slice($rows, 0, self::TIP_ROWS)
            );
        }

        return [
            'open_now' => (int) ($open['open_now'] ?? 0),
            'overdue_now' => (int) ($open['overdue_now'] ?? 0),
            'overdue_buckets' => [
                'lt_hour' => (int) ($open['b_hour'] ?? 0),
                'lt_5hours' => (int) ($open['b_5h'] ?? 0),
                'lt_day' => (int) ($open['b_day'] ?? 0),
                'lt_week' => (int) ($open['b_week'] ?? 0),
                'gte_week' => (int) ($open['b_old'] ?? 0),
            ],
            'slow_entrapment' => $slow,
            'closed_period' => (int) ($closed['cnt'] ?? 0),
            'created_period' => $created,
            'avg_close_time_seconds' => ($closed['avg_close'] ?? null) !== null
                ? (int) round((float) $closed['avg_close'])
                : null,
            // Разбивки — по ОТКРЫТЫМ на сейчас, не по периоду. Имена
            // open_by_* намеренно не совпадают с by_* из getStats:
            // там период, здесь срез, путать нельзя.
            'open_by_department' => $this->grouped(
                'LEFT JOIN lift_types d ON d.type_id = c.call_department AND d.type = 1',
                'd.type_id', 'd.type_name', $openWhere, $snapP, 'Без отдела'
            ),
            'open_by_city' => $this->grouped(
                'LEFT JOIN lift_city ci ON ci.id = c.address_city',
                'ci.id', 'ci.city_name', $openWhere, $snapP, 'Без адреса'
            ),
            'open_by_alert_level' => array_map(
                static fn (array $r): array => ['level' => (int) $r['level'], 'count' => (int) $r['cnt']],
                $this->db->fetchAll(
                    "SELECT c.alert_level AS level, COUNT(*) AS cnt
                     FROM lift_calls c WHERE $openWhere
                     GROUP BY c.alert_level ORDER BY c.alert_level ASC",
                    $snapP
                )
            ),
        ];
    }

    public function countTotal(array $f, array $user): int
    {
        $qb = new ReportsQueryBuilder($f, $user);
        [$where, $p] = $qb->buildWhere();
        return (int) $this->db->fetchColumn("SELECT COUNT(*) FROM lift_calls c WHERE $where", $p);
    }

    public function getList(array $f, array $user, int $limit, int $offset, string $sort): array
    {
        $rows = $this->selectRows($f, $user, $sort, $limit, $offset);
        return array_map([$this, 'mapItem'], $rows);
    }

    /** Сырые строки для CSV: LIMIT 2001 режет вызывающий сервис. */
    public function getExportRows(array $f, array $user, string $sort, int $limit): array
    {
        return $this->selectRows($f, $user, $sort, $limit, 0);
    }

    /**
     * Строки экспорта в контракте items — для печати (format:"json").
     *
     * why не getExportRows: он отдаёт сырьё с именами колонок БД,
     * а печатный форматтер и responsibleCell() ждут контракт items.
     * selectRows() тот же, что у getList(): WHERE не меняется,
     * инвариант «экспорт = список» цел — отличие только в mapItem.
     */
    public function getExportRowsMapped(array $f, array $user, string $sort, int $limit): array
    {
        return array_map([$this, 'mapItem'], $this->selectRows($f, $user, $sort, $limit, 0));
    }

    private function selectRows(array $f, array $user, string $sort, int $limit, int $offset): array
    {
        $qb = new ReportsQueryBuilder($f, $user);
        [$where, $p] = $qb->buildWhere();
        $dateType = (string) ($f['date_type'] ?? 'created');

        $keySel = $sort === 'address'
            ? ', ' . ReportsQueryBuilder::ADDRESS_KEY_EXPR . ' AS address_sort_key'
            : '';
        $joins = $sort === 'address' ? ReportsQueryBuilder::ADDRESS_JOINS : '';

        // LIMIT/OFFSET — числами после (int): нативный prepare не примет строку.
        $sql = "SELECT c.call_id, c.call_status, c.call_adres, c.call_details, c.call_solution,
                       c.call_last_name, c.call_last_name_close, c.call_first_name,
                       c.call_date, c.call_date2, c.expected_repair_time, c.alert_level,
                       c.call_department, c.call_group, c.call_request,
                       c.call_staff, c.call_staff2, c.call_staff3,
                       c.call_staff_status, c.call_staff_status2, c.call_staff_status3,
                       c.call_staff_date, c.call_staff_date2, c.call_staff_date3,
                       d.type_name AS department,
                       g.type_name AS group_name,
                       r.type_name AS request_name,
                       u1.user_name AS staff_name,
                       u2.user_name AS staff_name2,
                       u3.user_name AS staff_name3$keySel
                FROM lift_calls c
                LEFT JOIN lift_types d  ON d.type_id = c.call_department
                LEFT JOIN lift_types g  ON g.type_id = c.call_group AND g.type = 3
                LEFT JOIN lift_types r  ON r.type_id = c.call_request AND r.type = 2
                LEFT JOIN lift_users u1 ON u1.user_id = c.call_staff
                LEFT JOIN lift_users u2 ON u2.user_id = c.call_staff2
                LEFT JOIN lift_users u3 ON u3.user_id = c.call_staff3
                $joins
                WHERE $where
                " . $qb->sortClause($sort, $dateType) . "
                LIMIT $limit OFFSET $offset";

        return $this->db->fetchAll($sql, $p);
    }

    private function grouped(
        string $join,
        string $idExpr,
        string $nameExpr,
        string $where,
        array $p,
        string $nullLabel
    ): array {
        $rows = $this->db->fetchAll(
            "SELECT $idExpr AS id, $nameExpr AS name, COUNT(*) AS cnt
             FROM lift_calls c $join
             WHERE $where
             GROUP BY id, name
             ORDER BY cnt DESC, name ASC",
            $p
        );
        return array_map(
            static fn (array $r): array => [
                'id' => $r['id'] !== null ? (string) $r['id'] : null,
                'name' => ($r['name'] ?? '') !== '' ? (string) $r['name'] : $nullLabel,
                'count' => (int) $r['cnt'],
            ],
            $rows
        );
    }

    private function mapItem(array $r): array
    {
        $closed = (int) $r['call_status'] === 1;
        $closeName = (string) ($r['call_last_name'] ?? '');
        if ($closeName === '') {
            $closeName = (string) ($r['call_last_name_close'] ?? '');
        }

        return [
            'id' => (int) $r['call_id'],
            'call_id' => (int) $r['call_id'],
            'call_number' => (string) $r['call_id'],
            'type' => $closed ? 'close' : 'open',
            'fullAddress' => (string) $r['call_adres'],
            'details' => (string) $r['call_details'],
            'date' => (int) $r['call_date'],
            'repair_time' => (int) $r['expected_repair_time'] > 0 ? (int) $r['expected_repair_time'] : null,
            'close_date' => $closed && (int) $r['call_date2'] > 0 ? (int) $r['call_date2'] : null,
            'close_name' => $closed ? ($closeName !== '' ? $closeName : '—') : '—',
            'solution' => $closed ? ((string) $r['call_solution'] !== '' ? (string) $r['call_solution'] : '—') : '—',
            'department' => $r['department'] !== null ? (string) $r['department'] : null,
            'department_id' => (string) $r['call_department'],
            // Кто открыл — для ячейки «Открыта». Колонка уже выбиралась
            // ради CSV, но в items не отдавалась.
            'created_by' => (string) ($r['call_first_name'] ?? ''),
            // Группа и тип запроса — для ячейки «Отдел / Группа / Тип».
            // type-гuard в JOIN обязателен: id из другого справочника
            // иначе подставил бы чужое название.
            'group' => ($r['group_name'] ?? null) !== null ? (string) $r['group_name'] : null,
            'group_id' => (string) ($r['call_group'] ?? ''),
            'request' => ($r['request_name'] ?? null) !== null ? (string) $r['request_name'] : null,
            'request_id' => (string) ($r['call_request'] ?? ''),
            'alert_level' => (int) $r['alert_level'],
            'staff_id' => (int) $r['call_staff'] > 0 ? (int) $r['call_staff'] : null,
            'staff_name' => $r['staff_name'] !== null ? (string) $r['staff_name'] : null,
            'notify_status' => $r['call_staff_status'] !== null ? (int) $r['call_staff_status'] : null,
            'notify_date' => $r['call_staff_date'] !== null ? (int) $r['call_staff_date'] : null,
            'staff_id2' => (int) ($r['call_staff2'] ?? 0) > 0 ? (int) $r['call_staff2'] : null,
            'staff_name2' => $r['staff_name2'] !== null ? (string) $r['staff_name2'] : null,
            'notify_status2' => $r['call_staff_status2'] !== null ? (int) $r['call_staff_status2'] : null,
            'notify_date2' => $r['call_staff_date2'] !== null ? (int) $r['call_staff_date2'] : null,
            'staff_id3' => (int) ($r['call_staff3'] ?? 0) > 0 ? (int) $r['call_staff3'] : null,
            'staff_name3' => $r['staff_name3'] !== null ? (string) $r['staff_name3'] : null,
            'notify_status3' => $r['call_staff_status3'] !== null ? (int) $r['call_staff_status3'] : null,
            'notify_date3' => $r['call_staff_date3'] !== null ? (int) $r['call_staff_date3'] : null,
        ];
    }
}