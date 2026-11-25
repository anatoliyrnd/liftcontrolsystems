<?php
declare(strict_types=1);

if (!defined('APP_ENTRY_POINT')) {
    http_response_code(404);
    exit;
}

use App\Support\ReportsAccess;

/**
 * Подписи уровней для Platform Admin. Только тексты, не состав:
 * список и порядок — ReportsAccess::levels().
 * Незнакомый ключ не ломает форму: показываем сам ключ.
 */
const ADMIN_REPORTS_LEVEL_LABELS = [
    ReportsAccess::LIGHT    => 'Лёгкий',
    ReportsAccess::STANDARD => 'Стандарт',
    ReportsAccess::EXTENDED => 'Расширенный',
];

function admin_reports_level_label(string $level): string
{
    return ADMIN_REPORTS_LEVEL_LABELS[$level] ?? $level;
}

/** Готовые <option>. Строка уже экранирована — снаружи esc() НЕ нужен. */
function admin_reports_level_options(string $selected): string
{
    $html = '';
    foreach (ReportsAccess::levels() as $level) {
        $html .= sprintf(
            '<option value="%s"%s>%s</option>',
            htmlspecialchars($level, ENT_QUOTES, 'UTF-8'),
            $level === $selected ? ' selected' : '',
            htmlspecialchars(admin_reports_level_label($level), ENT_QUOTES, 'UTF-8')
        );
    }
    return $html;
}

/** Карта рангов для JS-подтверждения понижения. Тоже без хардкода. */
function admin_reports_level_ranks(): array
{
    $out = [];
    foreach (ReportsAccess::levels() as $level) {
        $out[$level] = ReportsAccess::rank($level);
    }
    return $out;
}