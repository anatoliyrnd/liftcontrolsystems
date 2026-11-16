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

    /**
     * Ищет пользователя по токену.
     * ВХОДЯЩИЙ ТОКЕН ХЭШИРУЕТСЯ, так как в БД лежит только хэш.
     */
    public function findByApiToken(string $token): ?array
    {
        $hash = hash('sha256', $token);
        return $this->db->fetchOne("SELECT * FROM lift_users WHERE api_token = :token LIMIT 1", ['token' => $hash]);
    }

    /**
     * Обновляет токен.
     * В БД ЗАПИСЫВАЕТСЯ ХЭШ, а не сам токен.
     */
    public function updateApiToken(int $userId, string $rawToken, int $expires, string $webgl): void
    {
        $hash = hash('sha256', $rawToken);
        $sql = "UPDATE lift_users SET api_token = :token, api_token_expires = :expires, webgl_info_spa = :webgl WHERE user_id = :id";
        $this->db->execute($sql, ['token' => $hash, 'expires' => $expires, 'webgl' => $webgl, 'id' => $userId]);
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
     * Ищет пользователя по Refresh-токену.
     *
     * УДАЛИТЬ на шаге 6 вместе с переходом AuthController на
     * rotateRefreshToken(): метод не различает ротированный токен и
     * живой, то есть допускает многократное использование одного
     * refresh — ровно то, что закрывает ротация. Оставлен, чтобы этот
     * файл можно было выкатить отдельно и не сломать текущий refresh.
     */
    public function findByRefreshToken(string $rawToken): ?array
    {
        $hash = hash('sha256', $rawToken);
        $sql = "SELECT u.* FROM lift_users u 
                JOIN lift_refresh_tokens rt ON u.user_id = rt.user_id 
                WHERE rt.token_hash = :hash AND rt.expires_at > NOW() LIMIT 1";
        return $this->db->fetchOne($sql, ['hash' => $hash]);
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
                Logger::warning('Refresh вне grace-окна: семья отозвана', [
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
            if ($this->claimRefreshToken($hash, $userId, $newRaw, $webgl, $familyId)) {
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
     */
    private function readRefreshToken(string $hash): ?array
    {
        return $this->db->fetchOne(
            "SELECT user_id, family_id, rotated_at, replaced_by,
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
     * UPDATE условный (rotated_at IS NULL): из двух параллельных
     * запросов ровно один станет владельцем ротации.
     *
     * Факт владения проверяем повторным чтением replaced_by, а не
     * rowCount: обёртка DB его не гарантирует (тот же приём, что в
     * CallRepository::bindSpultGuid). Без проверки проигравший запрос
     * решил бы, что ротировал он, и отдал бы клиенту токен-сироту.
     *
     * Транзакция обязательна: UPDATE без INSERT оставил бы токен
     * погашенным без преемника, и клиент вышел бы на логин по истечении
     * grace-окна. Пара должна примениться целиком или не примениться.
     */
    private function claimRefreshToken(
        string $hash,
        int $userId,
        string $newRaw,
        string $webgl,
        string $familyId
    ): bool {
        $newHash = hash('sha256', $newRaw);

        $this->db->beginTransaction();
        try {
            $this->db->execute(
                "UPDATE lift_refresh_tokens
                 SET rotated_at = NOW(), replaced_by = :new_hash, last_used_at = NOW()
                 WHERE token_hash = :hash AND rotated_at IS NULL",
                ['new_hash' => $newHash, 'hash' => $hash]
            );
            $this->insertRefreshToken($userId, $newRaw, $webgl, $familyId);
            $this->db->commit();
        } catch (\Throwable $e) {
            $this->db->rollBack();
            throw $e;
        }

        $after = $this->db->fetchOne(
            "SELECT replaced_by FROM lift_refresh_tokens WHERE token_hash = :hash",
            ['hash' => $hash]
        );

        return $after && (string) $after['replaced_by'] === $newHash;
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
     * Только refresh: access дотекает свои 2 часа (решение 2), а
     * presented access удаляет контроллер при logout.
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
     * Удалить Refresh-токен (при логауте)
     */
    public function deleteRefreshToken(string $rawToken): void
    {
        $hash = hash('sha256', $rawToken);
        $this->db->execute(
            "DELETE FROM lift_refresh_tokens WHERE token_hash = :hash",
            ['hash' => $hash]
        );
    }
}