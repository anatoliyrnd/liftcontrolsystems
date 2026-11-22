<?php

declare(strict_types=1);

namespace App\Repository;

use App\Database\DB;

/**
 * Персональные настройки колонок (lift_user_settings).
 *
 * Отдельный репозиторий, а не методы UserRepository: другая таблица,
 * другой предмет и другой инвариант — атомарное слияние по scope.
 * UserRepository отвечает за учётную запись и токены; смешивание
 * дало бы классу две несвязные ответственности и два набора блокировок.
 *
 * ГЛАВНЫЙ ИНВАРИАНТ: сохраняется ОДИН переданный scope, остальные
 * не затрагиваются. Клиент шлёт только текущий журнал
 * ({ open: {order, hidden} }) — перезапись всего JSON стёрла бы
 * настройки close и report, и пользователь терял бы их молча,
 * переключив вкладку.
 *
 * Второй инвариант: чтение-изменение-запись под блокировкой строки.
 * Две вкладки одного пользователя, сохраняющие open и close
 * одновременно, без лока потеряли бы одну из настроек: обе прочитали
 * бы старый JSON и записали свой поверх чужого.
 *
 * JSON_SET не используется намеренно: в MariaDB нет отдельного
 * JSON-типа, функция работает по LONGTEXT и молча вернёт NULL на
 * невалидном содержимом — настройка обнулилась бы без ошибки.
 * Явный лок предсказуем и не зависит от версии сервера.
 *
 * Политика (лимиты размера, белый список scope, права) живёт в
 * ProfileService. Репозиторий принимает уже нормализованные данные
 * и отвечает только за то, чтобы они легли целиком и не потеряли соседей.
 */
final class UserSettingsRepository
{
    /**
     * Разрезы журнала. Плоский легаси-формат мигрирует в 'open' (§13.3).
     * Значение используется только при чтении старых строк — валидацию
     * пришедшего scope делает сервис.
     */
    private const LEGACY_SCOPE = 'open';

    public function __construct(private readonly DB $db)
    {
    }

    /**
     * Настройки пользователя, нормализованные к разрезу по scope.
     *
     * Отсутствие строки — не ошибка и не пустой массив: клиент ждёт
     * объект и читает по ключу scope. Пустой PHP-массив уехал бы в JSON
     * как [], и JS получил бы не то, что ожидает.
     *
     * Блокировка не нужна: чтение не участвует в слиянии, а сохранение
     * перечитывает строку под своим локом.
     *
     * @return array<string, array{order: list<string>, hidden: list<string>}>
     */
    public function readColumnSettings(int $userId): array
    {
        $row = $this->db->fetchOne(
            'SELECT column_settings FROM lift_user_settings WHERE user_id = :uid LIMIT 1',
            ['uid' => $userId]
        );

        return self::normalize($row['column_settings'] ?? null);
    }

    /**
     * Заменить настройки ОДНОГО scope, сохранив остальные.
     *
     * ВЫЗЫВАТЬ ТОЛЬКО ВНУТРИ ТРАНЗАКЦИИ. Без неё лок снимается на
     * каждом запросе, и между чтением и записью вклинивается вторая
     * вкладка — ровно та потеря, ради которой метод написан. Проверка
     * громкая: тихая деградация здесь означала бы порчу данных,
     * которую заметили бы через неделю.
     *
     * @param list<string> $order
     * @param list<string> $hidden
     */
    public function saveScope(int $userId, string $scope, array $order, array $hidden): void
    {
        if (!$this->db->inTransaction()) {
            throw new \LogicException(
                'UserSettingsRepository::saveScope требует транзакции: '
                . 'слияние по scope выполняется под блокировкой строки'
            );
        }

        $this->ensureRow($userId);

        // FOR UPDATE по PRIMARY KEY: строка гарантированно существует
        // после ensureRow, поэтому лок строковый, а не间隙-ный.
        // Идемпотентный INSERT вместо «SELECT, потом INSERT при пустоте»
        // убирает гонку создания: два параллельных сохранения не упрутся
        // в Duplicate entry и не откатят всю транзакцию профиля.
        $row = $this->db->fetchOne(
            'SELECT column_settings FROM lift_user_settings WHERE user_id = :uid FOR UPDATE',
            ['uid' => $userId]
        );

        $all = self::normalize($row['column_settings'] ?? null);

        // Замена целиком, не слияние полей: клиент присылает order и
        // hidden одного scope вместе. Частичное слияние оставило бы
        // скрытые колонки от прошлого порядка, которого уже нет.
        $all[$scope] = [
            'order'  => array_values($order),
            'hidden' => array_values($hidden),
        ];

        $this->db->execute(
            'UPDATE lift_user_settings
                SET column_settings = :json,
                    updated_at      = UNIX_TIMESTAMP()
              WHERE user_id = :uid2',
            [
                // (object): пустой набор scope обязан уехать как {}, а не [].
                // JSON_INVALID_UTF8_SUBSTITUTE — битый байт не должен
                // превращать json_encode в false и записывать пустую строку.
                'json' => (string) json_encode(
                    (object) $all,
                    JSON_UNESCAPED_UNICODE | JSON_INVALID_UTF8_SUBSTITUTE
                ),
                'uid2' => $userId,
            ]
        );
    }

    /**
     * Гарантировать наличие строки, не трогая существующее содержимое.
     *
     * updated_at в ветке UPDATE — намеренно: «пустой UPDATE» вида
     * user_id = user_id не берёт лок в некоторых сценариях и не даёт
     * понять, что строка уже была. Метка времени всё равно перезапишется
     * реальным сохранением ниже, в той же транзакции.
     *
     * PRIMARY KEY(user_id) есть в схеме — ON DUPLICATE KEY работает
     * без отдельного UNIQUE.
     */
    private function ensureRow(int $userId): void
    {
        $this->db->execute(
            'INSERT INTO lift_user_settings (user_id, column_settings, updated_at)
             VALUES (:uid, :json, UNIX_TIMESTAMP())
             ON DUPLICATE KEY UPDATE updated_at = UNIX_TIMESTAMP()',
            ['uid' => $userId, 'json' => '{}']
        );
    }

    /**
     * Хранимое значение → разрез по scope.
     *
     * Обратная совместимость (§13.3): плоский {order, hidden} — это open.
     * Миграция не нужна, формат исправляется при следующем сохранении.
     *
     * Публичный и чистый: тот же разбор нужен сервису для входящего
     * payload. Держать две копии разбора означало бы разойтись на
     * легаси-строках — одна сторона признала бы их плоскими, другая нет.
     *
     * @return array<string, array{order: list<string>, hidden: list<string>}>
     */
    public static function normalize(mixed $raw): array
    {
        if (is_string($raw)) {
            $raw = json_decode($raw, true);
        }
        if (!is_array($raw)) {
            return [];
        }

        // Плоский формат опознаём по наличию order/hidden на верхнем
        // уровне. Пустой объект {} сюда не попадает и остаётся пустым
        // набором scope — это корректное «настроек ещё нет».
        if (array_key_exists('order', $raw) || array_key_exists('hidden', $raw)) {
            $raw = [self::LEGACY_SCOPE => $raw];
        }

        $out = [];
        foreach ($raw as $scope => $cfg) {
            // Ключи scope — строки. Числовой ключ означал бы мусорную
            // строку, а не журнал; молча превращать его в "0" нельзя.
            if (!is_string($scope) || $scope === '' || !is_array($cfg)) {
                continue;
            }

            $out[$scope] = [
                'order'  => self::idList($cfg['order'] ?? null),
                'hidden' => self::idList($cfg['hidden'] ?? null),
            ];
        }

        return $out;
    }

    /**
     * Список идентификаторов колонок.
     *
     * Только строки: число или вложенный массив сломали бы клиентский
     * поиск колонки по id. Пустые отбрасываются, дубли снимаются —
     * повторный id в порядке колонок не определён на клиенте.
     *
     * @return list<string>
     */
    private static function idList(mixed $raw): array
    {
        if (!is_array($raw)) {
            return [];
        }

        $out = [];
        foreach ($raw as $id) {
            if (!is_string($id) || $id === '' || isset($out[$id])) {
                continue;
            }
            $out[$id] = true;
        }

        return array_keys($out);
    }
}