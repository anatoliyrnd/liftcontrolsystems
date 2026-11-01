<?php
declare(strict_types=1);

namespace App\Support;

/**
 * Классификация заявок от СПульта по тексту Note
 */
final class SpultClassifier
{
    /**
     * @return array{call_department: int, call_request: int, call_group: int, alert_level: int, repair_days: int}
     */
    public static function classify(string $note): array
    {
        $noteLower = mb_strtolower($note);

        // По умолчанию: Электромеханики, Не срочная, Прочее, Обычный, 3 дня
        $result = [
            'call_department' => 22,
            'call_request' => 3,
            'call_group' => 9,
            'alert_level' => 1,
            'repair_days' => 3,
        ];

        if (mb_strpos($noteLower, 'освобождение пассажира') !== false) {
            // 1. Освобождение пассажира
            $result['call_department'] = 23;
            $result['call_request'] = 1;
            $result['call_group'] = 4;
            $result['alert_level'] = 3;
            $result['repair_days'] = 1;
        } elseif (mb_strpos($noteLower, 'устранение неисправностей лифта') !== false) {
            // 2. Устранение неисправностей лифта
            $result['call_department'] = 22;
            $result['call_request'] = 2;
            $result['call_group'] = 6;
            $result['alert_level'] = 2;
            $result['repair_days'] = 3;
        } elseif (mb_strpos($noteLower, 'устранение нештатных ситуаций') !== false) {
            // 3. Устранение нештатных ситуаций
            $result['call_department'] = 22;
            $result['call_request'] = 2;
            $result['call_group'] = 6;
            $result['alert_level'] = 2;
            $result['repair_days'] = 3;
        } elseif (
            mb_strpos($noteLower, 'устранение неисправностей диспетчерского') !== false
            || mb_strpos($noteLower, 'неисправность дисп. об') !== false
        ) {
            // 4. Неисправность диспетчерского оборудования
            $result['call_department'] = 22;
            $result['call_request'] = 2;
            $result['call_group'] = 24;
            $result['alert_level'] = 2;
            $result['repair_days'] = 3;
        } elseif (
            mb_strpos($noteLower, 'отключение лифта для проведения технического обслуживания') !== false
            || mb_strpos($noteLower, 'проведения то') !== false
        ) {
            // 5. ТО
            $result['call_department'] = 22;
            $result['call_request'] = 2;
            $result['call_group'] = 7;
            $result['alert_level'] = 1;
            $result['repair_days'] = 2;
        } elseif (mb_strpos($noteLower, 'угрозы причинения вреда') !== false) {
            // 6. Угроза вреда
            $result['call_department'] = 23;
            $result['call_request'] = 2;
            $result['call_group'] = 6;
            $result['alert_level'] = 3;
            $result['repair_days'] = 3;
        } elseif (mb_strpos($noteLower, 'распоряжению владельца') !== false) {
            // 7. По распоряжению владельца
            $result['call_department'] = 22;
            $result['call_request'] = 3;
            $result['call_group'] = 7;
            $result['alert_level'] = 1;
            $result['repair_days'] = 5;
        } elseif (mb_strpos($noteLower, 'техосвидетельствования') !== false) {
            // 8. Техосвидетельствование
            $result['call_department'] = 22;
            $result['call_request'] = 3;
            $result['call_group'] = 7;
            $result['alert_level'] = 1;
            $result['repair_days'] = 5;
        } elseif (
            mb_strpos($noteLower, 'внепланового ремонта') !== false
            || mb_strpos($noteLower, 'капитального ремонта') !== false
            || mb_strpos($noteLower, 'модернизации') !== false
        ) {
            // 9, 10. Капремонт/модернизация
            $result['call_department'] = 22;
            $result['call_request'] = 3;
            $result['call_group'] = 8;
            $result['alert_level'] = 1;
            $result['repair_days'] = 10;
        } elseif (mb_strpos($noteLower, 'обследования') !== false) {
            // 11. Обследование
            $result['call_department'] = 22;
            $result['call_request'] = 3;
            $result['call_group'] = 7;
            $result['alert_level'] = 1;
            $result['repair_days'] = 5;
        } elseif (mb_strpos($noteLower, 'устранения нарушений') !== false) {
            // 12. Устранение нарушений
            $result['call_department'] = 22;
            $result['call_request'] = 2;
            $result['call_group'] = 7;
            $result['alert_level'] = 2;
            $result['repair_days'] = 3;
        } elseif (
            mb_strpos($noteLower, 'мелких') !== false
            || mb_strpos($noteLower, 'незначительных') !== false
        ) {
            // 13. Мелкие неисправности
            $result['call_department'] = 22;
            $result['call_request'] = 3;
            $result['call_group'] = 5;
            $result['alert_level'] = 1;
            $result['repair_days'] = 5;
        }

        return $result;
    }
}