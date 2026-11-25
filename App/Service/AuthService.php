<?php

declare(strict_types=1);

namespace App\Service;

use App\Repository\UserRepository;
use App\Exceptions\ApiException;
use App\Http\ErrorCode;
use App\Support\Password;
use App\Support\Logger;

final class AuthService
{
    public const int ACCESS_TTL = 7200; // 2 часа; используется и AuthController

    /**
     * Срок жизни refresh-токена, секунды.
     *
     * Раньше значение жило в двух местах: AuthController::REFRESH_TTL
     * (срок cookie) и 30*86400 внутри UserRepository::saveRefreshToken
     * (срок строки в БД). Cookie могла пережить запись или наоборот:
     * «сессия истекла» при живой cookie либо молчаливый разлогин через
     * месяц. Одни часы на оба срока.
     */
    public const int REFRESH_TTL = 30 * 86400;

    /**
     * Grace-окно переиспользования refresh-токена, секунды.
     *
     * Строгая ротация без окна ломается не только на гонке вкладок.
     * Если ответ refresh потерян (сеть оборвалась уже после коммита),
     * cookie остаётся со старым токеном, и следующий refresh предъявит
     * ротированный — без окна это «кража» и отзыв семьи. Локи такой
     * случай не покрывают вообще, он происходит и в одной вкладке.
     *
     * Внутри окна предъявление ротированного токена кражей НЕ считается:
     * выполняется обычная ротация — новый преемник в той же семье, новая
     * cookie, новый access. Cookie обновляется всегда: если оставить её
     * прежней, клиент залипнет на ротированном токене и по истечении
     * окна получит ложную кражу.
     *
     * Вне окна — отзыв всей семьи, TokenInvalid, вход заново.
     *
     * Цена компромисса: украденный токен, предъявленный в течение окна,
     * пройдёт. Это стандартная цена строгой ротации с grace-периодом.
     */
    public const int REFRESH_REUSE_GRACE_SEC = 30;

    /**
     * Неудачных проверок пароля до временной блокировки входа (§19.1, §20).
     *
     * Ключ — АККАУНТ, а не IP: один и тот же диспетчер заходит из дома,
     * с работы и с мобильной сети. Лимит по адресу запирал бы его
     * собственным входом с другой точки, а перебор с одного адреса по
     * разным аккаунтам всё равно проходил бы. Колонки login_attempts /
     * locked_until заведены именно под аккаунт.
     *
     * Компромисс осознан: зная логин, можно намеренно запереть чужой
     * вход на окно блокировки. Поэтому окно короткое, а активные сессии
     * блокировка НЕ гасит — иначе отказ в обслуживании распространялся
     * бы на уже работающего диспетчера, и вред был бы больше пользы.
     *
     * Счётчики входа и смены пароля РАЗДЕЛЕНЫ: проверку старого пароля
     * в профиле защищает PasswordChangeLimiter. Общий счётчик означал
     * бы, что пять опечаток в профиле запирают вход.
     */
    public const int LOGIN_MAX_ATTEMPTS = 5;

    /**
     * Длительность блокировки входа, секунды.
     *
     * 15 минут — компромисс между ценой перебора и ценой опечатки.
     * Отсидевший окно начинает с чистого счётчика: сброс делает
     * UserRepository::recordLoginFailure по истечении locked_until,
     * а не «первая же опечатка снова запирает на четверть часа».
     */
    public const int LOGIN_LOCK_SEC = 900;

    public function __construct(private readonly UserRepository $userRepo)
    {
    }

    public function login(?int $userId, string $login, string $password, string $webgl): array
    {
        $user = $userId !== null ? $this->userRepo->findById($userId) : $this->userRepo->findByLogin($login);

        if (!$user) {
            throw new ApiException(ErrorCode::InvalidCredentials, 'Пользователь не найден');
        }

        if ((int) $user['user_block'] === 1) {
            throw new ApiException(ErrorCode::UserBlocked, 'Учётная запись заблокирована');
        }

        $uid = (int) $user['user_id'];

        // Блокировка проверяется ДО Password::verify: bcrypt дорогой,
        // а запертому аккаунту отказ не зависит от того, верен ли пароль.
        // Заодно не сообщаем подборщику, угадал ли он пароль на запертой
        // учётке. Существование аккаунта и так раскрывается текстом
        // «Пользователь не найден» — нового канала утечки здесь нет.
        //
        // Порядок после user_block: постоянная блокировка аккаунта
        // информативнее временного тормоза и не должна маскироваться им.
        //
        // Активные access/refresh НЕ гасим: блокировка входа — не
        // блокировка аккаунта. Иначе пять чужих опечаток выбрасывали бы
        // работающего диспетчера из сессии.
        $guard = $this->userRepo->findLoginGuard($uid);
        if ($guard !== null && $guard['is_locked']) {
            throw new ApiException(
                ErrorCode::RateLimited,
                'Слишком много неверных попыток. Вход временно заблокирован.',
                reason: 'login_locked',
                details: ['retry_after' => $guard['retry_after']]
            );
        }

        if (!Password::verify($password, $user['user_password'])) {
            // Счётчик пишем ДО логирования: Logger может бросить
            // (переполнен диск, недоступный приёмник), и тогда попытка
            // осталась бы неучтённой — ровно та дыра, которую закрываем.
            $this->userRepo->recordLoginFailure($uid, self::LOGIN_MAX_ATTEMPTS, self::LOGIN_LOCK_SEC);

            Logger::warning("Неудачная попытка входа: {$login}", ['ip' => $_SERVER['REMOTE_ADDR'] ?? '']);
            throw new ApiException(ErrorCode::InvalidCredentials, 'Неверный пароль');
        }

        // Пароль доказан — счётчик снимаем сразу, до автомиграции хэша:
        // если UPDATE хэша сорвётся, серия прошлых опечаток не должна
        // остаться висеть на аккаунте. Внутри репозитория стоит WHERE,
        // поэтому на обычном входе с нулевым счётчиком записи нет.
        $this->userRepo->resetLoginAttempts($uid);

        // Автомиграция MD5 -> Bcrypt
        $passwordNeedsUpgrade = false;
        if (Password::needsRehash($user['user_password'])) {
            $newHash = Password::hash($password);
            $this->userRepo->updatePasswordHash($uid, $newHash);
            $passwordNeedsUpgrade = true;
            Logger::info("Пароль ID:{$uid} обновлен на Bcrypt.", ['ip' => $_SERVER['REMOTE_ADDR'] ?? '']);
        }

        // Токен здесь больше не создаётся: единственный access выпускает
        // AuthController и пишет его в lift_access_tokens. Legacy-колонки
        // api_token / api_token_expires / webgl_info_spa не трогаем —
        // именно они ломали refresh через 2 часа после логина.
        return [
            'user' => $this->formatUser($user),
            'password_needs_upgrade' => $passwordNeedsUpgrade,
        ];
    }

    public function validate(string $token): array
    {
        $user = $this->userRepo->findByAccessToken($token);

        if (!$user) {
            throw new ApiException(ErrorCode::TokenInvalid, 'Токен недействителен');
        }

        if ((int) $user['user_block'] === 1) {
            throw new ApiException(ErrorCode::UserBlocked, 'Аккаунт заблокирован');
        }

        // Срок действия уже проверен в SQL: findByAccessToken фильтрует
        // a.expires_at > NOW(). Проверка lift_users.api_token_expires удалена:
        // колонка писалась только при логине и через 2 часа валила любой refresh.
        //
        // Блокировку входа здесь НЕ проверяем намеренно: она про подбор
        // пароля, а не про право работать. Иначе чужие опечатки на экране
        // входа выбрасывали бы диспетчера из уже открытой смены.
        return $this->formatUser($user);
    }

    private function formatUser(array $u): array
    {
        $role = (string) ($u['user_role'] ?? '');

        // Legacy-значения приводим к словарю фронтенда:
        // неизвестная роль на клиенте нормализуется в guest.
        $role = match ($role) {
            'mechanic' => 'engineer',
            'foreman'  => 'dispatcher',
            default    => $role,
        };

        // Fallback только по явным флагам. user_level больше не используется:
        // необнулённый уровень 0 давал администратора.
        if ($role === '' || $role === 'guest') {
            if (!empty($u['user_localadmin'])) {
                $role = 'administrator';
            } elseif (!empty($u['user_disppermission'])) {
                $role = 'dispatcher';
            } else {
                $role = 'guest';
            }
        }

        $surname    = trim((string) ($u['user_surname'] ?? ''));
        $firstname  = trim((string) ($u['user_firstname'] ?? ''));
        $patronymic = trim((string) ($u['user_patronymic'] ?? ''));

        // Должностной тип — бизнес-тип, а не роль доступа: его НЕ
        // нормализуем (mechanic/foreman выше относятся к user_role).
        // Пустая строка и NULL в БД означают одно «не задан», поэтому
        // наружу отдаём null — ConfigService уже ждёт эту форму.
        $position = trim((string) ($u['user_position'] ?? ''));

        return [
            'id'           => (int) $u['user_id'],
            // Для незаполненных записей name остаётся полным ФИО —
            // шапка показывает то же, что и раньше.
            'name'         => $firstname !== '' ? $firstname : (string) $u['user_name'],
            'surname'      => $surname !== '' ? $surname : null,
            'patronymic'   => $patronymic !== '' ? $patronymic : null,
            'display_name' => (string) $u['user_name'],
            'role'         => $role,
            // Флаги обязан вернуть именно formatUser: CallPolicy читает
            // права из $user и в БД не ходит. Без этих полей флаг
            // прочитается как 0, и инженер с правом потеряет создание
            // в обоих путях — поэтому патч выкатывается ДО проверок.
            //
            // int 0/1, а не bool: колонки tinyint(1), клиент сравнивает
            // с 0/1, приведение к bool живёт внутри CallPolicy.
            'user_add_call'       => (int) ($u['user_add_call'] ?? 0),
            // Транспорт без потребителя: область чтения остаётся прежней
            // до B3.2 (CallScope). Поле добавлено сейчас, чтобы B3.2
            // правил один файл и не трогал AuthService повторно.
            'user_read_all_calls' => (int) ($u['user_read_all_calls'] ?? 0),
            'user_position'       => $position !== '' ? $position : null,
        ];
    }
}