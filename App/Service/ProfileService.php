<?php

declare(strict_types=1);

namespace App\Service;

use App\Database\DB;
use App\Exceptions\ApiException;
use App\Http\ErrorCode;
use App\Repository\UserRepository;
use App\Repository\UserSettingsRepository;
use App\Support\DemoGuard;
use App\Support\Logger;
use App\Support\Password;
use App\Support\PasswordChangeLimiter;
use App\Tenant;

/**
 * Профиль и персональные настройки (§13).
 *
 * Три НЕЗАВИСИМЫХ блока одного запроса: profile (ФИО), password,
 * column_settings. Клиент присылает только то, что менял, поэтому
 * отсутствие блока — не «пустое значение», а «не трогать». Разница
 * принципиальна: пустой profile перезаписал бы ФИО пустыми строками.
 *
 * ВСЕ ЗАПИСИ — ОДНОЙ ТРАНЗАКЦИЕЙ. Пароль сменился, а настройки колонок
 * не легли (или наоборот) — состояние, которое пользователь не сможет
 * ни понять, ни повторить: пароль уже новый, а форма показала ошибку.
 *
 * ВАЛИДАЦИЯ ДО ТРАНЗАКЦИИ. Отказ не должен стоить блокировок строк:
 * невалидный ввод — самый частый исход, а lift_users читает ещё и
 * AuthService на каждом запросе.
 *
 * ПРИНИМАЮТСЯ ТОЛЬКО surname / firstname / patronymic и password.
 * Никаких role, position, флагов, login: иначе смена профиля стала бы
 * повышением привилегий — любой диспетчер сделал бы себя админом одним
 * запросом через DevTools.
 *
 * Демо: profile и password запрещены (DemoGuard), настройки колонок
 * разрешены — они персональны и безвредны.
 */
final class ProfileService
{
    /** Минимум по §13.2. Решение сохранено осознанно, не повышаем. */
    private const int MIN_PASSWORD = 6;

    /**
     * Разрезы журнала (§13.3). Белый список, а не «любой ключ»:
     * опечатка в scope иначе молча создала бы четвёртый набор
     * настроек, который клиент никогда не прочитает.
     */
    private const array SCOPES = ['open', 'close', 'report'];

    /**
     * Лимиты column_settings. Набор колонок — клиентская константа
     * (REPORTS.md §8.1), белого списка id на сервере нет и быть не
     * может. Единственная защита от раздувания — размер и форма:
     * longtext вмещает 4 ГБ, а запрос — 10 МБ.
     */
    private const int MAX_JSON_BYTES = 8192;
    private const int MAX_IDS = 100;
    private const int MAX_ID_LEN = 64;

    /**
     * Символы ФИО: буквы любого алфавита, пробел, дефис, апостроф.
     *
     * Проверка закрывает сразу три вещи, отдельных правил не нужно:
     *   - переводы строк: ФИО попадает в lift_history.history_info и
     *     в full_history карточки, где строки разделены \n. Перенос
     *     внутри имени разорвал бы историю на две записи;
     *   - 4-байтные символы: lift_users — utf8mb3, а sql_mode без
     *     STRICT обрежет строку НА этом символе, потеряв хвост молча;
     *   - битую кодировку: /u на невалидном UTF-8 вернёт false.
     *
     * Оба апострофа: iOS подставляет типографский ’ вместо ', и
     * «О’Коннор» с мобильной клавиатуры иначе не прошёл бы.
     *
     * Длину НЕ проверяем: фамилии длиннее 100 символов не бывает, а
     * переполнение обрезал бы сервер — пострадал бы только тот, кто
     * отправил мусор через DevTools. Отдельный путь ошибки под
     * невозможный случай не заводим.
     */
    private const string NAME_PATTERN = "/^[\\p{L} '\\x{2019}\\-]+$/u";

    public function __construct(
        private readonly DB $db,
        private readonly UserRepository $users,
        private readonly UserSettingsRepository $settings,
        private readonly PasswordChangeLimiter $limiter,
        private readonly ?Tenant $tenant
    ) {
    }

    /**
     * Профиль + настройки колонок для экрана профиля.
     *
     * Ответ ПЛОСКИЙ: profile и column_settings рядом со status, не
     * под data. Так требует §13.1 и так читает profile-controller.js
     * (response.profile, response.column_settings).
     *
     * Компоненты ФИО берём из строки БД, а не из $user: formatUser
     * отдаёт name = user_firstname ?: user_name, и у легаси-записи
     * с пустым firstname в поле «Имя» попало бы полное ФИО. Форма
     * обязана показывать компонент, а не фолбэк — иначе первое же
     * сохранение записало бы «Иванов Иван Иванович» в firstname.
     *
     * Роль — из $user: нормализация живёт только в formatUser,
     * сырой user_role отдал бы клиенту 'mechanic' вместо 'engineer'.
     */
    public function getSettings(array $user): array
    {
        $uid = (int) ($user['id'] ?? 0);
        $row = $this->users->findById($uid);

        if ($row === null) {
            // Access жив, а учётной записи уже нет (FK в схеме нет).
            // Сессию надо переустановить, а не показывать пустую форму.
            throw new ApiException(ErrorCode::TokenInvalid, 'Сессия недействительна');
        }

        return [
            'profile' => [
                'id'         => $uid,
                'surname'    => $this->component($row['user_surname'] ?? null),
                'name'       => $this->component($row['user_firstname'] ?? null),
                'patronymic' => $this->component($row['user_patronymic'] ?? null),
                'role'       => (string) ($user['role'] ?? 'guest'),
            ],
            'column_settings' => $this->settings->readColumnSettings($uid),
        ];
    }

    /**
     * Сохранение блоков профиля.
     *
     * @param string|null $currentAccess  Bearer текущего запроса — его сохраняем
     * @param string|null $currentRefresh cookie lift_refresh — по ней определяем семью
     *
     * Оба параметра передаёт контроллер, а не читаем $_COOKIE здесь:
     * сервис не должен зависеть от способа доставки токена, иначе
     * его нельзя вызвать из CLI-разбора или теста.
     */
    public function save(
        array $user,
        array $body,
        ?string $currentAccess = null,
        ?string $currentRefresh = null
    ): array {
        $uid = (int) ($user['id'] ?? 0);
        $row = $this->users->findById($uid);

        if ($row === null) {
            throw new ApiException(ErrorCode::TokenInvalid, 'Сессия недействительна');
        }

        $profile = $this->normalizeProfile($body['profile'] ?? null);
        $password = $this->normalizePassword($body['password'] ?? null);
        $columns = $this->normalizeColumns($body['column_settings'] ?? null);

        // Демо-запрет проверяется после разбора блоков: колонки на демо
        // разрешены, и запрос только с ними не должен отказывать.
        if ($profile !== null || $password !== null) {
            $this->assertProfileAllowed();
        }

        // Проверка старого пароля и лимитер — ДО транзакции: это чтение
        // плюс файловое состояние, откатывать их нечего, а блокировку
        // строки lift_users держать на время bcrypt незачем.
        $newHash = $password !== null
            ? $this->verifyAndHash($uid, $password, (string) ($row['user_password'] ?? ''))
            : null;

        // Семья текущей сессии. Опознаётся ТОЛЬКО по cookie: в
        // lift_access_tokens нет family_id, связать access с семьёй
        // нечем. Чужая семья не сохраняется — сверяем владельца.
        $keepFamily = $newHash !== null ? $this->currentFamily($uid, $currentRefresh) : null;

        if ($profile === null && $newHash === null && $columns === null) {
            // Идемпотентный пустой запрос. Не ошибка: повтор после
            // обрыва связи не должен выглядеть как сбой.
            return ['message' => 'Нет изменений для сохранения.'];
        }

        $this->db->transaction(function () use ($uid, $profile, $newHash, $columns, $keepFamily, $currentAccess): void {
            if ($profile !== null) {
                // user_name пересобирается внутри того же UPDATE, что
                // и компоненты: иначе шапка и подпись ответственного
                // разошлись бы с ФИО на один запрос.
                $this->users->updateProfile(
                    $uid,
                    $profile['surname'],
                    $profile['name'],
                    $profile['patronymic']
                );
            }

            if ($newHash !== null) {
                $this->users->updatePasswordHash($uid, $newHash);

                // Смена пароля обязана выбросить остальные устройства:
                // иначе украденный пароль оставляет вору живые сессии
                // на 30 дней, и смена не лечит компрометацию.
                // Внутри транзакции: откат вернёт и пароль, и сессии.
                $this->users->revokeOtherRefreshFamilies($uid, $keepFamily);
                $this->users->deleteOtherAccessTokens($uid, $currentAccess);
            }

            foreach ($columns ?? [] as $scope => $cfg) {
                // Слияние по scope под блокировкой строки — в репозитории.
                // Клиент шлёт только текущий журнал, остальные наборы
                // обязаны уцелеть.
                $this->settings->saveScope($uid, $scope, $cfg['order'], $cfg['hidden']);
            }
        });

        if ($newHash !== null) {
            Logger::warning('Смена пароля: остальные сессии отозваны', [
                'user_id' => $uid,
                'ip'      => $_SERVER['REMOTE_ADDR'] ?? '',
            ]);
        }

        return ['message' => $this->message($profile !== null, $newHash !== null, $columns !== null)];
    }

    // -----------------------------------------------------------------------
    // Права
    // -----------------------------------------------------------------------

    /**
     * Запрет на демо — целиком на запрос, а не «колонки сохраним,
     * профиль отклоним».
     *
     * Частичный успех ответил бы status:error, но данные записал:
     * клиент не может понять, что легло, и покажет ошибку при
     * фактически сохранённых настройках. Колонки к этому моменту
     * уже применены локально, поэтому от отказа ничего не теряется.
     *
     * Предикат тот же, что выдаёт can_edit_profile в config —
     * флаг и отказ не могут разойтись.
     */
    private function assertProfileAllowed(): void
    {
        if (DemoGuard::canEditProfile($this->tenant?->id ?? '', $this->tenant?->dbName ?? '')) {
            return;
        }

        throw new ApiException(
            ErrorCode::Forbidden,
            'Демо-аккаунт общий: пароль и ФИО менять нельзя. Настройки колонок сохраняются.',
            reason: 'demo_readonly'
        );
    }

    // -----------------------------------------------------------------------
    // Валидация
    // -----------------------------------------------------------------------

    /**
     * @return array{surname:string,name:string,patronymic:string|null}|null
     *         null = блок не передан, его не трогаем
     */
    private function normalizeProfile(mixed $raw): ?array
    {
        if ($raw === null) {
            return null;
        }

        if (!is_array($raw)) {
            throw $this->invalidProfile();
        }

        $surname    = trim((string) ($raw['surname'] ?? ''));
        $name       = trim((string) ($raw['name'] ?? ''));
        $patronymic = trim((string) ($raw['patronymic'] ?? ''));

        // Фамилия и имя обязательны, отчество свободно. Пустое ФИО
        // затёрло бы user_name, и человек стал бы «Сотрудник №N»
        // в списке назначаемых — назначение на него закрылось бы.
        if ($surname === '' || $name === '') {
            throw $this->invalidProfile();
        }

        foreach ([$surname, $name] as $part) {
            $this->assertNamePart($part);
        }
        if ($patronymic !== '') {
            $this->assertNamePart($patronymic);
        }

        return [
            'surname'    => $surname,
            'name'       => $name,
            // Пустое отчество — NULL, не '': formatUser и getSettings
            // отдают null, два разных «пусто» в колонке разошлись бы
            // при следующем чтении.
            'patronymic' => $patronymic !== '' ? $patronymic : null,
        ];
    }

    private function assertNamePart(string $value): void
    {
        if (preg_match(self::NAME_PATTERN, $value) !== 1) {
            throw $this->invalidProfile();
        }
    }

    private function invalidProfile(): ApiException
    {
        return new ApiException(
            ErrorCode::InvalidInput,
            'Фамилия и имя обязательны; допускаются буквы, пробел, дефис и апостроф',
            reason: 'invalid_profile'
        );
    }

    /**
     * @return array{old:string,new:string}|null
     */
    private function normalizePassword(mixed $raw): ?array
    {
        if ($raw === null) {
            return null;
        }

        if (!is_array($raw)) {
            throw new ApiException(
                ErrorCode::InvalidInput,
                'Для смены пароля нужны оба поля',
                reason: 'invalid_password'
            );
        }

        $old = (string) ($raw['old'] ?? '');
        $new = (string) ($raw['new'] ?? '');

        // Пароль не trim-им: пробел по краям может быть частью пароля.
        if ($old === '' || $new === '') {
            throw new ApiException(
                ErrorCode::InvalidInput,
                'Для смены пароля нужны оба поля',
                reason: 'invalid_password'
            );
        }

        if (mb_strlen($new, 'UTF-8') < self::MIN_PASSWORD) {
            throw new ApiException(
                ErrorCode::InvalidInput,
                'Новый пароль короче ' . self::MIN_PASSWORD . ' символов',
                reason: 'password_too_short'
            );
        }

        // Верхнего предела нет намеренно: PASSWORD_BCRYPT обрезает вход
        // на 72 байтах, но Password::verify обрезает так же — вход под
        // длинным паролем продолжает работать. Асимметрии нет, а
        // отдельный код ошибки под это в контракте не предусмотрен.

        return ['old' => $old, 'new' => $new];
    }

    /**
     * Проверка старого пароля с ограничением перебора.
     *
     * Лимит нужен, даже несмотря на Bearer: украденный access живёт
     * два часа, и за это время старый пароль подбирается свободно.
     * Сменив его, вор запирает настоящего владельца снаружи.
     *
     * login_attempts / locked_until для этого НЕ используются:
     * пять опечаток в профиле заблокировали бы ВХОД, а не смену пароля.
     *
     * @return string новый bcrypt-хэш
     */
    private function verifyAndHash(int $uid, array $pass, string $storedHash): string
    {
        $tenantId = $this->tenant?->id ?? 'unknown';

        $retry = $this->limiter->retryAfter($tenantId, $uid);
        if ($retry !== null) {
            throw new ApiException(
                ErrorCode::RateLimited,
                'Слишком много неверных попыток. Повторите позже.',
                reason: 'password_rate_limited',
                details: ['retry_after' => $retry]
            );
        }

        if (!Password::verify($pass['old'], $storedHash)) {
            $this->limiter->recordFailure($tenantId, $uid);

            Logger::warning('Смена пароля: неверный текущий пароль', [
                'user_id' => $uid,
                'ip'      => $_SERVER['REMOTE_ADDR'] ?? '',
            ]);

            throw new ApiException(
                ErrorCode::InvalidInput,
                'Текущий пароль указан неверно',
                reason: 'invalid_password'
            );
        }

        // Успех сбрасывает счётчик: серия опечаток не копится через дни.
        $this->limiter->reset($tenantId, $uid);

        // Тот же Password::hash, что в автомиграции при входе. Свой
        // алгоритм дал бы хэш, который login не проверит.
        return Password::hash($pass['new']);
    }

    /**
     * Семья текущей сессии — чтобы не разлогинить себя же.
     *
     * Владелец сверяется обязательно: cookie может принадлежать другой
     * учётке (общий компьютер), и её семья не должна попасть в
     * исключение — иначе отзыв пройдёт мимо чужих сессий этого
     * пользователя, а мы сохраним не ту.
     *
     * null → репозиторий отзовёт ВСЕ семьи. Без опознавателя своей
     * сессии это безопаснее, чем оставить вора: перелогин дешевле.
     */
    private function currentFamily(int $uid, ?string $refresh): ?string
    {
        if ($refresh === null || $refresh === '') {
            return null;
        }

        $family = $this->users->findRefreshFamily($refresh);

        return ($family !== null && $family['user_id'] === $uid)
            ? $family['family_id']
            : null;
    }

    /**
     * @return array<string, array{order: list<string>, hidden: list<string>}>|null
     */
    private function normalizeColumns(mixed $raw): ?array
    {
        if ($raw === null) {
            return null;
        }

        if (!is_array($raw) || $raw === []) {
            throw $this->invalidColumns();
        }

        // Размер считаем по кодированному виду: колонка хранит JSON,
        // а не PHP-массив, и лимит относится к тому, что ляжет в БД.
        $json = json_encode($raw, JSON_UNESCAPED_UNICODE | JSON_INVALID_UTF8_SUBSTITUTE);
        if ($json === false || strlen($json) > self::MAX_JSON_BYTES) {
            throw $this->invalidColumns();
        }

        $out = [];
        foreach ($raw as $scope => $cfg) {
            if (!is_string($scope) || !in_array($scope, self::SCOPES, true) || !is_array($cfg)) {
                throw $this->invalidColumns();
            }

            $out[$scope] = [
                'order'  => $this->idList($cfg['order'] ?? []),
                'hidden' => $this->idList($cfg['hidden'] ?? []),
            ];
        }

        return $out;
    }

    /**
     * @return list<string>
     */
    private function idList(mixed $raw): array
    {
        if (!is_array($raw) || count($raw) > self::MAX_IDS) {
            throw $this->invalidColumns();
        }

        $out = [];
        foreach ($raw as $id) {
            if (!is_string($id) || $id === '' || mb_strlen($id, 'UTF-8') > self::MAX_ID_LEN) {
                throw $this->invalidColumns();
            }
            $out[] = $id;
        }

        // Дедуп — в репозитории, при нормализации хранимого значения.
        // Здесь сохраняем порядок как пришёл: он и есть настройка.
        return $out;
    }

    private function invalidColumns(): ApiException
    {
        return new ApiException(
            ErrorCode::InvalidInput,
            'Некорректные настройки колонок',
            reason: 'invalid_column_settings'
        );
    }

    // -----------------------------------------------------------------------
    // Прочее
    // -----------------------------------------------------------------------

    /** Пустое и NULL — одно «не задано», наружу null (§19.1). */
    private function component(mixed $raw): ?string
    {
        $s = trim((string) $raw);
        return $s !== '' ? $s : null;
    }

    /**
     * Сообщение перечисляет то, что реально сохранено. Общее
     * «Настройки профиля сохранены» после смены только колонок
     * утверждало бы, что ФИО и пароль тоже записаны.
     */
    private function message(bool $profile, bool $password, bool $columns): string
    {
        $parts = [];
        if ($profile) {
            $parts[] = 'ФИО';
        }
        if ($password) {
            $parts[] = 'пароль';
        }
        if ($columns) {
            $parts[] = 'настройки колонок';
        }

        return 'Сохранено: ' . implode(', ', $parts) . '.';
    }
}