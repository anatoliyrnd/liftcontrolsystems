<?php
declare(strict_types=1);

namespace App\Service;

use App\Database\DB;
use App\Support\Address;

final class AddressService
{
    public function __construct(private readonly DB $db)
    {
    }

       /**
     * Справочник адресов для клиента (§6). Все четыре уровня, vis = 1.
     *
     * Улица и дом хранятся БЕЗ маркеров: тип улицы живёт в street_type,
     * «д.» не хранится вовсе. Поэтому наружу отдаём два имени:
     *   *_name    — сырое, для поиска и сопоставления;
     *   *_display — с маркерами, для отрисовки.
     *
     * Подменять *_name форматированным нельзя: клиент по нему ищет,
     * а SQL сортирует по чистому имени — «Ленина» встаёт на «Л»,
     * а не на «у» в конце списка. Форматирование в *_name вернуло бы
     * сортировку по префиксу и смешало хранение с отображением.
     *
     * street_type наружу не отдаём осознанно: клиент не должен
     * собирать подпись сам — иначе появится вторая копия форматировщика.
     *
     * Город и лифт не форматируем: «г.» уже внутри city_default,
     * а «п.1 пасс.» — целиком идентичность объекта.
     */
    public function getAddresses(): array
    {
        return [
            'city' => $this->db->fetchAll(
                "SELECT id, city_name FROM lift_city WHERE vis = 1 ORDER BY city_name"
            ),

            'street' => array_map(
                static function (array $r): array {
                    // Защитно: даже если в справочник руками вписали
                    // «ул. Ленина», маркер не задвоится.
                    $r['street_display'] = Address::formatStreet((string) $r['street_name']);
                    return $r;
                },
                $this->db->fetchAll(
                    "SELECT id, street_name, city_id FROM lift_street WHERE vis = 1 ORDER BY street_name"
                )
            ),

            'home' => array_map(
                static function (array $r): array {
                    $r['home_display'] = Address::formatHome((string) $r['home_name']);
                    return $r;
                },
                $this->db->fetchAll(
                    "SELECT id, home_name, street_id FROM lift_home WHERE vis = 1 ORDER BY home_name"
                )
            ),

            'object' => $this->db->fetchAll(
                "SELECT id, object_name, home_id, group_id
                 FROM lift_object
                 WHERE vis = 1
                 ORDER BY object_name"
            ),
        ];
    }
}