<?php
declare(strict_types=1);

/**
 * Подписи и справочная выдача уровней отчётов для Platform Admin.
 * Только тексты и витрина: состав уровней, способности и лимиты
 * живут в ReportsAccess, копий здесь нет.
 */

if (!defined('APP_ENTRY_POINT')) {
    http_response_code(404);
    exit;
}

use App\Support\ReportsAccess;

const ADMIN_REPORTS_LEVEL_LABELS = [
    ReportsAccess::LIGHT    => 'Лёгкий',
    ReportsAccess::STANDARD => 'Стандарт',
    ReportsAccess::EXTENDED => 'Расширенный',
];

const ADMIN_REPORTS_FEATURE_LABELS = [
    ReportsAccess::FEATURE_SUMMARY      => 'Сводка',
    ReportsAccess::FEATURE_EXPORT_CSV   => 'Экспорт CSV',
    ReportsAccess::FEATURE_EXPORT_PRINT => 'Печать',
    ReportsAccess::FEATURE_EXPORT_XLSX  => 'Экспорт XLSX',
];

const ADMIN_REPORTS_GROUP_LABELS = [
    ReportsAccess::GROUP_DATE          => 'Период',
    ReportsAccess::GROUP_ADDRESS       => 'Адрес',
    ReportsAccess::GROUP_SORT          => 'Сортировка',
    ReportsAccess::GROUP_ADDRESS_MULTI => 'Мультиадрес',
    ReportsAccess::GROUP_DEPARTMENT    => 'Подразделение',
    ReportsAccess::GROUP_STATUS        => 'Статус',
    ReportsAccess::GROUP_STAFF         => 'Персонал',
    ReportsAccess::GROUP_TEXT          => 'Текстовый поиск',
];

const ADMIN_REPORTS_SCOPE_LABELS = [
    'object_only' => 'Только свой объект',
    'any'         => 'Любой адрес',
];

/**
 * Порядок — из RANKS. Публичная витрина levels() используется, если есть;
 * иначе константы сортируются через публичный rank().
 *
 * @return list<string>
 */
function admin_reports_levels(): array
{
    if (method_exists(ReportsAccess::class, 'levels')) {
        $list = ReportsAccess::levels();
        if (is_array($list) && $list !== []) {
            return array_values($list);
        }
    }

    $list = [ReportsAccess::LIGHT, ReportsAccess::STANDARD, ReportsAccess::EXTENDED];
    usort($list, static fn(string $a, string $b): int => ReportsAccess::rank($a) <=> ReportsAccess::rank($b));

    return $list;
}

/** Строгая проверка для записи; мусор не нормализуется в light. */
function admin_reports_is_level(string $level): bool
{
    if (method_exists(ReportsAccess::class, 'isLevel')) {
        return ReportsAccess::isLevel($level);
    }
    return in_array($level, admin_reports_levels(), true);
}

function admin_reports_level_label(string $level): string
{
    return ADMIN_REPORTS_LEVEL_LABELS[$level] ?? $level;
}

function admin_reports_level_rank(string $level): int
{
    return ReportsAccess::rank($level);
}

function admin_reports_feature_label(string $key): string
{
    return ADMIN_REPORTS_FEATURE_LABELS[$key] ?? $key;
}

function admin_reports_group_label(string $key): string
{
    return ADMIN_REPORTS_GROUP_LABELS[$key] ?? $key;
}

/** @return array<string,int> */
function admin_reports_level_ranks(): array
{
    $out = [];
    foreach (admin_reports_levels() as $level) {
        $out[$level] = ReportsAccess::rank($level);
    }
    return $out;
}

/** Готовые <option>. Строка уже экранирована. */
function admin_reports_level_options(string $selected): string
{
    $html = '';
    foreach (admin_reports_levels() as $level) {
        $html .= sprintf(
            '<option value="%s"%s>%s</option>',
            htmlspecialchars($level, ENT_QUOTES, 'UTF-8'),
            $level === $selected ? ' selected' : '',
            htmlspecialchars(admin_reports_level_label($level), ENT_QUOTES, 'UTF-8')
        );
    }
    return $html;
}

function admin_reports_level_payload(string $level): array
{
    $p = ReportsAccess::configPayload($level);

    return [
        'level'    => $level,
        'label'    => admin_reports_level_label($level),
        'rank'     => ReportsAccess::rank($level),
        'features' => $p['reports_features'],
        'limits'   => $p['reports_limits'],
        'list_cap' => ReportsAccess::listCap($level),
    ];
}

/** @return array<string,array> */
function admin_reports_matrix(): array
{
    $out = [];
    foreach (admin_reports_levels() as $level) {
        $out[$level] = admin_reports_level_payload($level);
    }
    return $out;
}

/**
 * Старший уровень содержит все ключи: availableFeatures/availableGroups
 * идут по карте MIN_LEVEL и отбирают по рангу.
 */
function admin_reports_all_features(): array
{
    $levels = admin_reports_levels();
    return ReportsAccess::availableFeatures((string) end($levels));
}

function admin_reports_all_groups(): array
{
    $levels = admin_reports_levels();
    return ReportsAccess::availableGroups((string) end($levels));
}

/** Общий блок метаданных для JS обеих страниц. */
function admin_reports_meta(): array
{
    return [
        'levels'   => admin_reports_levels(),
        'features' => array_map(
            static fn(string $k): array => ['key' => $k, 'label' => admin_reports_feature_label($k)],
            admin_reports_all_features()
        ),
        'groups'   => array_map(
            static fn(string $k): array => ['key' => $k, 'label' => admin_reports_group_label($k)],
            admin_reports_all_groups()
        ),
        'scopes'   => ADMIN_REPORTS_SCOPE_LABELS,
    ];
}