<?php
declare(strict_types=1);

namespace App\Support;

final class Period
{
    public static function resolve(string|int|null $period): int
    {
        if ($period === null || $period === '') {
            return time() - 86400; // По умолчанию 24 часа
        }

        $val = (int) $period;

        // Если передали Unix timestamp (дату) напрямую
        if ($val > 100000) {
            return $val;
        }

        // Если передали количество дней (с ограничением в 7 дней)
        if ($val > 0 && $val <= 30) {
            $days = min($val, 7);
            return time() - ($days * 86400);
        }

        return time() - 86400;
    }
}