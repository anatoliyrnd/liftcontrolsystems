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

    // -----------------------------------------------------------------------
    // Ограничение попыток входа (§19.1, §20)
    // -----------------------------------------------------------------------

    /**
     * Состояние защиты от перебора для аккаунта.
     *
     * Ключ — АККАУНТ, а не IP. Один и тот же диспетчер заходит из дома,
     * с работы и с мобильной сети: лимит по адресу запирал бы его own
     * входом с другой точки. Колонки login_attempts / locked_until
     * заведены именно под это, их комментарии в DDL описывают алгоритм.
     *
     * Компромисс осознан: зная логин, злоумышленник может намеренно
     * запереть чужой аккаунт на окно блокировки. Короткое окно (15 мин)
     * и требование знать логин делают это дороже, чем неограниченный
     * перебор пароля, который был до этого.
     *
     * Остаток окна считается в SQL, а не в PHP: locked_until пишется
     * через NOW(), значит и сравнивать его надо с NOW(). Иначе вернулся
     * бы TZ-скос между зоной PHP и зоной сессии MySQL.
     *
     * @return array{attempts:int,is_locked:bool,retry_after:int}|null
     */
    public function findLoginGuard(int $userId): ?array
    {
        $row = $this->db->fetchOne(
            "SELECT login_attempts,
                    (locked_until IS NOT NULL AND locked_until > NOW()) AS is_locked,
                    GREATEST(0, TIMESTAMPDIFF(SECOND, NOW(), COALESCE(locked_until, NOW()))) AS retry_after
             FROM lift_users
             WHERE user_id = :uid
             LIMIT 1",
            ['uid' => $userId]
        );

        if ($row === null) {
            return null;
        }

        return [
            'attempts'    => (int) $row['login_attempts'],
            'is_locked'   => (bool) $row['is_locked'],
            // Минимум 1 при активной блокировке: ноль клиент прочитал бы
            // как «можно сразу» и повторил бы в тот же тик.
            'retry_after' => (bool) $row['is_locked'] ? max(1, (int) $row['retry_after']) : 0,
        ];
    }

    /**
     * Зафиксировать неверный пароль. Атомарно, одним UPDATE.
     *
     * Счётчик инкрементится в SQL, а не читается-пишется из PHP: два
     * параллельных запроса иначе прочитали бы 4, каждый записал 5 —
     * и порог сработал бы на попытку позже реальной.
     *
     * ПОРЯДОК ПРИСВАИВАНИЙ ЗНАЧИМ. MySQL/MariaDB вычисляет SET слева
     * направо, и правая часть последующих присваиваний видит уже НОВОЕ
     * значение ранее присвоенной колонки. Поэтому:
     *   - login_attempts первым: читает СТАРЫЕ locked_until и
     *     login_attempts, даёт новый счётчик (1 после истечения окна,
     *     иначе старый + 1);
     *   - locked_until вторым: читает УЖЕ НОВЫЙ счётчик и старый
     *     locked_until.
     * Обратный порядок дал бы off-by-one в пороге и сброс не там.
     *
     * Активная блокировка не продлевается: WHERE отсекает строку, пока
     * locked_until в будущем. Иначе каждая новая попытка сдвигала бы
     * окно, и аккаунт оставался бы заперт бессрочно, пока идёт перебор.
     *
     * Истёкшее окно обнуляет счётчик (ветка THEN 1) и чистит locked_until
     * в NULL: отсидевший блокировку пользователь не должен запираться
     * снова с первой опечатки, а NULL — единственное «не заблокирован»
     * по semantics колонки.
     *
     * @param int $maxAttempts порог из AuthService — политика там, где TTL
     * @param int $lockSeconds длительность блокировки, секунды
     */
    public function recordLoginFailure(int $userId, int $maxAttempts, int $lockSeconds): void
    {
        $this->db->execute(
            "UPDATE lift_users
                SET login_attempts = CASE
                        WHEN locked_until IS NOT NULL AND locked_until <= NOW() THEN 1
                        ELSE login_attempts + 1
                    END,
                    locked_until = CASE
                        WHEN login_attempts >= :max_attempts THEN NOW() + INTERVAL :lock_sec SECOND
                        WHEN locked_until IS NOT NULL AND locked_until <= NOW() THEN NULL
                        ELSE locked_until
                    END
              WHERE user_id = :uid
                AND (locked_until IS NULL OR locked_until <= NOW())",
            [
                'max_attempts' => $maxAttempts,
                'lock_sec'     => $lockSeconds,
                'uid'          => $userId,
            ]
        );
    }

    /**
     * Успешный вход сбрасывает счётчик и блокировку.
     *
     * Без сброса серия опечаток копилась бы через дни: четыре ошибки
     * в понедельник и одна во вторник дали бы блокировку, хотя пароль
     * введён верно.
     *
     * WHERE отсекает холостые записи: у большинства входов счётчик уже
     * нулевой, а login — горячий путь. Лишний UPDATE на каждый вход
     * брал бы блокировку строки lift_users без всякой пользы.
     */
    public function resetLoginAttempts(int $userId): void
    {
        $this->db->execute(
            "UPDATE lift_users
                SET login_attempts = 0,
                    locked_until   = NULL
              WHERE user_id = :uid
                AND (login_attempts > 0 OR locked_until IS NOT NULL)",
            ['uid' => $userId]
        );
    }

    /**
     * Сохранить раздельное ФИО и отображаемое имя (§13.4).
     *
     * ЧЕТЫРЕ КОЛОНКИ ОДНИМ ЗАПРОСОМ. user_name — производное от
     * компонентов: разнеси мы их на два UPDATE, между ними читатель
     * увидел бы новую фамилию со старой подписью. В шапке одно, в
     * списке ответственных другое, и понять, какое верно, нельзя.
     * Один UPDATE атомарен сам по себе — транзакция для этого не нужна.
     *
     * Транзакция нужна ВЫЗЫВАЮЩЕМУ: профиль + пароль + настройки
     * колонок обязаны лечь вместе. Здесь только запись.
     *
     * rowCount не проверяем намеренно: PDO::MYSQL_ATTR_FOUND_ROWS = false,
     * поэтому сохранение НЕИЗМЕНЁнного ФИО даёт 0 изменённых строк.
     * Ноль здесь не означает «пользователя нет» — существование
     * проверено сервисом через findById до вызова.
     *
     * Пустое отчество пишем NULL, не '': formatUser и get_user_settings
     * отдают null, и два разных «пусто» в колонке разошлись бы при
     * следующем чтении.
     *
     * Никаких role / position / флагов / login здесь нет и быть не
     * должно: смена профиля иначе стала бы повышением привилегий.
     *
     * @throws \LogicException фамилия или имя пусты — ошибка программиста,
     *                         не ввод пользователя. Валидация ввода
     *                         (обязательность, белый список символов)
     *                         живёт в ProfileService и даёт invalid_profile.
     */
    public function updateProfile(int $userId, string $surname, string $firstname, ?string $patronymic): void
    {
        $surname    = trim($surname);
        $firstname  = trim($firstname);
        $patronymic = trim((string) $patronymic);

        if ($surname === '' || $firstname === '') {
            throw new \LogicException(
                'updateProfile: фамилия и имя обязательны. '
                . 'Проверка ввода — в ProfileService, сюда пустые значения доходить не должны.'
            );
        }

        $this->db->execute(
            "UPDATE lift_users
                SET user_surname    = :surname,
                    user_firstname  = :firstname,
                    user_patronymic = :patronymic,
                    user_name       = :display_name
              WHERE user_id = :uid",
            [
                'surname'      => $surname,
                'firstname'    => $firstname,
                'patronymic'   => $patronymic === '' ? null : $patronymic,
                'display_name' => self::composeDisplayName($surname, $firstname, $patronymic),
                'uid'          => $userId,
            ]
        );
    }

    /**
     * Владелец формата отображаемого имени: «Фамилия И.О.»
     *
     * Фамилия целиком, пробел, инициал имени, инициал отчества при
     * наличии. Точки после каждого инициала, между инициалами пробела
     * нет: «Ковалёв А.П.», без отчества — «Ковалёв А.».
     *
     * Публичный статический, как CallRepository::normalizeGuid: формат
     * принадлежит одному месту, а потребителю не нужен экземпляр
     * репозитория. Админка, импорт и генератор демо обязаны звать этот
     * метод, а не собирать строку заново — две копии формата уже
     * расходились в адресном слое (Address::format vs formatDisplay).
     *
     * Обрезка не нужна: фамилия ограничена колонкой varchar(100),
     * инициалы добавляют максимум 4 символа, user_name — varchar(200).
     *
     * Массового пересчёта существующих строк НЕТ намеренно: у легаси
     * компоненты NULL, и пересборка затёрла бы имена в пустоту —
     * все стали бы «Сотрудник №N». Миграция ленивая, при сохранении
     * профиля.
     */
    public static function composeDisplayName(string $surname, string $firstname, ?string $patronymic): string
    {
        $surname = trim($surname);

        $initials = self::initial($firstname) . self::initial((string) $patronymic);

        return $initials === '' ? $surname : $surname . ' ' . $initials;
    }

    /**
     * Первая буква с точкой.
     *
     * mb_, а не substr/strtoupper: кириллица двухбайтная, побайтовый
     * срез дал бы половину символа и  вместо буквы. Кодировка
     * задана явно — иначе результат зависел бы от mb_internal_encoding
     * хостера.
     *
     * Дефисное имя («Анна-Мария») даёт один инициал «А.» — по первой
     * букве, как и принято.
     */
    private static function initial(string $part): string
    {
        $part = trim($part);
        if ($part === '') {
            return '';
        }

        return mb_strtoupper(mb_substr($part, 0, 1, 'UTF-8'), 'UTF-8') . '.';
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

            $userId   = (int) $row['user_id'];
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
                    'ip'      => $_SERVER['REMOTE_ADDR'] ?? '',
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
     * Факт владения проверяем чтением replaced_by ВНУТРИ транзакции:
     * снаружи между коммитом и чтением строку забрал бы другой запрос,
     * и мы получили бы ложный отказ на ровном месте.
     *
     * ПОПРАВКА К ПРЕЖНЕМУ КОММЕНТАРИЮ: DB::execute возвращает rowCount,
     * обёртка его отдаёт. Здесь он тоже дал бы верный ответ — WHERE
     * содержит CAS-предикат, поэтому и «изменённые», и «подошедшие»
     * строки означают победу. Чтение оставлено как есть сознательно:
     * путь рабочий и деликатный, замена — отдельной правкой, не вместе
     * с профилем. Вынесено в техдолг.
     *
     * Преемник вставляется только после подтверждённого владения и в той
     * же транзакции: UPDATE без INSERT оставил бы токен погашенным без
     * преемника, INSERT без владения — токен-сироту на 30 дней.
     */
    private function claimRefreshToken(string $hash, array $row, string $newRaw, string $webgl): bool
    {
        $newHash  = hash('sha256', $newRaw);
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
                'uid'     => $userId,
                'hash'    => hash('sha256', $rawToken),
                'family'  => $familyId,
                'webgl'   => $webgl,
                'expires' => time() + AuthService::REFRESH_TTL,
                // user_ip — varchar(45), IPv6 помещается целиком.
                'ip'      => $_SERVER['REMOTE_ADDR'] ?? '',
                // Кодировка явно: колонка varchar(255) считает символы,
                // без аргумента обрезка зависела бы от mb_internal_encoding.
                'ua'      => mb_substr($_SERVER['HTTP_USER_AGENT'] ?? '', 0, 255, 'UTF-8'),
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
     * Отозвать ВСЕ семьи пользователя, кроме указанной — при смене пароля.
     *
     * Смена пароля обязана выбросить остальные устройства: иначе
     * украденный пароль оставляет вору живые сессии на 30 дней, и
     * смена пароля не лечит компрометацию, ради которой её и делают.
     *
     * Текущая семья сохраняется — пользователь не разлогинивается
     * на том устройстве, где меняет пароль. Определить её можно
     * ТОЛЬКО по cookie lift_refresh: в lift_access_tokens нет
     * family_id, связать access с семьёй нечем.
     *
     * $keepFamilyId = null (cookie нет) → отзываем ВСЕ. Это цена
     * безопасности, а не дефект: без опознавателя текущей сессии
     * выбор стоит между «выбросить всех, включая себя» и «оставить
     * вора». Перелогин дешевле второй вариант.
     */
    public function revokeOtherRefreshFamilies(int $userId, ?string $keepFamilyId): void
    {
        if ($keepFamilyId === null || $keepFamilyId === '') {
            $this->db->execute(
                "DELETE FROM lift_refresh_tokens WHERE user_id = :uid",
                ['uid' => $userId]
            );
            return;
        }

        $this->db->execute(
            "DELETE FROM lift_refresh_tokens WHERE user_id = :uid AND family_id <> :family",
            ['uid' => $userId, 'family' => $keepFamilyId]
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
        // Та же причина, что в insertRefreshToken: иначе access живёт
        // на 3 часа дольше AuthService::ACCESS_TTL.
        $this->db->execute(
            "INSERT INTO lift_access_tokens (token_hash, user_id, expires_at)
             VALUES (:hash, :user_id, FROM_UNIXTIME(:expires))",
            [
                'hash'    => hash('sha256', $rawToken),
                'user_id' => $userId,
                'expires' => $expiresAt,
            ]
        );
    }

    /**
     * Найти пользователя по Access-токену
     */
    public function findByAccessToken(string $rawToken): ?array
    {
        $sql = "SELECT u.* FROM lift_users u
                JOIN lift_access_tokens a ON u.user_id = a.user_id
                WHERE a.token_hash = :hash AND a.expires_at > NOW() LIMIT 1";

        return $this->db->fetchOne($sql, ['hash' => hash('sha256', $rawToken)]);
    }

    /**
     * Удалить конкретный Access-токен (при логауте)
     */
    public function deleteAccessToken(string $rawToken): void
    {
        $this->db->execute(
            "DELETE FROM lift_access_tokens WHERE token_hash = :hash",
            ['hash' => hash('sha256', $rawToken)]
        );
    }

    /**
     * Погасить access-токены пользователя, кроме предъявленного.
     *
     * Смена пароля: чужие access обязаны умереть немедленно, свой —
     * продолжить работать, иначе вкладка, в которой человек меняет
     * пароль, получит 401 на следующем же запросе и выглядит как
     * «смена пароля меня разлогинила».
     *
     * $keepRawToken = null → удалить все. Тот же выбор, что в
     * revokeOtherRefreshFamilies: без опознавателя своей сессии
     * безопаснее выбросить всех.
     */
    public function deleteOtherAccessTokens(int $userId, ?string $keepRawToken): void
    {
        if ($keepRawToken === null || $keepRawToken === '') {
            $this->db->execute(
                "DELETE FROM lift_access_tokens WHERE user_id = :uid",
                ['uid' => $userId]
            );
            return;
        }

        $this->db->execute(
            "DELETE FROM lift_access_tokens WHERE user_id = :uid AND token_hash <> :hash",
            ['uid' => $userId, 'hash' => hash('sha256', $keepRawToken)]
        );
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
     *
     * Реализовано как null-случай deleteOtherAccessTokens: два DELETE
     * с чуть разным WHERE — ровно те две копии, которые расходятся
     * при первой же правке.
     */
    public function deleteAccessTokensByUser(int $userId): void
    {
        $this->deleteOtherAccessTokens($userId, null);
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
     * user_name после сохранения профиля — «Фамилия И.О.». Полные тёзки
     * дают одинаковую строку и в списке неразличимы; это существующий
     * долг, формат его не создаёт и не лечит.
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

            // user_name — собранное имя, а не просто имя: двух Иванов
            // нужно различать в списке. Фамилия/имя — фолбэк для
            // легаси-записей, где компоненты есть, а user_name пуст.
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