<?php
declare(strict_types=1);

namespace App\Support;

/**
 * Адресный слой: разбор, ключ сопоставления, форматирование.
 *
 * Три РАЗНЫЕ операции, которые нельзя смешивать:
 *   parse*   — снимает тип улицы / маркер дома со входа;
 *   *Key     — ключ сопоставления, только для поиска;
 *   format*  — добавляет маркеры ровно один раз, защитно.
 *
 * Форматировщик нормализует НЕЗАВИСИМО от чистоты БД: легаси-тенанты
 * и ручная правка справочника продолжат плодить «д.20/1». Если чистота
 * обеспечена только бэкфиллом, двойное «д.» вернётся через месяц.
 *
 * Нормализация строго по полю: «д.» в доме — «дом», в улице — «деревня».
 * Общей функции «вырезать д.» быть не должно.
 *
 * ё/е не сворачиваем: это могут быть разные улицы. Близкие промахи
 * попадают в отчёт, а не в мёрж.
 */
final class Address
{
    /**
     * Закрытая карта ходовых типов, а не классификатор ГАР (300+ позиций).
     * Трек А живёт 6–8 месяцев, полный словарь — AddressProvider в Треке Б;
     * поле gar зарезервировано, чтобы переезд стал маппингом, а не археологией.
     *
     * pos — позиция при ФОРМАТИРОВАНИИ. При разборе тип принимается с обеих
     * сторон: «ул. Ленина» и «Ленина ул.» — одна улица. Порядок СПульт —
     * их convention для сортировки, а не данные.
     *
     * Неоднозначные сокращения («пр», «у», «к») в алиасы НЕ входят:
     * «пр» — это и проспект, и проезд.
     */
    private const TYPES = [
        'ул'    => ['pos' => 'prefix', 'gar' => null, 'al' => ['ул', 'улица']],
        'пр-кт' => ['pos' => 'prefix', 'gar' => null, 'al' => ['пркт', 'проспект', 'просп', 'пр-кт']],
        'пер'   => ['pos' => 'prefix', 'gar' => null, 'al' => ['пер', 'переулок']],
        'пл'    => ['pos' => 'prefix', 'gar' => null, 'al' => ['пл', 'площадь']],
        'б-р'   => ['pos' => 'prefix', 'gar' => null, 'al' => ['бр', 'бульвар', 'бул', 'б-р']],
        'ш'     => ['pos' => 'suffix', 'gar' => null, 'al' => ['ш', 'шоссе']],
        'наб'   => ['pos' => 'prefix', 'gar' => null, 'al' => ['наб', 'набережная']],
        'пр-д'  => ['pos' => 'prefix', 'gar' => null, 'al' => ['прд', 'проезд', 'пр-д']],
        'туп'   => ['pos' => 'prefix', 'gar' => null, 'al' => ['туп', 'тупик']],
        'ал'    => ['pos' => 'prefix', 'gar' => null, 'al' => ['ал', 'аллея']],
        'линия' => ['pos' => 'suffix', 'gar' => null, 'al' => ['линия', 'лин']],
        'кв-л'  => ['pos' => 'prefix', 'gar' => null, 'al' => ['квл', 'квартал', 'кв-л']],
        'мкр'   => ['pos' => 'prefix', 'gar' => null, 'al' => ['мкр', 'мкрн', 'микрорайон']],
        'тер'   => ['pos' => 'prefix', 'gar' => null, 'al' => ['тер', 'территория']],
    ];

    private static ?array $aliasMap = null;

    private static function aliasMap(): array
    {
        if (self::$aliasMap === null) {
            $m = [];
            foreach (self::TYPES as $canon => $def) {
                foreach ($def['al'] as $a) {
                    $m[self::token($a)] = $canon;
                }
            }
            self::$aliasMap = $m;
        }
        return self::$aliasMap;
    }

    /** Пробелы: NBSP в справочнике встречается, а \s его не берёт без /u. */
    private static function space(string $s): string
    {
        $s = str_replace("\u{00A0}", ' ', trim($s));
        return trim(preg_replace('/\s+/u', ' ', $s) ?? $s);
    }

    /** Нормализация токена/имени для ключа: регистр, точки, пробелы. */
    private static function token(string $s): string
    {
        return str_replace([' ', '.'], '', mb_strtolower(self::space($s), 'UTF-8'));
    }

    /**
     * @return array{type:?string,name:string}
     */
    public static function parseStreet(string $raw): array
    {
        $s = self::space($raw);
        if ($s === '') {
            return ['type' => null, 'name' => ''];
        }

        $parts = explode(' ', $s);
        $map   = self::aliasMap();
        $n     = count($parts);

        // Префикс: «ул. Ленина». Требуем непустой остаток — иначе улица
        // с названием «Линия» превратилась бы в тип без имени.
        if ($n > 1 && isset($map[self::token($parts[0])])) {
            $name = self::space(implode(' ', array_slice($parts, 1)));
            if ($name !== '') {
                return ['type' => $map[self::token($parts[0])], 'name' => $name];
            }
        }

        // Суффикс: «Ленина ул.», «1-я линия». Разбор по ПОСЛЕДНЕМУ токену,
        // поэтому порядковое числительное в имени не съедается:
        // «1-я Советская ул.» → тип ул, имя «1-я Советская».
        if ($n > 1 && isset($map[self::token($parts[$n - 1])])) {
            $name = self::space(implode(' ', array_slice($parts, 0, -1)));
            if ($name !== '') {
                return ['type' => $map[self::token($parts[$n - 1])], 'name' => $name];
            }
        }

        // Неизвестный тип остаётся в названии и попадает в отчёт.
        // Не угадываем: ложное совпадение хуже карантина.
        return ['type' => null, 'name' => $s];
    }

    /**
     * Маркер дома снимается ТОЛЬКО ведущий и только в поле дома.
     *
     * Требуем после маркера пробел или цифру: иначе «домовой» потерял бы
     * начало, а одинокую литеру «Д» мы бы стёрли в пустоту.
     *
     * «корп», «с», дробь и литера — идентичность дома, не мусор:
     * «2 корп.2» → «2 корп.2», не «2».
     *
     * @return array{name:string}
     */
    public static function parseHome(string $raw): array
    {
        $s = self::space($raw);
        $s = preg_replace('/^(?:дом\.?|д\.|д|№|#)(?:\s+|(?=\d))/iu', '', $s) ?? $s;
        $s = self::space($s);
        return ['name' => $s !== '' ? $s : self::space($raw)];
    }

    /**
     * Тип ВХОДИТ в ключ: «Ленина ул.» и «Ленина пр-кт» — разные улицы
     * одного города. Ключ без типа склеил бы их, и бригада уехала бы
     * не на тот лифт.
     */
    public static function streetKey(string $raw): string
    {
        $p = self::parseStreet($raw);
        return ($p['type'] ?? '') . '|' . self::token($p['name']);
    }

    public static function homeKey(string $raw): string
    {
        return self::token(self::parseHome($raw)['name']);
    }

    /** «20/1» и «д. 20/1» → «д. 20/1». Ровно один маркер, защитно. */
    public static function formatHome(string $raw): string
    {
        $n = self::parseHome($raw)['name'];
        return $n === '' ? '' : 'д. ' . $n;
    }

    public static function formatStreet(string $raw): string
    {
        $p = self::parseStreet($raw);
        if ($p['name'] === '') {
            return '';
        }
        if ($p['type'] === null) {
            return $p['name'];
        }
        $def   = self::TYPES[$p['type']];
        $label = $p['type'] . ($def['pos'] === 'prefix' ? '.' : '');
        return $def['pos'] === 'prefix'
            ? $label . ' ' . $p['name']
            : $p['name'] . ' ' . $label;
    }

    /**
     * Единственная сборка адресной строки. Порядок и разделители
     * фиксированы: расхождение с findObjectByGuid давало ложный
     * guid_mismatch на каждом сигнале.
     *
     * Город не трогаем: «г.» приходит из lift_options.city_default,
     * а «г.» / «деревня» в поле города — отдельная неоднозначность.
     */
    public static function format(string $city, string $street, string $home, string $object): string
    {
        $parts = [];
        foreach ([self::space($city), self::formatStreet($street), self::formatHome($home), self::space($object)] as $p) {
            if ($p !== '') {
                $parts[] = $p;
            }
        }
        return implode(', ', $parts);
    }
}