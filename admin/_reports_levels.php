<?php
declare(strict_types=1);

/**
 * Подписи и справочная выдача уровней отчётов для Platform Admin.
 *
 * ТОЛЬКО тексты и витрина. Состава уровней и матрицы способностей здесь нет:
 * список и порядок — ReportsAccess::levels() (или RANKS через rank()),
 * способности и лимиты — ReportsAccess::configPayload().
 * Незнакомый ключ не ломает вывод: показываем сам ключ.
 *
 * Подключается только через require_once из admin/*.php.
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
 * Канонический упорядоченный список уровней.
 * Если в ReportsAccess уже есть публичная витрина RANKS — берём её.
 * Иначе порядок всё равно выводим из RANKS через публичный rank(),
 * а не из порядка строк в этом файле.
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

function admin_reports_scope_label(string $key): string
{
    return ADMIN_REPORTS_SCOPE_LABELS[$key] ?? $key;
}

/** Готовые <option>. Строка уже экранирована — снаружи esc() НЕ нужен. */
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

/**
 * Справочная выдача по уровню — без записи.
 * Всё считает ReportsAccess, админка только показывает.
 */
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

/** Объединение способностей по всем уровням — порядок из карты ReportsAccess. */
function admin_reports_all_features(): array
{
    $out = [];
    foreach (array_reverse(admin_reports_levels()) as $level) {
        foreach (ReportsAccess::availableFeatures($level) as $f) {
            $out[$f] = true;
        }
    }
    $ordered = [];
    foreach (admin_reports_level_payload(admin_reports_levels()[count(admin_reports_levels()) - 1])['features'] as $f) {
        $ordered[] = $f;
    }
    foreach (array_keys($out) as $f) {
        if (!in_array($f, $ordered, true)) {
            $ordered[] = $f;
        }
    }
    return $ordered;
}

/** Объединение групп фильтров по всем уровням. */
function admin_reports_all_groups(): array
{
    $out = [];
    foreach (array_reverse(admin_reports_levels()) as $level) {
        foreach (ReportsAccess::availableGroups($level) as $g) {
            $out[$g] = true;
        }
    }
    return array_keys($out);
}