<?php
declare(strict_types=1);

namespace App\Support;

/**
 * Валидация значений lift_options, влияющих на разбор адреса СПульт.
 *
 * Класс чистый: значение на входе, строка на выходе, без БД и логов —
 * как CallScope. Первый барьер — панель organization settings при
 * сохранении; этот — второй, на чтении, потому что значение правят
 * и руками в БД.
 *
 * Причина существования: `?? '#'` не подставляет дефолт при ПУСТОЙ
 * строке (пустая строка не null), а strpos($s, '') в PHP 8 возвращает 0,
 * а не false. Город тогда получал пустое имя, улица — всю строку.
 *
 * is_scalar: массив в option_value дал бы «Array to string conversion»,
 * а set_error_handler из bootstrap превратил бы warning в исключение.
 * Та же природа, что у org_key в ApiController::handlePublicAction.
 */
final class OptionGuard
{
    /** Историческое значение lift_options.city_separator. */
    public const string SEPARATOR_DEFAULT = '#';

    /**
     * Разрешённые разделители «город<sep>улица».
     *
     * Критерий: символ не встречается в названиях и сокращениях
     * населённых пунктов и улиц. Запрещены навсегда:
     *   пробел, '.', '-', '/' — части имён и номеров домов («20/1»);
     *   ',', ';'              — разделители display-подписи, а запятая
     *                           бывает внутри имени лифта («п.1, пасс.»);
     *   '№'                   — маркер дома в parseHome.
     * '|' зарезервирован под возможный разделитель типа н.п.
     * и в список сознательно не входит.
     *
     * Расширение — одна строка здесь, без правки вызывающих мест.
     */
    public const array SEPARATORS = ['#', '@', '%', '>', '<', '~', '^', '*'];

    /** Ровно один разрешённый символ, иначе дефолт. */
    public static function separator(mixed $raw): string
    {
        if (!is_scalar($raw)) {
            return self::SEPARATOR_DEFAULT;
        }
        $s = trim((string) $raw);
        if (mb_strlen($s, 'UTF-8') !== 1) {
            return self::SEPARATOR_DEFAULT;
        }
        return in_array($s, self::SEPARATORS, true)
            ? $s
            : self::SEPARATOR_DEFAULT;
    }
}