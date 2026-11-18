<?php
declare(strict_types=1);
namespace App\Repository;

use App\Database\DB;
use App\Service\AuthService;
use App\Support\Logger;

final class UserRepository
{
    public function __construct(private readonly DB $db)
    {
    }

    public function findById(int $id): ?array
    {
        return $this->db->fetchOne("SELECT * FROM lift_users WHERE user_id = :id LIMIT 1", ['id' => $id]);
    }

    public function findByLogin(string $login): ?array
    {
        $field = str_contains($login, '@') ? 'user_email' : 'user_login';
        return $this->db->fetchOne("SELECT * FROM lift_users WHERE `$field` = :login LIMIT 1", ['login' => $login]);
    }




    public function updatePasswordHash(int $userId, string $newHash): void
    {
        $this->db->execute("UPDATE lift_users SET user_password = :hash WHERE user_id = :id", ['hash' => $newHash, 'id' => $userId]);
    }

    /**
     * Первый refresh-токен семьи — вызывается при логине.
     *
     * $familyId задаёт вызывающая сторона: семья объединяет всю цепочку
     * преемников одного логина. Отзыв при краже гасит семью целиком,
     * поэтому id обязан быть уникален на логин, а не на пользователя —
     * иначе выход одной вкладки убьёт сессию на другом устройстве.
     *
     * Срок отдаём Unix-секундами и конвертирует MySQL: PHP date()
     * форматирует в Europe/Moscow, а expires_at сравнивается с NOW()
     * в зоне MySQL — расхождение давало токенам лишние 3 часа.
     */
    public function saveRefreshToken(int $userId, string $rawToken, string $webgl, string $familyId): void
    {
        $this->insertRefreshToken($userId, $rawToken, $webgl, $familyId);
    }


     /**
     * Ротация refresh-токена: предъявленный гасится, выпускается преемник.
     *
     * Возвращает status:
     *   ok      — новый токен в new_token, семья продолжена;
     *   invalid — токен не найден или истёк → вход заново;
     *   reuse   — предъявлен ротированный токен вне grace-окна → семья
     *             отозвана, вход заново;
     *   busy    — два параллельных запроса не разрешились за две попытки.
     *
     * Grace-окно нужно не только для гонки вкладок. Если ответ refresh
     * потерян (сеть оборвалась после коммита), cookie остаётся со старым
     * токеном, и следующий refresh предъявит ротированный — без окна это
     * «кража» и отзыв семьи. Локи такой случай не покрывают вообще, он
     * происходит и в одной вкладке.
     *
     * Внутри окна ротация выполняется КАК ОБЫЧНО, с новой cookie. Нельзя
     * «выдать access без ротации»: клиент залипнет на ротированном
     * токене и по истечении окна получит ложную кражу.
     *
     * @return array{status:string,user_id?:int,new_token?:string}
     */
    public function rotateRefreshToken(string $rawToken, string $webgl): array
    {
        $hash = hash('sha256', $rawToken);

        // Две попытки, не цикл: между чтением и записью токен может
        // забрать другой запрос. После второй попытки отдаём busy —
        // клиент повторит, а горячий цикл под нагрузкой недопустим.
        for ($attempt = 0; $attempt < 2; $attempt++) {
            $row = $this->readRefreshToken($hash);
            if (!$row) {
                return ['status' => 'invalid'];
            }

            $userId = (int) $row['user_id'];
            $familyId = (string) $row['family_id'];

            if ($row['rotated_at'] !== null && (int) $row['in_grace'] === 0) {
                $this->revokeRefreshFamily($userId, $familyId);
                // Гасим и выданные access: иначе вор с уже полученным
                // токеном работает ещё 2 часа после того, как кража
                // распознана. Реакция живёт здесь, а не в контроллере:
                // user_id есть только у репозитория, и забывать её
                // в каждом вызывающем месте нельзя.
                $this->deleteAccessTokensByUser($userId);
                Logger::warning('Refresh вне grace-окна: семья отозвана, access погашены', [
                    'user_id' => $userId,
                    'ip' => $_SERVER['REMOTE_ADDR'] ?? '',
                ]);
                return ['status' => 'reuse'];
            }

            if ($row['rotated_at'] !== null) {
                // Штатная гонка вкладок или потерянный ответ. Не ошибка,
                // но частые срабатывания = клиентский лок не работает.
                Logger::info('Refresh в grace-окне: повторная ротация', [
                    'user_id' => $userId,
                ]);
            }

            $newRaw = bin2hex(random_bytes(32));
            // Строка целиком: replaced_by — ожидаемое значение CAS,
            // device_fingerprint — наследство преемнику. Отдельными
            // параметрами список разросся бы до семи и разъехался бы
            // по порядку при первой же правке.
            if ($this->claimRefreshToken($hash, $row, $newRaw, $webgl)) {
                return ['status' => 'ok', 'user_id' => $userId, 'new_token' => $newRaw];
            }
        }

        return ['status' => 'busy'];
    }

    /**
     * Состояние предъявленного токена одним запросом.
     *
     * in_grace считается в SQL, а не в PHP: rotated_at пишет NOW(),
     * значит и сравнивать его надо с NOW(). Иначе вернётся тот же
     * TZ-скос, который лечим в FROM_UNIXTIME, и окно поедет на 3 часа.
     *
     * Истёкший токен не отдаём вовсе: продлевать мёртвую сессию нельзя.
     *
     * replaced_by читаем не для диагностики, а как ожидаемое значение
     * CAS: ротация заявляется, только если владелец не сменился.
     * device_fingerprint нужен преемнику — клиент на refresh его не шлёт.
     */
    private function readRefreshToken(string $hash): ?array
    {
        return $this->db->fetchOne(
            "SELECT user_id, family_id, rotated_at, replaced_by, device_fingerprint,
                    (rotated_at IS NOT NULL
                     AND rotated_at > NOW() - INTERVAL :grace SECOND) AS in_grace
             FROM lift_refresh_tokens
             WHERE token_hash = :hash AND expires_at > NOW()
             LIMIT 1",
            ['hash' => $hash, 'grace' => AuthService::REFRESH_REUSE_GRACE_SEC]
        );
    }
    /**
     * Погасить предъявленный токен и выпустить преемника — атомарно.
     *
     * CAS по replaced_by, а не по признаку «ещё не ротирован»: иначе
     * grace-повтор не мог бы заявиться никогда — токен уже ротирован,
     * условие не выполняется, и сценарий потерянного ответа (ради
     * которого окно и введено) упирался бы в busy, а по истечении окна —
     * в ложную кражу. Проигравший гонку перечитывает строку, видит
     * нового владельца, попадает в grace и заявляется со второй попытки.
     *
     * rotated_at = COALESCE(rotated_at, NOW()) — метка НЕ перезаписывается.
     * Иначе каждый повтор сдвигал бы окно, и украденный токен,
     * предъявляемый раз в 20 секунд, продлевал бы себе grace бесконечно.
     *
     * Факт владения проверяем чтением replaced_by, а не rowCount: обёртка
     * DB его не гарантирует (тот же приём, что в bindSpultGuid). Чтение
     * ВНУТРИ транзакции: снаружи между коммитом и чтением строку забрал
     * бы другой запрос, и мы получили бы ложный отказ на ровном месте.
     *
     * Преемник вставляется только после подтверждённого владения и в той
     * же транзакции: UPDATE без INSERT оставил бы токен погашенным без
     * преемника, INSERT без владения — токен-сироту на 30 дней.
     */
    private function claimRefreshToken(string $hash, array $row, string $newRaw, string $webgl): bool
    {
        $newHash = hash('sha256', $newRaw);
        $expected = $row['replaced_by'] !== null ? (string) $row['replaced_by'] : null;

        // Клиент не шлёт webGL на refresh. Без наследства колонка пустела
        // бы у каждого преемника, и признак устройства терял смысл.
        $fingerprint = $webgl !== '' ? $webgl : (string) ($row['device_fingerprint'] ?? '');

        $this->db->beginTransaction();
        try {
            $this->db->execute(
                "UPDATE lift_refresh_tokens
                 SET rotated_at = COALESCE(rotated_at, NOW()),
                     replaced_by = :new_hash,
                     last_used_at = NOW()
                 WHERE token_hash = :hash
                   AND replaced_by <=> :expected
                   AND expires_at > NOW()",
                ['new_hash' => $newHash, 'hash' => $hash, 'expected' => $expected]
            );

            $after = $this->db->fetchOne(
                "SELECT replaced_by FROM lift_refresh_tokens WHERE token_hash = :hash",
                ['hash' => $hash]
            );

            if (!$after || (string) $after['replaced_by'] !== $newHash) {
                // CAS не прошёл: владелец сменился. Откатываем — преемника
                // не создаём, вызывающий перечитает строку и повторит.
                $this->db->rollBack();
                return false;
            }

            $this->insertRefreshToken(
                (int) $row['user_id'],
                $newRaw,
                $fingerprint,
                (string) $row['family_id']
            );
            $this->db->commit();
        } catch (\Throwable $e) {
            $this->db->rollBack();
            throw $e;
        }

        return true;
    }

    /**
     * INSERT строки refresh — один на логин и на каждую ротацию.
     *
     * Срок жизни преемника считается от текущего момента, а не
     * наследуется: иначе цепочка ротаций унаследовала бы дату первого
     * логина и сессия умерла бы ровно через 30 дней после него.
     */
    private function insertRefreshToken(int $userId, string $rawToken, string $webgl, string $familyId): void
    {
        $this->db->execute(
            "INSERT INTO lift_refresh_tokens
                (user_id, token_hash, family_id, device_fingerprint, expires_at, user_ip, user_agent)
             VALUES (:uid, :hash, :family, :webgl, FROM_UNIXTIME(:expires), :ip, :ua)",
            [
                'uid' => $userId,
                'hash' => hash('sha256', $rawToken),
                'family' => $familyId,
                'webgl' => $webgl,
                'expires' => time() + AuthService::REFRESH_TTL,
                'ip' => $_SERVER['REMOTE_ADDR'] ?? '',
                'ua' => mb_substr($_SERVER['HTTP_USER_AGENT'] ?? '', 0, 255),
            ]
        );
    }

    /**
     * Отозвать семью целиком — при краже и при logout.
     *
     * DELETE, а не пометка: ротированные предки обязаны перестать
     * работать, иначе украденный токен продолжит выпускать access.
     *
     * Только refresh. Access гасится отдельно и по-разному: при logout —
     * предъявленный (остальные дотекают 2 часа, решение 2), при краже —
     * все токены пользователя через deleteAccessTokensByUser().
     */
    public function revokeRefreshFamily(int $userId, string $familyId): void
    {
        $this->db->execute(
            "DELETE FROM lift_refresh_tokens WHERE user_id = :uid AND family_id = :family",
            ['uid' => $userId, 'family' => $familyId]
        );
    }

    /**
     * Найти семью по предъявленному токену — для logout.
     *
     * Без фильтра по срокам: истёкшая cookie тоже должна приводить к
     * чистке всей семьи, иначе ротированные предки останутся в таблице
     * до cron и будут числиться живыми в детекте переиспользования.
     *
     * @return array{user_id:int,family_id:string}|null
     */
    public function findRefreshFamily(string $rawToken): ?array
    {
        $row = $this->db->fetchOne(
            "SELECT user_id, family_id FROM lift_refresh_tokens WHERE token_hash = :hash LIMIT 1",
            ['hash' => hash('sha256', $rawToken)]
        );

        return $row
            ? ['user_id' => (int) $row['user_id'], 'family_id' => (string) $row['family_id']]
            : null;
    }


    /**
     * Сохранить новый Access-токен для устройства
     */
    public function saveAccessToken(int $userId, string $rawToken, int $expiresAt): void
    {
        $hash = hash('sha256', $rawToken);
        // Та же причина, что в insertRefreshToken: иначе access живёт
        // на 3 часа дольше AuthService::ACCESS_TTL.
        $expires = $expiresAt;
        $sql = "INSERT INTO lift_access_tokens (token_hash, user_id, expires_at)
                VALUES (:hash, :user_id, FROM_UNIXTIME(:expires))";

        $this->db->execute($sql, [
            'hash' => $hash,
            'user_id' => $userId,
            'expires' => $expires
        ]);
    }

    /**
     * Найти пользователя по Access-токену
     */
    public function findByAccessToken(string $rawToken): ?array
    {
        $hash = hash('sha256', $rawToken);

        $sql = "SELECT u.* FROM lift_users u 
                JOIN lift_access_tokens a ON u.user_id = a.user_id 
                WHERE a.token_hash = :hash AND a.expires_at > NOW() LIMIT 1";

        return $this->db->fetchOne($sql, ['hash' => $hash]);
    }

    /**
     * Удалить конкретный Access-токен (при логауте)
     */
    public function deleteAccessToken(string $rawToken): void
    {
        $hash = hash('sha256', $rawToken);
        $this->db->execute("DELETE FROM lift_access_tokens WHERE token_hash = :hash", ['hash' => $hash]);
    }
        /**
     * Погасить ВСЕ access-токены пользователя — при обнаружении кражи.
     *
     * Отзыв семьи лишает вора возможности выпустить новый access, но
     * уже выданный живёт до 2 часов. Для logout это осознанный комфорт
     * (решение 2), для подтверждённой кражи — дыра: детект сработал,
     * а вор продолжает работать.
     *
     * Побочный ущерб минимален: на других устройствах семья цела,
     * их access умрёт, клиент получит 401 и обновится своим refresh
     * без разлогина. Перелогинится только скомпрометированное устройство.
     */
    public function deleteAccessTokensByUser(int $userId): void
    {
        $this->db->execute(
            "DELETE FROM lift_access_tokens WHERE user_id = :uid",
            ['uid' => $userId]
        );
    }
    /**
     * Список для быстрого входа по ключу организации (B4.3).
     *
     * Единственный критерий включения — allow_dispatcher_quick_login = 1.
     * Роль НЕ фильтруется намеренно: флаг выставляет админ, он же решает,
     * кто в списке. Дублирующий фильтр по роли обесценил бы флаг для
     * нестандартных должностей и для прораба, нормализованного в dispatcher.
     *
     * Исключения — только те, кто физически не может войти или не должен
     * быть виден: заблокирован, без пароля, скрыт.
     *
     * user_hiden NULLABLE: условие `user_hiden = 0` отсекло бы NULL-строки,
     * то есть все записи, созданные без явного значения — список оказался
     * бы пустым при корректных флагах.
     *
     * Отдаём только id и имя. Логин, телефон, email и роль не отдаём:
     * эндпоинт публичный, список ФИО — уже персональные данные за секретом,
     * расширять утечку нечем. Логин к тому же половина учётных данных,
     * а роль показывает, кто админ — мишень для перебора.
     *
     * LIMIT нет намеренно: штат тенанта — десятки человек, а обрезка
     * списка молча закрыла бы вход части диспетчеров.
     *
     * @return list<array{id:int,name:string}>
     */
    public function listQuickLogin(): array
    {
        $rows = $this->db->fetchAll(
            "SELECT user_id, user_name, user_surname, user_firstname
             FROM lift_users
             WHERE allow_dispatcher_quick_login = 1
               AND user_block <> 1
               AND user_password <> ''
               AND (user_hiden IS NULL OR user_hiden = 0)
             ORDER BY user_name, user_id"
        );

        $list = [];
        foreach ($rows as $r) {
            $id = (int) $r['user_id'];

            // user_name — собранное ФИО, а не имя: двух Иванов нужно
            // различать в списке. Фамилия/имя — фолбэк для легаси-записей.
            $name = trim((string) $r['user_name']);

            if ($name === '') {
                $name = trim(
                    trim((string) ($r['user_surname'] ?? '')) . ' ' .
                    trim((string) ($r['user_firstname'] ?? ''))
                );
            }

            if ($name === '') {
                // Пустая кнопка невыбираема, а молча выкинуть человека
                // из списка — закрыть ему вход без объяснений.
                $name = 'Сотрудник №' . $id;
            }

            $list[] = ['id' => $id, 'name' => $name];
        }

        return $list;
    }

}