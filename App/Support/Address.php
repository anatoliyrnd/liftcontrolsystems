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
 * ё/е не сворачиваем: это могут быть разные улицы.
 */
final class Address
{
    /**
     * Маркер дома при форматировании. В БД его нет никогда.
     *
     * Пробел после «д.» — новое решение: прежний формат «д.5» склеивал
     * маркер с номером, а пульт сам шлёт «д. 20/1». Примеры fullAddress
     * в API_PROTOCOL §5/§7 обновить вместе с выкаткой.
     */
    public const HOME_PREFIX = 'д. ';
/** Типы населённых пунктов. Ключ — код в lift_city.city_type. */
        /** Типы населённых пунктов. Ключ — код в lift_city.city_type. */
    public const CITY_TYPES = [
        'г'   => 'г. ',
        'п'   => 'п. ',
        'пгт' => 'пгт ',
        'с'   => 'с. ',
        'д'   => 'д. ',
        'х'   => 'х. ',
        'ст'  => 'ст-ца ',
    ];

    /**
     * Подпись н.п. Тип — данные (city_type), не константа форматировщика.
     * Пустой/неизвестный тип → «н.п.»: честная общая подпись вместо
     * угадывания «г.'. Если имя уже несёт маркер (до миграции) — тип
     * выводится из него. В sort_key тип не входит никогда.
     */
    public static function formatCity(string $name, ?string $type = null): string
    {
        $n = self::plain($name);
        if ($n === '') return '';

        $code = trim((string) $type);
        if ($code === '' && preg_match('/^(г|п|пгт|с|д|х|ст-ца)\.?\s/u', $n, $m)) {
            $code = $m[1];
        }
        // Страховка от двойного маркера: имя могло сохраниться с «г.»
        // (lift_options.city_default исторически был частью значения).
        $stripped = preg_replace('/^(?:г|п|пгт|с|д|х|ст-ца|н\.п\.)\.?\s+/u', '', $n);
        if (is_string($stripped) && $stripped !== '') $n = $stripped;

        return (self::CITY_TYPES[$code] ?? 'н.п. ') . $n;
    }

    /**
     * Display-подпись адреса для call_adres и справочника.
     * НЕ используется в guid-пути: там остаётся format() (plain).
     */
       public static function formatDisplay(
        string $city,
        string $street,
        string $home,
        string $object,
        ?string $cityType = null,
        ?string $streetType = null
    ): string {
        $parts = array_filter([
            self::formatCity($city, $cityType),
            self::formatStreet($street, $streetType),
            self::formatHome($home),
            self::plain($object),
        ], static fn (string $p): bool => $p !== '');
        return implode(', ', $parts);
    }
    /**
     * Закрытая карта ходовых типов, а не классификатор ГАР (300+ позиций).
     * Трек А живёт 6–8 месяцев, полный словарь — AddressProvider в Треке Б.
     *
     * pos — позиция при ФОРМАТИРОВАНИИ. При разборе тип принимается
     * с обеих сторон: «ул. Ленина» и «Ленина ул.» — одна улица.
     * Порядок СПульт — их convention для сортировки, а не данные.
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

    /** Кэш алиас → канонический тип. Строится один раз на процесс. */
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

    /**
     * Только пробелы: NBSP в справочнике встречается, а \s без /u его
     * не берёт. Используется для города и названия лифта — у них нет
     * ни типов, ни маркеров, терять символы нельзя.
     */
    public static function plain(string $raw): string
    {
        return self::space($raw);
    }

    /**
     * Ключ для полей без типов (город, лифт). Эквивалент того, что
     * раньше делал SQL REPLACE: регистр, пробелы, точки.
     */
    public static function plainKey(string $raw): string
    {
        return self::token($raw);
    }

    /**
     * Разбор улицы. Тип принимается и префиксом, и суффиксом.
     *
     * Суффикс разбирается по ПОСЛЕДНЕМУ токену, поэтому порядковое
     * числительное в имени не съедается: «1-я Советская ул.» даёт
     * тип «ул» и имя «1-я Советская», а не «Советская».
     *
     * Неизвестный тип остаётся в названии: не угадываем. Строка
     * попадёт в отчёт/лог на ручной разбор, а не в ложное совпадение.
     *
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
        if ($n > 1) {
            $first = self::token($parts[0]);
            if (isset($map[$first])) {
                $name = self::space(implode(' ', array_slice($parts, 1)));
                if ($name !== '') {
                    return ['type' => $map[$first], 'name' => $name];
                }
            }

            $last = self::token($parts[$n - 1]);
            if (isset($map[$last])) {
                $name = self::space(implode(' ', array_slice($parts, 0, -1)));
                if ($name !== '') {
                    return ['type' => $map[$last], 'name' => $name];
                }
            }
        }

        return ['type' => null, 'name' => $s];
    }

    /**
     * Разбор дома. Маркер снимается ТОЛЬКО ведущий и только здесь.
     *
     * После маркера требуем пробел или цифру: иначе «домовой» потерял
     * бы начало, а одиночная литера «Д» стёрлась бы в пустоту.
     *
     * «корп», «с», дробь и литера — идентичность дома, не мусор:
     * «2 корп.2» остаётся «2 корп.2», а не «2». «30/2 с1» и «66-Б»
     * тоже сохраняются целиком.
     *
     * @return array{name:string}
     */
    public static function parseHome(string $raw): array
    {
        $s = self::space($raw);
        $s = self::space(preg_replace('/^(?:дом\.?|д\.|д|№|#)(?:\s+|(?=\d))/iu', '', $s) ?? $s);

        // Пустой результат означает, что всё поле было маркером.
        // Такое значение терять нельзя — отдаём как есть.
        return ['name' => $s !== '' ? $s : self::space($raw)];
    }

    /**
     * Ключ улицы. Тип ВХОДИТ в ключ: «Ленина ул.» и «Ленина пр-кт» —
     * разные улицы одного города. Ключ без типа склеил бы их, и бригада
     * уехала бы не на тот лифт.
     *
     * Неразобранный тип остаётся частью имени с обеих сторон, поэтому
     * такие строки продолжают совпадать сами с собой.
     */
    public static function streetKey(string $raw): string
    {
        $p = self::parseStreet($raw);
        return ($p['type'] ?? '') . '|' . self::token($p['name']);
    }

    /**
     * Ключ дома. Пробелы и точки снимаются, как в прежнем SQL-ключе,
     * поэтому «2 корп.2» и «2корп2» совпадут, а «2к2» — нет.
     * Нечёткого сравнения не вводим осознанно.
     */
    public static function homeKey(string $raw): string
    {
        return self::token(self::parseHome($raw)['name']);
    }

    /**
     * Ключ СОРТИРОВКИ, не сопоставления: тип улицы и маркер дома сняты.
     * С ними «ул.» соберёт все улицы под «у», а «д.» — все дома под «д»,
     * и вынос типа в street_type потеряет смысл.
     *
     * От streetKey/homeKey отличается осознанно. Там тип улицы входит
     * в ключ («Ленина ул.» и «Ленина пр-кт» — разные улицы), а token()
     * снимает пробелы и точки. Здесь они сохранены: ключ обязан совпадать
     * с клиентским ключом пикера, иначе порядок в таблице разойдётся
     * с порядком в списке адресов на «2 корп.2» и «п.1 пасс.».
     *
     * Разбор через parse*, а не через чистоту БД: легаси-строки и ручная
     * правка справочника продолжат приносить маркеры. parse* уже схлопывают
     * пробелы, поэтому plain() нужен только городу и объекту — у них
     * ни типов, ни маркеров, терять символы нельзя.
     */
    public static function sortKey(string $city, string $street, string $home, string $object): string
    {
        $parts = [
            self::plain($city),
            self::parseStreet($street)['name'],
            self::parseHome($home)['name'],
            self::plain($object),
        ];

        // Пустой компонент не должен давать висящий пробел: «ленина  20/1»
        // и «ленина 20/1» — разные строки для коллатора.
        $parts = array_filter($parts, static fn (string $p): bool => $p !== '');

        return mb_strtolower(implode(' ', $parts), 'UTF-8');
    }

    /** «20/1» и «д. 20/1» → «д. 20/1». Ровно один маркер, защитно. */
    public static function formatHome(string $raw): string
    {
        $n = self::parseHome($raw)['name'];
        return $n === '' ? '' : self::HOME_PREFIX . $n;
    }

        /** Подписи типов улиц. Ключ — код из lift_street.street_type. */
    public const STREET_TYPE_LABELS = [
        'ул' => 'ул. ', 'пер' => 'пер. ', 'пр' => 'пр. ', 'пр-кт' => 'пр. ',
        'проспект' => 'пр. ', 'мкр' => 'мкр. ', 'ш' => 'ш. ', 'шоссе' => 'ш. ',
        'б-р' => 'б-р ', 'бульвар' => 'б-р ', 'пл' => 'пл. ', 'площадь' => 'пл. ',
        'наб' => 'наб. ', 'туп' => 'туп. ', 'проезд' => 'пр-д ', 'аллея' => 'аллея ',
    ];

    /**
     * Подпись улицы. Тип приходит из lift_street.street_type; если пуст —
     * защитно разбираем сырую строку (легаси-строки с маркером внутри).
     * Неизвестный код берём как есть без точки, чтобы не выдумывать «ул.».
     * sort_key и guid-путь (format) эту функцию не используют для типа:
     * там имя уже чистое, parseStreet вернёт его без изменений.
     */
    public static function formatStreet(string $name, ?string $type = null): string
    {
        $p = self::parseStreet($name);
        $base = $p['name'] !== '' ? $p['name'] : trim($name);
        if ($base === '') return '';

        $code = trim((string) $type);
        if ($code === '') $code = (string) ($p['type'] ?? '');
        if ($code === '') return $base;

        $label = self::STREET_TYPE_LABELS[$code] ?? $code . ' ';
        return $label . $base;
    }

    /**
     * Единственная сборка адресной строки. Порядок и разделители
     * фиксированы: две копии формата расходились и давали ложный
     * guid_mismatch на каждом сигнале.
     *
     * Город не нормализуем по типам: «г.» приходит из
     * lift_options.city_default и является частью значения,
     * а «г.» / «деревня» в поле города — отдельная неоднозначность.
     */
    public static function format(string $city, string $street, string $home, string $object): string
    {
        $parts = [];
        foreach ([
            self::plain($city),
            self::formatStreet($street),
            self::formatHome($home),
            self::plain($object),
        ] as $p) {
            if ($p !== '') {
                $parts[] = $p;
            }
        }
        return implode(', ', $parts);
    }

    private static function space(string $s): string
    {
        $s = str_replace("\u{00A0}", ' ', trim($s));
        return trim(preg_replace('/\s+/u', ' ', $s) ?? $s);
    }

    private static function token(string $s): string
    {
        return str_replace([' ', '.'], '', mb_strtolower(self::space($s), 'UTF-8'));
    }
}