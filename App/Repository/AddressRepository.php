<?php
declare(strict_types=1);

namespace App\Repository;

use App\Database\DB;

final class AddressRepository
{
    public function __construct(private readonly DB $db)
    {
    }

    /**
     * Получить все активные города
     */
    public function getCities(): array
    {
        return $this->db->fetchAll(
            "SELECT id, city_name FROM lift_city WHERE vis = 1 ORDER BY city_name"
        );
    }

    /**
     * Получить все активные улицы
     */
    public function getStreets(): array
    {
        return $this->db->fetchAll(
            "SELECT id, street_name, city_id FROM lift_street WHERE vis = 1 ORDER BY street_name"
        );
    }

    /**
     * Получить все активные дома
     */
    public function getHomes(): array
    {
        return $this->db->fetchAll(
            "SELECT id, home_name, street_id FROM lift_home WHERE vis = 1 ORDER BY home_name"
        );
    }

    /**
     * Получить все активные лифты
     */
    public function getObjects(): array
    {
        return $this->db->fetchAll(
            "SELECT id, object_name, home_id, group_id FROM lift_object WHERE vis = 1 ORDER BY object_name"
        );
    }

    /**
     * Создать город
     */
    public function createCity(string $name): int
    {
        return $this->db->insert('lift_city', [
            'city_name' => $name,
            'vis' => 1,
        ]);
    }

    /**
     * Создать улицу
     */
    public function createStreet(string $name, int $cityId): int
    {
        return $this->db->insert('lift_street', [
            'street_name' => $name,
            'city_id' => $cityId,
            'vis' => 1,
        ]);
    }

    /**
     * Создать дом
     */
    public function createHome(string $name, int $streetId): int
    {
        return $this->db->insert('lift_home', [
            'home_name' => $name,
            'street_id' => $streetId,
            'vis' => 1,
        ]);
    }

    /**
     * Создать лифт
     */
    public function createObject(string $name, int $homeId, ?string $spultId = null, int $groupId = 1): int
    {
        return $this->db->insert('lift_object', [
            'object_name' => $name,
            'home_id' => $homeId,
            'vis' => 1,
            'abbreviated_name' => $spultId ?? '',
            'group_id' => $groupId,
        ]);
    }
}