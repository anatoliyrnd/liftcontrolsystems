<?php
declare(strict_types=1);

namespace App\Service;

use App\Database\DB;

/**
 * Версии слоёв данных для дельта-синхронизации через notifications.
 *
 * Шаг 7 (B2.4): слой заявок разделён на open_tickets и closed_tickets.
 * Причина: единый ключ 'tickets' заставлял клиента перезапрашивать оба
 * списка при любом изменении — закрытие заявки дёргало открытые и наоборот.
 */
final class AddressCacheService
{
    /**
     * Белый список ключей, которые уходят клиенту.
     * Публичный — ApiController и поллер ссылаются на него, чтобы список
     * ключей жил в одном месте, а не в трёх копиях.
     *
     * Legacy 'tickets' сюда НЕ входит: клиент отправляет его только как
     * переходную меру и снимет после выкатки B2.
     */
    public const KEYS = ['staff', 'dicts', 'addresses', 'open_tickets', 'closed_tickets'];

    public function __construct(private readonly DB $db)
    {
    }

    /**
     * Атомарный инкремент одного слоя.
     *
     * Было: чистый UPDATE. Если строки в таблице нет — ноль затронутых
     * строк, версия навсегда остаётся нулевой, клиент каждый тик видит
     * outdated и качает список по кругу.
     *
     * Стало: upsert. Один запрос, атомарно на уровне InnoDB, гонки двух
     * параллельных инкрементов исключены. Требует UNIQUE(dict_name).
     *
     * updated_at пишем через UNIX_TIMESTAMP() — метку даёт MySQL, а не PHP,
     * чтобы она была в той же зоне, что и остальные DATETIME-колонки.
     */
    private function increment(string $key): void
    {
        // Защита от опечатки в вызывающем коде: неизвестный ключ не должен
        // молча создавать мусорную строку в таблице версий.
        if (!in_array($key, self::KEYS, true)) {
            throw new \InvalidArgumentException("Unknown version key: {$key}");
        }

        $this->db->execute(
            "INSERT INTO lift_dict_versions (dict_name, version, updated_at)
             VALUES (:name, 1, UNIX_TIMESTAMP())
             ON DUPLICATE KEY UPDATE
                 version    = version + 1,
                 updated_at = UNIX_TIMESTAMP()",
            ['name' => $key]
        );
    }

    /** Адресный справочник. */
    public function invalidateCache(): void
    {
        $this->increment('addresses');
    }

    /** Справочник сотрудников. */
    public function invalidateStaff(): void
    {
        $this->increment('staff');
    }

    /** Отделы / типы / группы. */
    public function invalidateDicts(): void
    {
        $this->increment('dicts');
    }

    /**
     * Только открытые заявки: calledit, callnote, callnew без solution.
     * Закрытый список эти действия не меняют — не дёргаем его.
     */
    public function invalidateOpenTickets(): void
    {
        $this->increment('open_tickets');
    }

    /**
     * Только закрытые заявки: callnew сразу с solution.
     * Открытый список при этом не меняется.
     */
    public function invalidateClosedTickets(): void
    {
        $this->increment('closed_tickets');
    }

    /**
     * оба списка: callClose (заявка уходит из открытых в закрытые).
     *
     * @deprecated оставлен как алиас, чтобы шаг 7 не сломал CallService,
     *             который пока зовёт его во всех четырёх методах.
     *             На шаге 9 вызовы заменят на точечные по матрице B2.4,
     *             после чего метод можно удалить.
     */
    public function invalidateTickets(): void
    {
        $this->increment('open_tickets');
        $this->increment('closed_tickets');
    }

    /**
     * Текущие версии всех слоёв.
     *
     * Фильтр по белому списку в SQL, а не после выборки: legacy-строка
     * 'tickets' и любой мусор в таблице не должны утекать клиенту.
     *
     * Все пять ключей присутствуют всегда, даже если строки в БД нет —
     * иначе клиент получит undefined вместо 0 и сравнение сломается.
     *
     * @return array<string, int>
     */
    public function getVersions(): array
    {
        $placeholders = implode(',', array_fill(0, count(self::KEYS), '?'));

        $rows = $this->db->fetchAll(
            "SELECT dict_name, version
             FROM lift_dict_versions
             WHERE dict_name IN ($placeholders)",
            self::KEYS
        );

        // Дефолты ДО заполнения: порядок ключей в ответе стабильный,
        // отсутствующая строка даёт 0, а не пропуск ключа.
        $versions = array_fill_keys(self::KEYS, 0);

        foreach ($rows as $row) {
            $versions[$row['dict_name']] = (int) $row['version'];
        }

        return $versions;
    }

    /**
     * Какие слои устарели относительно версий клиента.
     *
     * Обходим серверные ключи, а не клиентские: неизвестный ключ от клиента
     * (например legacy 'tickets') не должен порождать фантомный outdated.
     *
     * @param array<string, mixed> $clientVersions
     * @return list<string>
     */
    public function getOutdated(array $clientVersions): array
    {
        $outdated = [];

        foreach ($this->getVersions() as $key => $serverVer) {
            // Приводим к int: клиент может прислать строку или null.
            $clientVer = (int) ($clientVersions[$key] ?? 0);

            if ($serverVer > $clientVer) {
                $outdated[] = $key;
            }
        }

        return $outdated;
    }
}