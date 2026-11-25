<?php
declare(strict_types=1);
namespace App\Support;

/**
 * REPORTS §17: уровни доступа к отчётам — единая точка истины.
 *
 * Шкала упорядочена: light < standard < extended. Проверка — сравнение
 * рангов, а не три независимых булевых флага: новый уровень добавляется
 * одной строкой в RANKS и картами ниже, вызывающие места не меняются.
 *
 * ДВЕ карты + лимиты, а не профиль-список на уровень: extended иначе
 * дублировал бы список standard, и правка расходилась бы в трёх местах.
 *   FEATURE_MIN_LEVEL — булевы способности (сводка, форматы экспорта);
 *   GROUP_MIN_LEVEL   — группы фильтров payload;
 *   LEVEL_LIMITS      — числа и скоупы, булем не выражаются.
 *
 * КЛЮЧИ СПОСОБНОСТЕЙ — КОНТРАКТ С КЛИЕНТОМ. Значения ниже обязаны
 * посимвольно совпадать с REPORTS.ACCESS.FEATURES в js/config.js:
 * клиент рисует замок по членству строки в reports_features, и любое
 * расхождение написания («csv_export» против «export_csv») гасит
 * разрешённую кнопку на ровном месте. Переименование ключа — правка
 * двух файлов одним коммитом, не односторонняя.
 *
 * FAIL-CLOSED: неизвестный ключ фичи/группы → InvalidArgumentException
 * (дефект разработки: гейт добавили, ключ в карту забыли — способность
 * не должна молча утечь в standard). Неизвестный уровень → light + warning.
 *
 * ИНВАРИАНТЫ:
 *  - Уровень ⊥ CallScope: тариф не меняет видимость заявок ни в одну сторону.
 *  - byId обслуживается экшеном ticket и вне этого гейта вообще.
 *  - reports_level не гейтит ticket/open/close/loadAddress — только reports_*.
 *  - Дефолтные значения фильтров проходят молча; отказ только явный.
 *
 * Класс чистый: без БД. Уровень приезжает в Tenant из Registry (SELECT *),
 * поэтому чтение уровня не стоит ни одного дополнительного запроса.
 */
final class ReportsAccess
{
    public const string LIGHT = 'light';
    public const string STANDARD = 'standard';
    public const string EXTENDED = 'extended';

    // Булевы способности. Ключи совпадают с reports_features в config.
    public const string FEATURE_SUMMARY = 'summary';
    public const string FEATURE_EXPORT_CSV = 'export_csv';
    public const string FEATURE_EXPORT_PRINT = 'export_print';
    public const string FEATURE_EXPORT_XLSX = 'export_xlsx';

    // Группы фильтров payload. Ключи совпадают с reports_limits.filter_groups.
    public const string GROUP_DATE = 'date';
    public const string GROUP_ADDRESS = 'address';
    public const string GROUP_SORT = 'sort';
    public const string GROUP_ADDRESS_MULTI = 'address_multi';
    public const string GROUP_DEPARTMENT = 'department';
    public const string GROUP_STATUS = 'status';
    public const string GROUP_STAFF = 'staff';
    public const string GROUP_TEXT = 'text';

    private const array RANKS = [
        self::LIGHT => 1,
        self::STANDARD => 2,
        self::EXTENDED => 3,
    ];

    /**
     * CSV и печать — базовые способности standard, не extended.
     *把它们 в extended означало бы даунгрейд оплаченного тарифа:
     * диспетчер standard терял бы выгрузку, которая работала до §17.
     * Extended добавляет ровно одно — XLSX.
     */
    private const array FEATURE_MIN_LEVEL = [
        self::FEATURE_SUMMARY => self::STANDARD,
        self::FEATURE_EXPORT_CSV => self::STANDARD,
        self::FEATURE_EXPORT_PRINT => self::STANDARD,
        self::FEATURE_EXPORT_XLSX => self::EXTENDED,
    ];

    private const array GROUP_MIN_LEVEL = [
        self::GROUP_DATE => self::LIGHT,
        self::GROUP_ADDRESS => self::LIGHT,
        self::GROUP_SORT => self::LIGHT,
        self::GROUP_ADDRESS_MULTI => self::STANDARD,
        self::GROUP_DEPARTMENT => self::STANDARD,
        self::GROUP_STATUS => self::STANDARD,
        self::GROUP_STAFF => self::STANDARD,
        self::GROUP_TEXT => self::EXTENDED,
    ];

    private const array LEVEL_LIMITS = [
        self::LIGHT => [
            'max_period_days' => 31,
            'max_rows' => 100,
            'address_scope' => 'object_only',
        ],
        self::STANDARD => [
            'max_period_days' => 90,
            'max_rows' => 2000,
            'address_scope' => 'any',
        ],
        self::EXTENDED => [
            'max_period_days' => 90,
            'max_rows' => 2000,
            'address_scope' => 'any',
        ],
    ];

    /**
     * Нормализация уровня из БД. Неизвестное/NULL → light (fail-closed):
     * битая конфигурация не должна открывать расширенные способности.
     * NULL возможен только если код развернут раньше ALTER — порядок
     * применения коммита: сначала SQL. Warning делает расхождение видимым.
     */
    public static function normalizeLevel(?string $raw): string
    {
        $key = strtolower(trim((string) $raw));
        if (isset(self::RANKS[$key])) {
            return $key;
        }
        Logger::warning('reports_level: неизвестный уровень, fail-closed light', [
            'raw' => $raw,
        ]);
        return self::LIGHT;
    }

    public static function rank(string $level): int
    {
        return self::RANKS[$level] ?? self::RANKS[self::LIGHT];
    }

    public static function featureAvailable(string $feature, string $level): bool
    {
        $min = self::FEATURE_MIN_LEVEL[$feature] ?? null;
        if ($min === null) {
            throw new \InvalidArgumentException('unknown reports feature: ' . $feature);
        }
        return self::rank($level) >= self::RANKS[$min];
    }

    public static function groupAvailable(string $group, string $level): bool
    {
        $min = self::GROUP_MIN_LEVEL[$group] ?? null;
        if ($min === null) {
            throw new \InvalidArgumentException('unknown reports filter group: ' . $group);
        }
        return self::rank($level) >= self::RANKS[$min];
    }

    public static function limits(string $level): array
    {
        return self::LEVEL_LIMITS[$level] ?? self::LEVEL_LIMITS[self::LIGHT];
    }

    /**
     * Потолок строк СПИСКА. Только у light: у standard/extended список
     * пагинирован без потолка (поведение v6.5), а 2000 — потолок экспорта.
     * Ввести 2000 на список значило бы даунгрейд существующего поведения.
     */
    public static function listCap(string $level): ?int
    {
        return $level === self::LIGHT ? self::limits($level)['max_rows'] : null;
    }

    /**
     * Порядок ключей в ответе стабилен и совпадает с порядком карты:
     * клиент сравнивает сигнатуру набора, лишний пересорт вызывал бы
     * ложное событие reports:access и пересборку формы фильтров.
     */
    public static function availableFeatures(string $level): array
    {
        $rank = self::rank($level);
        $out = [];
        foreach (self::FEATURE_MIN_LEVEL as $feature => $min) {
            if ($rank >= self::RANKS[$min]) {
                $out[] = $feature;
            }
        }
        return $out;
    }

    public static function availableGroups(string $level): array
    {
        $rank = self::rank($level);
        $out = [];
        foreach (self::GROUP_MIN_LEVEL as $group => $min) {
            if ($rank >= self::RANKS[$min]) {
                $out[] = $group;
            }
        }
        return $out;
    }

    /**
     * Плоский аддитивный блок для config (§10.1: рядом со status).
     * Матрица уровней живёт ТОЛЬКО здесь: фронт рендерит присланное,
     * в config.js — имена ключей и тексты, не состав уровней.
     */
    public static function configPayload(string $level): array
    {
        $limits = self::limits($level);
        return [
            'reports_level' => $level,
            'reports_features' => self::availableFeatures($level),
            'reports_limits' => [
                'max_period_days' => $limits['max_period_days'],
                'max_rows' => $limits['max_rows'],
                'address_scope' => $limits['address_scope'],
                'filter_groups' => self::availableGroups($level),
            ],
        ];
    }
}