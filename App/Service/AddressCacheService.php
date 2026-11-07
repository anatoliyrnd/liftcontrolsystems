<?php
declare(strict_types=1);

namespace App\Service;

use App\Database\DB;

/**
 * Сервис для управления кэшем адресов и версиями справочников
 * При изменении данных инкрементирует числовую версию слоя
 */
final class AddressCacheService
{
    public function __construct(private readonly DB $db)
    {
    }

    /**
     * Внутренний метод для атомарного инкремента версии слоя
     */
    private function increment(string $dictName): void
    {
        $this->db->execute(
            "UPDATE lift_dict_versions
             SET version = version + 1, updated_at = UNIX_TIMESTAMP()
             WHERE dict_name = :name",
            ['name' => $dictName]
        );
    }

    /**
     * Инкрементировать версию адресного справочника
     */
    public function invalidateCache(): void
    {
        $this->increment('addresses');
    }

    /**
     * Инкрементировать версию справочника сотрудников
     */
    public function invalidateStaff(): void
    {
        $this->increment('staff');
    }

    /**
     * Инкрементировать версию словарей (отделы, типы, группы)
     */
    public function invalidateDicts(): void
    {
        $this->increment('dicts');
    }

    /**
     * Инкрементировать версию слоя активных и закрытых заявок
     */
    public function invalidateTickets(): void
    {
        $this->increment('tickets');
    }

    /**
     * Получить текущие числовые версии всех слоев данных
     * @return array{staff: int, dicts: int, addresses: int, tickets: int}
     */
    public function getVersions(): array
    {
        $rows = $this->db->fetchAll(
            "SELECT dict_name, version FROM lift_dict_versions"
        );

        $versions = ['staff' => 0, 'dicts' => 0, 'addresses' => 0, 'tickets' => 0];
        foreach ($rows as $row) {
            $versions[$row['dict_name']] = (int) $row['version'];
        }

        return $versions;
    }

    /**
     * Определить, какие слои данных устарели относительно версий клиента
     * @param array $clientVersions Версии клиента {staff: int, dicts: int, addresses: int, tickets: int}
     * @return array Массив устаревших ключей ['addresses', 'tickets', ...]
     */
      /**
     * Определить, какие слои данных устарели относительно версий клиента
     * @param array $clientVersions Версии клиента {staff: int, dicts: int, addresses: int, open_tickets: int}
     * @return array Массив устаревших ключей ['addresses', 'open_tickets', ...]
     */
    public function getOutdated(array $clientVersions): array
    {
        $serverVersions = $this->getVersions(); // Здесь уже лежит 'open_tickets'
        $outdated = [];

        foreach ($serverVersions as $key => $serverVer) {
            $clientVer = $clientVersions[$key] ?? 0; // Фронтенд передаст localVersions.open_tickets
            if ($serverVer > $clientVer) {
                $outdated[] = $key; // В массив упадет 'open_tickets'
            }
        }

        return $outdated;
    }

}
