<?php
declare(strict_types=1);

namespace App\Service;

use App\Database\DB;

/**
 * Сервис для управления кэшем адресов и версиями справочников
 * При изменении адресов инкрементирует версию, фронтенд узнаёт об этом через notifications endpoint
 */
final class AddressCacheService
{
    public function __construct(private readonly DB $db)
    {
    }

    /**
     * Инкрементировать версию адресного справочника
     * Вызывается при создании новых адресов через СПульт или API
     */
    public function invalidateCache(): void
    {
        $this->db->execute(
            "UPDATE lift_dict_versions 
             SET version = version + 1, updated_at = :now 
             WHERE dict_name = 'addresses'",
            ['now' => time()]
        );
    }

    /**
     * Инкрементировать версию справочника сотрудников
     */
    public function invalidateStaff(): void
    {
        $this->db->execute(
            "UPDATE lift_dict_versions 
             SET version = version + 1, updated_at = :now 
             WHERE dict_name = 'staff'",
            ['now' => time()]
        );
    }

    /**
     * Инкрементировать версию словарей (отделы, типы, группы)
     */
    public function invalidateDicts(): void
    {
        $this->db->execute(
            "UPDATE lift_dict_versions 
             SET version = version + 1, updated_at = :now 
             WHERE dict_name = 'dicts'",
            ['now' => time()]
        );
    }

    /**
     * Получить текущие версии всех справочников
     * @return array{staff: int, dicts: int, addresses: int}
     */
    public function getVersions(): array
    {
        $rows = $this->db->fetchAll(
            "SELECT dict_name, version FROM lift_dict_versions"
        );

        $versions = ['staff' => 0, 'dicts' => 0, 'addresses' => 0];
        foreach ($rows as $row) {
            $versions[$row['dict_name']] = (int) $row['version'];
        }

        return $versions;
    }

    /**
     * Определить, какие справочники устарели относительно версий клиента
     * @param array $clientVersions Версии клиента {staff: int, dicts: int, addresses: int}
     * @return array Массив устаревших ключей ['addresses', 'staff', ...]
     */
    public function getOutdated(array $clientVersions): array
    {
        $serverVersions = $this->getVersions();
        $outdated = [];

        foreach ($serverVersions as $key => $serverVer) {
            $clientVer = $clientVersions[$key] ?? 0;
            if ($serverVer > $clientVer) {
                $outdated[] = $key;
            }
        }

        return $outdated;
    }
}