<?php
declare(strict_types=1);

namespace App\Service;

use App\Exceptions\ApiException;
use App\Http\ErrorCode;
use App\Repository\ReportsRepository;
use App\Support\ExportRateLimiter;
use App\Tenant;

/**
 * Оркестрация отчётов: права → нормализация фильтров → валидация дат →
 * репозиторий. SQL здесь не живёт — он в ReportsQueryBuilder/Repository.
 *
 * Права проверяются НА СЕРВЕРЕ с первого дня: это осознанный отход от
 * долга §20 для нового модуля. Иначе инженер или гость получили бы
 * выгрузку всего тенанта через DevTools.
 *
 * Невалидные даты → data:null, не исключение: пользователь видит
 * пустой результат, а не ошибку там, где виновата форма.
 * Исключение — только период > 90 дней и лимиты экспорта.
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
        $role = (string) ($user['role'] ?? '');
        if ($role === 'guest' || $role === 'reserved') {
            throw new ApiException(
                ErrorCode::Forbidden,
                'Отчёты недоступны для этой роли',
                reason: 'no_rights'
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

    /** Порядок проверок фиксирован: сначала «пусто», потом «слишком длинно». */
    private function validateDates(array $f): bool
    {
        $from = (int) $f['date_from'];
        $to = (int) $f['date_to'];
        if ($from <= 0 || $from > $to || $to > strtotime('today 23:59:59')) {
            return false;
        }
        if ($to - $from > 90 * 86400) {
            throw new ApiException(
                ErrorCode::InvalidInput,
                'Период не может превышать 90 дней',
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
     */
    public function getSummary(array $user, array $body): array
    {
        $this->gate($user);
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

    public function getFiltersData(array $user): array
    {
        $this->gate($user);
        return $this->repo->getFiltersData();
    }

    public function getStats(array $user, array $body): ?array
    {
        $this->gate($user);
        $f = $this->filters($body);
        if (!$this->validateDates($f)) {
            return null;
        }
        return $this->repo->getStats($f, $user);
    }

    public function getList(array $user, array $body): ?array
    {
        $this->gate($user);
        $f = $this->filters($body);
        if (!$this->validateDates($f)) {
            return null;
        }
        $limit = min(200, max(10, (int) ($body['limit'] ?? 50)));
        $page = max(1, (int) ($body['page'] ?? 1));
        $sort = $this->sort($body);

        $total = $this->repo->countTotal($f, $user);
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
        if ((string) ($body['format'] ?? '') !== 'csv') {
            throw new ApiException(
                ErrorCode::InvalidInput,
                'Неподдерживаемый формат выгрузки',
                reason: 'unsupported_format'
            );
        }

        $retry = (new ExportRateLimiter(30))->tryAcquire(
            $this->tenant?->id ?? 'unknown',
            (int) ($user['id'] ?? 0)
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

        $f = $this->filters($body);
        if (!$this->validateDates($f)) {
            return null;
        }

        // 2001: ровно 2000 валидно, 2001-я строка — признак переполнения.
        // LIMIT 2000 не отличил бы «ровно 2000» от «больше».
        $rows = $this->repo->getExportRows($f, $user, $this->sort($body), 2001);
        if (count($rows) > 2000) {
            throw new ApiException(
                ErrorCode::InvalidInput,
                'Слишком много результатов. Сузьте период поиска.',
                reason: 'export_too_many_rows'
            );
        }
        if ($rows === []) {
            return null;
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