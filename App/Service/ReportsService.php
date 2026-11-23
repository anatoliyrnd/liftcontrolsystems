<?php
declare(strict_types=1);
namespace App\Service;

use App\Exceptions\ApiException;
use App\Http\ErrorCode;
use App\Repository\ReportsRepository;
use App\Support\ExportRateLimiter;
use App\Support\ReportsAccess;
use App\Tenant;

/**
 * Оркестрация отчётов: права → нормализация фильтров → валидация дат →
 * репозиторий. SQL здесь не живёт — он в ReportsQueryBuilder/Repository.
 *
 * Права проверяются НА СЕРВЕРЕ с первого дня: это осознанный отход от
 * долга §20 для нового модуля. Иначе инженер или гость получили бы
 * выгрузку всего тенанта через DevTools.
 *
 * §16: порядок проверок фиксирован и дешёвые раньше дорогих:
 * роль → булева способность → группы фильтров/адрес-скоуп → даты →
 * строки → лимитер экспорта. Отказ по уровню не сжигает окно лимитера
 * и не зависит от мусорных дат.
 *
 * Невалидные даты → data:null, не исключение: пользователь видит
 * пустой результат, а не ошибку там, где виновата форма.
 * Исключение — только период выше потолка уровня и лимиты строк.
 */
final class ReportsService
{
    public function __construct(
        private ReportsRepository $repo,
        private ?Tenant $tenant
    ) {
    }

    private function gate(array $user): void
    {
        // Allow-list, не denylist: неизвестная непустая роль (auditor,
        // легаси-значение, битая сессия) проходила бы denylist и попадала
        // в scope-фильтр. Эффект и так fail-safe, но гейт обязан быть
        // явным — иначе каждая новая роль молча получает доступ к отчётам.
        $role = (string) ($user['role'] ?? '');
        if (!in_array($role, ['administrator', 'dispatcher', 'engineer'], true)) {
            throw new ApiException(
                ErrorCode::Forbidden,
                'Отчёты недоступны для этой роли',
                reason: 'no_rights'
            );
        }
    }

    /** §16: уровень тенанта. Нормализация fail-closed внутри ReportsAccess. */
    private function level(): string
    {
        return ReportsAccess::normalizeLevel($this->tenant?->reportsLevel);
    }

    private function limits(): array
    {
        return ReportsAccess::limits($this->level());
    }

    /**
     * §16: гейт булевой способности (сводка, форматы экспорта).
     * reason верхнего уровня, details плоско (§10.1, прецедент retry_after):
     * клиент читает resp.feature и рисует замок/тизер по нему.
     */
    private function gateFeature(string $feature): void
    {
        if (!ReportsAccess::featureAvailable($feature, $this->level())) {
            throw new ApiException(
                ErrorCode::Forbidden,
                'Функция недоступна на текущем уровне доступа к отчётам',
                reason: 'feature_not_available',
                details: ['feature' => $feature]
            );
        }
    }

    /**
     * §16: группы фильтров и адрес-скоуп уровня.
     *
     * Отказ ТОЛЬКО явный: дефолты (status=all, staff_id=0, пустые тексты,
     * city_only=false, пустые списки) проходят молча — клиент light их
     * просто не рендерит. Молчаливое игнорирование запрещено: оно вернуло
     * бы выборку шире запрошенной, и пользователь получил бы не то, что просил.
     */
    private function assertAccess(array $f): void
    {
        $level = $this->level();
        $used = [
            ReportsAccess::GROUP_ADDRESS_MULTI => ($f['city_ids'] !== [] || $f['city_only'] === true),
            ReportsAccess::GROUP_DEPARTMENT => ($f['department_ids'] !== []),
            ReportsAccess::GROUP_STATUS => ($f['status'] !== 'all'),
            ReportsAccess::GROUP_STAFF => ($f['staff_id'] > 0),
            ReportsAccess::GROUP_TEXT => (trim($f['details_text']) !== '' || trim($f['solution_text']) !== ''),
        ];
        foreach ($used as $group => $isUsed) {
            if ($isUsed && !ReportsAccess::groupAvailable($group, $level)) {
                throw new ApiException(
                    ErrorCode::Forbidden,
                    'Фильтр недоступен на текущем уровне доступа к отчётам',
                    reason: 'feature_not_available',
                    details: ['feature' => $group]
                );
            }
        }

        // light: отчёт только по конкретному лифту. Дом/город как фильтр
        // запрещены скоупом; city_only=true уже отсечён группой выше.
        if ($this->limits()['address_scope'] === 'object_only' && (int) $f['object_id'] <= 0) {
            throw new ApiException(
                ErrorCode::InvalidInput,
                'Лёгкий уровень: отчёт строится только по конкретному лифту. Выберите лифт в адресе.',
                reason: 'object_required'
            );
        }
    }

    /** Нормализация входа: всё приводится к типу, мусор не проходит. */
    private function filters(array $body): array
    {
        $status = $body['status'] ?? null;
        return [
            'date_from' => (int) ($body['date_from'] ?? 0),
            'date_to' => (int) ($body['date_to'] ?? 0),
            'date_type' => ($body['date_type'] ?? '') === 'closed' ? 'closed' : 'created',
            // §4 REPORTS.md: city_ids — общий фильтр трёх периодных
            // экшенов. Без нормализации здесь ветка мультивыбора в
            // buildWhere недостижима, контракт и код расходятся.
            // Приведение к int[] делает normalizeIds в конструкторе.
            'city_ids' => is_array($body['city_ids'] ?? null) ? $body['city_ids'] : [],
            'city_id' => (int) ($body['city_id'] ?? 0),
            'street_id' => (int) ($body['street_id'] ?? 0),
            'home_id' => (int) ($body['home_id'] ?? 0),
            'object_id' => (int) ($body['object_id'] ?? 0),
            'city_only' => (bool) ($body['city_only'] ?? false),
            'department_ids' => is_array($body['department_ids'] ?? null) ? $body['department_ids'] : [],
            'status' => in_array($status, ['open', 'close'], true) ? $status : 'all',
            'staff_id' => (int) ($body['staff_id'] ?? 0),
            'details_text' => (string) ($body['details_text'] ?? ''),
            'solution_text' => (string) ($body['solution_text'] ?? ''),
        ];
    }

    /**
     * Порядок проверок фиксирован: сначала «пусто», потом «слишком длинно».
     * §16: потолок периода — из лимитов уровня (31 у light, 90 у остальных);
     * reason прежний date_range_too_long, текст динамический.
     */
    private function validateDates(array $f, int $maxDays): bool
    {
        $from = (int) $f['date_from'];
        $to = (int) $f['date_to'];
        if ($from <= 0 || $from > $to || $to > strtotime('today 23:59:59')) {
            return false;
        }
        if ($to - $from > $maxDays * 86400) {
            throw new ApiException(
                ErrorCode::InvalidInput,
                'Период не может превышать ' . $maxDays . ' дней',
                reason: 'date_range_too_long'
            );
        }
        return true;
    }

    private function sort(array $body): string
    {
        return in_array($body['sort'] ?? null, ['address', 'department'], true)
            ? (string) $body['sort']
            : 'date';
    }

    /**
     * Сводка. Пресеты считает сервер: «текущая неделя» — понедельник→
     * сегодня, «текущий месяц» — 1-е→сегодня. Не скользящие 7/30 дней.
     *
     * Границы возвращаются клиенту, чтобы UI показал их явно: без этого
     * диспетчер не знает, что «неделя» началась в понедельник, а не
     * семь дней назад.
     *
     * validateDates не нужен: пресет всегда валиден и ≤ 31 дня.
     *
     * §16: сводка — способность standard+. У light клиент рисует тизер
     * без запроса; прямой вызов через DevTools получает 403 здесь.
     */
    public function getSummary(array $user, array $body): array
    {
        $this->gate($user);
        $this->gateFeature(ReportsAccess::FEATURE_SUMMARY);
        $preset = (string) ($body['period'] ?? 'today');
        if (!in_array($preset, ['today', '2days', 'week', 'month'], true)) {
            $preset = 'today';
        }
        [$from, $to] = $this->periodBounds($preset);
        $f = [
            'city_ids' => is_array($body['city_ids'] ?? null) ? $body['city_ids'] : [],
        ];
        $data = $this->repo->getSummary($f, $user, $from, $to, time());
        $data['period'] = [
            'preset' => $preset,
            'date_from' => $from,
            'date_to' => $to,
        ];
        return $data;
    }

    /**
     * Границы в бизнес-зоне: bootstrap фиксирует Europe/Moscow.
     *
     * Понедельник считаем через date('N') (1=Пн…7=Вс), а не
     * strtotime('monday this week'): арифметика от полуночи детерминирована
     * и не зависит от разбора относительных строк PHP.
     *
     * @return array{0:int,1:int}
     */
    private function periodBounds(string $preset): array
    {
        $todayStart = (int) strtotime('today 00:00:00');
        $to = (int) strtotime('today 23:59:59');
        $from = match ($preset) {
            '2days' => $todayStart - 86400,
            'week'  => $todayStart - ((int) date('N') - 1) * 86400,
            'month' => (int) mktime(0, 0, 0, (int) date('n'), 1, (int) date('Y')),
            default => $todayStart,
        };
        return [$from, $to];
    }

    /** §16: справочники открыты всем уровням — словари и так в config.staff_list. */
    public function getFiltersData(array $user): array
    {
        $this->gate($user);
        return $this->repo->getFiltersData();
    }

    public function getStats(array $user, array $body): ?array
    {
        $this->gate($user);
        $f = $this->filters($body);
        $this->assertAccess($f);
        if (!$this->validateDates($f, $this->limits()['max_period_days'])) {
            return null;
        }
        return $this->repo->getStats($f, $user);
    }

    public function getList(array $user, array $body): ?array
    {
        $this->gate($user);
        $f = $this->filters($body);
        $this->assertAccess($f);
        if (!$this->validateDates($f, $this->limits()['max_period_days'])) {
            return null;
        }
        $limit = min(200, max(10, (int) ($body['limit'] ?? 50)));
        $page = max(1, (int) ($body['page'] ?? 1));
        $sort = $this->sort($body);
        $total = $this->repo->countTotal($f, $user);
        // §16: потолок списка только у light (100), проверка ДО выборки.
        // reason переиспользован export_too_many_rows: сообщение «сузьте
        // период» уже принято приёмкой №40, новый reason ломал бы клиент.
        $cap = ReportsAccess::listCap($this->level());
        if ($cap !== null && $total > $cap) {
            throw new ApiException(
                ErrorCode::InvalidInput,
                'Слишком много результатов. Сузьте период поиска.',
                reason: 'export_too_many_rows'
            );
        }
        return [
            'items' => $this->repo->getList($f, $user, $limit, ($page - 1) * $limit, $sort),
            'pagination' => [
                'total_items' => $total,
                'current_page' => $page,
                'total_pages' => (int) ceil($total / $limit),
                'limit' => $limit,
            ],
        ];
    }

    /**
     * Обёртка ответа экспорта: пустая выборка — data:null с message,
     * а не ошибка (пользователь сузил период и получил честный ноль).
     */
    public function exportResponse(array $user, array $body): array
    {
        $data = $this->export($user, $body);
        if ($data === null) {
            return ['data' => null, 'message' => 'По вашему запросу ничего не найдено'];
        }
        return ['data' => $data];
    }

    private function export(array $user, array $body): ?array
    {
        $this->gate($user);
        // Карта форматов: allowlist, бакет лимитера, окно и §16-способность
        // — в одном месте. Новый формат нельзя добавить наполовину: либо
        // строка целиком, либо unsupported_format. Окно печати короче:
        // запрос тот же на 2001 строку, но перепечатать после правки фильтра
        // диспетчер должен без получасовой блокировки.
        $format = (string) ($body['format'] ?? '');
        $formats = [
            'csv'  => ['bucket' => 'csv',   'window' => 30, 'feature' => ReportsAccess::FEATURE_EXPORT_CSV],
            'json' => ['bucket' => 'print', 'window' => 10, 'feature' => ReportsAccess::FEATURE_EXPORT_PRINT],
            'xlsx' => ['bucket' => 'xlsx',  'window' => 30, 'feature' => ReportsAccess::FEATURE_EXPORT_XLSX],
        ];
        $fmt = $formats[$format] ?? null;
        if ($fmt === null) {
            throw new ApiException(
                ErrorCode::InvalidInput,
                'Неподдерживаемый формат выгрузки',
                reason: 'unsupported_format'
            );
        }
        // §16: гейт способности ДО лимитера и до запросов. Иначе standard-
        // тенант, дёргая XLSX через DevTools, сжигал бы окно бакета отказом.
        $this->gateFeature($fmt['feature']);

        // Валидация дат — чистая арифметика, ни одного запроса. Заряжать
        // за неё окно 30 с незачем: диспетчер с опечаткой в периоде
        // получал блокировку вместо пустого результата.
        $f = $this->filters($body);
        $this->assertAccess($f);
        if (!$this->validateDates($f, $this->limits()['max_period_days'])) {
            return null;
        }
        // Лимит остаётся ДО запроса: пустая выборка и too_many_rows
        // уже выполнили SELECT с JOIN и filesort. Снять с них лимит —
        // значит открыть неограниченный перебор широких периодов.
        // Кнопка CSV гаснет при нуле строк, поэтому честный пустой
        // поиск окно не сжигает.
        $retry = (new ExportRateLimiter($fmt['window']))->tryAcquire(
            $this->tenant?->id ?? 'unknown',
            (int) ($user['id'] ?? 0),
            $fmt['bucket']
        );
        if ($retry !== null) {
            // details уйдёт в ответ плоско (retry_after), §16.1.
            throw new ApiException(
                ErrorCode::RateLimited,
                'Слишком много запросов. Повторите позже.',
                reason: 'rate_limited',
                details: ['retry_after' => $retry]
            );
        }
        // Потолок строк — из лимитов уровня. N+1: ровно N валидно,
        // N+1-я строка — признак переполнения. LIMIT N не отличил бы
        // «ровно N» от «больше».
        // Печать ждёт контракт items (mapItem), CSV — сырые строки:
        // ReportsExporter читает имена колонок БД. selectRows() у обоих
        // один, WHERE не меняется — инвариант «экспорт = список» цел.
        $maxRows = $this->limits()['max_rows'];
        $sort = $this->sort($body);
        if ($format === 'csv') {
            // CSV читает имена колонок БД — ему нужно сырьё.
            $rows = $this->repo->getExportRows($f, $user, $sort, $maxRows + 1);
        } else {
            // Печать — контракт items; XLSX — items плюс заметки.
            $rows = $this->repo->getExportRowsMapped(
                $f,
                $user,
                $sort,
                $maxRows + 1,
                $format === 'xlsx'
            );
        }
        if (count($rows) > $maxRows) {
            throw new ApiException(
                ErrorCode::InvalidInput,
                'Слишком много результатов. Сузьте период поиска.',
                reason: 'export_too_many_rows'
            );
        }
        if ($rows === []) {
            return null;
        }
        // Печать: строки уходят клиенту, документ собирает браузер через
        // createElement + textContent. HTML с сервера не отдаём — это
        // данные, а не статический шаблон (правило 1).
        if ($format === 'json') {
            return [
                'rows' => $rows,
                'rows_count' => count($rows),
            ];
        }
        if ($format === 'xlsx') {
            $xlsx = (new ReportsXlsxExporter())->renderXlsx($rows);
            return [
                'file_base64' => base64_encode($xlsx),
                'filename' => 'report_' . date('Y-m-d') . '.xlsx',
                'mime_type' => 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
                'rows_count' => count($rows),
            ];
        }
        $csv = (new ReportsExporter())->renderCsv($rows);
        return [
            'file_base64' => base64_encode($csv),
            'filename' => 'report_' . date('Y-m-d') . '.csv',
            'mime_type' => 'text/csv',
            'rows_count' => count($rows),
        ];
    }
}