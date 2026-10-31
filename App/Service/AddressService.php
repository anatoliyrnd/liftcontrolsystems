<?php
declare(strict_types=1);
namespace App\Service;

use App\Database\DB;

final class AddressService
{
    public function __construct(private readonly DB $db)
    {
    }

    public function getAddresses(): array
    {
        return [
            'city' => $this->db->fetchAll("SELECT id, city_name FROM lift_city WHERE vis=0 ORDER BY city_name"),
            'street' => $this->db->fetchAll("SELECT id, street_name, city_id FROM lift_street WHERE vis=0 ORDER BY street_name"),
            'home' => $this->db->fetchAll("SELECT id, home_name, street_id FROM lift_home WHERE vis=0 ORDER BY home_name"),
            'object' => $this->db->fetchAll("SELECT id, object_name, home_id FROM lift_object WHERE vis=0 ORDER BY object_name")
        ];
    }
}