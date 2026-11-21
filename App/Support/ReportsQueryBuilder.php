<?php
declare(strict_types=1);

namespace App\Support;

/**
 * Единый WHERE для reports_stats / reports_list / reports_export.
 *
 * Три экшена обязаны работать на идентичной выборке — иначе сводка
 * и таблица разъезжаются, и пользователь не понимает, чему верить.
 *
 * Плейсхолдеры УНИКАЛЬНЫ: PDO::ATTR_EMULATE_PREPARES = false, а в
 * нативном режиме повтор одного именованного маркера — HY093.
 * Фильтр по ответственному и область чтения занимают по три слота,
 * поэтому имена нумерованные (:staff1..3, :scope1..3, :dep0..n).
 *
 * LIMIT/OFFSET сюда не входят: в нативном режиме строковая привязка
 * LIMIT ломается, числа подставляет репозиторий после (int).
 *
 * Класс чистый: строка + params, без БД. Область чтения спрашивает
 * CallScope::readAll — инвариант «видимость в списке = видимость
 * карточки» сохраняется и для отчётов.
 */
final class ReportsQueryBuilder
{
    /** JOIN'ы адресной цепочки — только для сортировки по адресу. */
    public const ADDRESS_JOINS =
        ' LEFT JOIN lift_city ci ON ci.id = c.address_city' .
        ' LEFT JOIN lift_street st ON st.id = c.address_street' .
        ' LEFT JOIN lift_home h ON h.id = c.address_home' .
        ' LEFT JOIN lift_object o ON o.id = c.address_lift';

    /**
     * Имя дома без ведущего маркера.
     *
     * Address::sortKey снимает «д.» через parseHome, а lift_home.home_name
     * содержит его в строках, созданных приёмом СПульт: там home_name
     * пишется сырым значением из XML («д. 154-А»). Без снятия ключ
     * сервера начинался бы с «д.», клиентский — с цифры, и порядок
     * расходился бы на всём массиве легаси-адресов.
     *
     * Класс символов [.] вместо \. — чтобы не удваивать экранирование
     * на трёх уровнях (PHP → SQL-литерал → regex). Регистр не важен:
     * collation utf8mb3_general_ci, «Д.» совпадёт тоже.
     *
        * Пустой результат (поле было одним маркером) → NULLIF → NULL,
     * CONCAT_WS его пропустит. Терять нечего: имени там не было.
     *
     * ГРАНИЦА ОБЯЗАТЕЛЬНА: ([[:space:]]+|(?=[0-9])) — пробел или
     * цифра после маркера, ровно как (?:\s+|(?=\d)) в parseHome.
     * Прежняя [[:space:]]* со звёздочкой допускала пустое совпадение
     * и отрывала «дом» от «домовой» → «овой». Голая «д» добавлена
     * ради «д5»: без неё маркер без точки перед цифрой не снимался,
     * и ключ расходился с PHP. Убирать границу нельзя — тесты
     * «домовой» и «д5» в приёмке держат именно её.
     *
     * Lookahead (?=[0-9]) поддерживается PCRE2 MariaDB 10.11.
     * Обратных слэшей нет ни в одном классе — трёхуровневое
     * экранирование PHP → SQL-литерал → regex по-прежнему не нужно.
     */
    private const HOME_PLAIN_EXPR =
        "NULLIF(TRIM(REGEXP_REPLACE(h.home_name, '^(дом[.]?|д[.]|д|№|#)([[:space:]]+|(?=[0-9]))', '')), '')";

    /**
     * Ключ сортировки — чистые имена, паритет Address::sortKey.
     *
     * Collation всех четырёх колонок проверен: utf8mb3_general_ci.
     * CONCAT_WS не даст «Illegal mix of collations». Если колонку
     * когда-нибудь конвертируют отдельно — выражение упадёт с 1267,
     * и это будет видно сразу, а не тихой порчей порядка.
     *
     * Остаточное расхождение с Address::sortKey осознанное: SQL не
     * схлопывает кратные пробелы и не разбирает тип улицы внутри
     * имени. Проверено, что lift_street.street_name чистый, тип живёт
     * в street_type — разбирать нечего. Если легаси-строка принесёт
     * «ул. Ленина» в самом имени, она отсортируется под «у».
     */
    public const ADDRESS_KEY_EXPR =
        "LOWER(CONCAT_WS(' ', NULLIF(ci.city_name,''), NULLIF(st.street_name,'')," .
        ' ' . self::HOME_PLAIN_EXPR . ',' .
        " NULLIF(o.object_name,'')))";

    private array $f;
    private array $user;

    public function __construct(array $filters, array $user)
    {
        $this->f = $filters;
        $this->user = $user;
    }

    /** @return array{0:string,1:array<string,mixed>} */
    public function buildWhere(): array
    {
        $w = [];
        $p = [];

        $closed = ($this->f['date_type'] ?? 'created') === 'closed';
        $dateCol = $closed ? 'c.call_date2' : 'c.call_date';

        // date_to используется как есть: клиент уже построил границу
        // суток МСК (23:59:59). Прибавка 86399 сдвинула бы период на
        // день вперёд и захватила чужие заявки.
        $w[] = "$dateCol >= :date_from";
        $p['date_from'] = (int) ($this->f['date_from'] ?? 0);
        $w[] = "$dateCol <= :date_to";
        $p['date_to'] = (int) ($this->f['date_to'] ?? 0);

        if ($closed) {
            $w[] = 'c.call_status = 1';
        }

        $status = (string) ($this->f['status'] ?? 'all');
        if ($status === 'open') {
            $w[] = 'c.call_status = 0';
        } elseif ($status === 'close') {
            $w[] = 'c.call_status = 1';
        }

        // Отделы: включающий фильтр. Пусто → условия НЕТ вовсе:
        // новые отделы подтягиваются сами, а «все галочки» ≠ «без фильтра».
        // Разница видна на осиротевших ссылках: с фильтром они исключены,
        // без него — попадают. Осознанно (§15.1).
        $deps = $this->normalizeIds($this->f['department_ids'] ?? []);

        if ($deps !== []) {
            $ph = [];
            foreach ($deps as $i => $id) {
                $ph[] = ":dep$i";
                $p["dep$i"] = $id;
            }
            $w[] = 'c.call_department IN (' . implode(', ', $ph) . ')';
        }

        // Мультивыбор городов (сводка). Приоритетнее одиночной цепочки:
        // сводка не выбирает улицу/дом. Пусто → условия нет = «Все»,
        // ровно как в журнале заявок.
         // Инициализация ДО ветвления: $cityOnly/$homeId/$objectId читаются
        // ниже при расчёте $textable. Внутри else они оставались
        // неопределёнными при мультивыборе городов, а set_error_handler
        // превращает warning в ErrorException → internal_error на первом
        // же city_ids в period-фильтрах.
        $cityOnly = (bool) ($this->f['city_only'] ?? false);
        $objectId = (int) ($this->f['object_id'] ?? 0);
        $homeId   = (int) ($this->f['home_id'] ?? 0);
        $streetId = (int) ($this->f['street_id'] ?? 0);
        $cityId   = (int) ($this->f['city_id'] ?? 0);

        // Мультивыбор городов приоритетнее одиночной цепочки.
        // Пусто → условия нет = «Все», как в журнале.
        $cityIds = $this->normalizeIds($this->f['city_ids'] ?? []);
        if ($cityIds !== []) {
            $ph = [];
            foreach ($cityIds as $i => $id) {
                $ph[] = ":city$i";
                $p["city$i"] = $id;
            }
            $w[] = 'c.address_city IN (' . implode(', ', $ph) . ')';
        } elseif ($cityOnly) {
            if ($cityId > 0) {
                $w[] = 'c.address_city = :city_id';
                $p['city_id'] = $cityId;
            }
        } elseif ($objectId > 0) {
            $w[] = 'c.address_lift = :object_id';
            $p['object_id'] = $objectId;
        } elseif ($homeId > 0) {
            $w[] = 'c.address_home = :home_id';
            $p['home_id'] = $homeId;
        } elseif ($streetId > 0) {
            $w[] = 'c.address_street = :street_id';
            $p['street_id'] = $streetId;
        } elseif ($cityId > 0) {
            $w[] = 'c.address_city = :city_id';
            $p['city_id'] = $cityId;
        }

        $staffId = (int) ($this->f['staff_id'] ?? 0);
        if ($staffId > 0) {
            $w[] = '(c.call_staff = :staff1 OR c.call_staff2 = :staff2 OR c.call_staff3 = :staff3)';
            $p['staff1'] = $p['staff2'] = $p['staff3'] = $staffId;
        }

        // Область чтения. Инженеру staff_id не игнорируем молча:
        // условие пересекается с его областью через AND, а не
        // расширяет её — иначе фильтр стал бы обходом прав.
        [$scopeSql, $scopeParams] = $this->scopeCondition();
        if ($scopeSql !== null) {
            $w[] = $scopeSql;
            $p += $scopeParams;
        }
        // Полнотекст: только при доме/объекте и длине >= 6, иначе молча
        // игнорируется. Без адреса LIKE '%…%' — полный скан по периоду,
        // индекса с ведущим wildcard не бывает.
        //
        // LIKE-символы экранируем через '!': «100%» иначе стал бы
        // шаблоном и вернул всё. Порядок замен важен — сначала '!',
        // иначе экранирующий символ удвоился бы повторно.
        // city_ids перекрывает одиночную цепочку: home_id/object_id
        // в этом случае не фильтруют ничего. Разблокировать ими
        // полнотекст значило бы разрешить поиск по условию, которого
        // в WHERE нет — та же природа, что рассинхрон контракта и кода.
        $textable = !$cityOnly && $cityIds === [] && ($homeId > 0 || $objectId > 0);
        if ($textable) {
            foreach (['details_text' => 'c.call_details', 'solution_text' => 'c.call_solution'] as $key => $column) {
                $text = trim((string) ($this->f[$key] ?? ''));
                if (mb_strlen($text, 'UTF-8') >= 6) {
                    $w[] = "$column LIKE :like_$key ESCAPE '!'";
                    $p["like_$key"] = '%' . str_replace(['!', '%', '_'], ['!!', '!%', '!_'], $text) . '%';
                }
            }
        }

        return [implode(' AND ', $w), $p];
    }
    /**
     * WHERE среза «на сейчас» — для сводки.
     *
     * Только область чтения и города. Период, статус, отделы и полнотекст
     * НЕ применяются: «сколько открыто» не зависит от выбранного периода.
     * С общим WHERE диспетчер увидел бы открытые, созданные сегодня,
     * вместо всех открытых — это другая цифра и другой смысл.
     *
     * @return array{0:string,1:array<string,mixed>}
     */
    public function buildSnapshotWhere(): array
    {
        $w = [];
        $p = [];

        [$scopeSql, $scopeParams] = $this->scopeCondition();
        if ($scopeSql !== null) {
            $w[] = $scopeSql;
            $p += $scopeParams;
        }

        $cityIds = $this->normalizeIds($this->f['city_ids'] ?? []);
        if ($cityIds !== []) {
            $ph = [];
            foreach ($cityIds as $i => $id) {
                $ph[] = ":city$i";
                $p["city$i"] = $id;
            }
            $w[] = 'c.address_city IN (' . implode(', ', $ph) . ')';
        }

        // Пустой WHERE недопустим в SQL: readAll + все города = без условий.
        return [$w === [] ? '1' : implode(' AND ', $w), $p];
    }

    /**
     * Область чтения. Один источник для обоих WHERE — инвариант
     * «видимость в списке = видимость карточки» не должен зависеть
     * от того, какой экран спросил.
     *
     * @return array{0:?string,1:array<string,mixed>}
     */
    private function scopeCondition(): array
    {
        if (CallScope::readAll($this->user)) {
            return [null, []];
        }
        $uid = (int) ($this->user['id'] ?? 0);
        // call_staff — NOT NULL DEFAULT 0. Без guard нулевой uid
        // (битая сессия, легаси-запись) совпал бы с каждой неназначенной
        // заявкой и выдал весь тенант. Тот же инвариант закрыт в
        // CallScope::isAssigned и CallRepository::ownershipFilter —
        // отчёты не должны быть единственным местом, где его нет.
        if ($uid <= 0) {
            return ['1 = 0', []];
        }
        return [
            '(c.call_staff = :scope1 OR c.call_staff2 = :scope2 OR c.call_staff3 = :scope3)',
            ['scope1' => $uid, 'scope2' => $uid, 'scope3' => $uid],
        ];
    }

    /** int[] из чего угодно: мусор → 0 → отброшен, инъекции нет. */
    private function normalizeIds(mixed $raw): array
    {
        return array_values(array_unique(array_filter(
            array_map('intval', (array) $raw),
            static fn (int $i): bool => $i > 0
        )));
    }

    /**
     * Детерминирующий хвост call_id DESC — всегда.
     *
     * Без него пагинация даёт дубли и пропуски: при одинаковых датах
     * или отделах порядок строк между запросами не гарантирован.
     *
     * address_sort_key — алиас из SELECT, который репозиторий
     * добавляет только при sort='address'. Ссылаться на него в других
     * ветках нельзя: Unknown column.
     */
    public function sortClause(string $sort, string $dateType): string
    {
        if ($sort === 'address') {
            return "ORDER BY (address_sort_key = '') ASC, address_sort_key ASC, c.call_id DESC";
        }

        if ($sort === 'department') {
            return 'ORDER BY c.call_department ASC, c.call_id DESC';
        }

        $col = $dateType === 'closed' ? 'c.call_date2' : 'c.call_date';
        return "ORDER BY $col DESC, c.call_id DESC";
    }
}