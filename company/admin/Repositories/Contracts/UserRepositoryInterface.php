<?php

declare(strict_types=1);

namespace Company\Admin\Repositories\Contracts;

/**
 * Пользователи панели компании. Единственный шов под Трек Б: при появлении
 * Node-API добавляется Repositories\Api\ApiUserRepository и в Bootstrap
 * меняется одна строка биндинга. SessionAuth и контроллеры не трогаются.
 *
 * Контракт — сырая строка lift_users (осознанный минимализм вместо DTO).
 * ApiUserRepository обязан вернуть те же ключи:
 *   user_id, user_login, user_email, user_password, user_block, user_role,
 *   user_name, login_attempts, locked_until
 *
 * user_role сравнивается СЫРЫМ. Нормализация Трека А (mechanic → engineer,
 * foreman → dispatcher) и fallback по user_localadmin к панели не применяются:
 * иначе легаси-флаг админа открыл бы настройки организации.
 */
interface UserRepositoryInterface
{
    /** @return array<string, mixed>|null */
    public function findById(int $id): ?array;

    /**
     * Логин или email — по наличию '@'. Регистр не нормализуем: сравнивает БД.
     *
     * @return array<string, mixed>|null
     */
    public function findByLogin(string $login): ?array;

    /** Автомиграция устаревшего хэша пароля при успешном входе. */
    public function updatePasswordHash(int $userId, string $newHash): void;

    /**
     * Инкремент счётчика неверных паролей, возвращает новое значение.
     *
     * Вызывается ТОЛЬКО при неверном пароле. Заблокированную учётку не
     * инкрементируем: иначе каждый запрос продлевал бы блокировку — DoS
     * на конкретный логин без единой верной попытки.
     *
     * Реализация — UPDATE ... = login_attempts + 1 и чтение обратно. Между
     * ними возможна гонка: параллельные запросы увидят одно значение и
     * заблокируют на попытку позже. Для порога 10 несущественно.
     */
    public function registerFailedLogin(int $userId): int;

    /**
     * Блокировка до абсолютной метки. Запись — FROM_UNIXTIME(:ts).
     *
     * @param int $until Unix-время окончания блокировки
     */
    public function lockUntil(int $userId, int $until): void;

    /**
     * login_attempts = 0, locked_until = NULL.
     * Один метод на два случая: успешный вход и истёкшая блокировка.
     */
    public function resetLoginState(int $userId): void;

    /**
     * Активна ли блокировка. Сравнение locked_until > NOW() выполняет MySQL.
     *
     * В PHP строку DATETIME не разбирать: зона MySQL сейчас SYSTEM, а PHP
     * зафиксирован на Europe/Moscow — strtotime() дал бы скос на 3 часа.
     * Вызывать только когда locked_until !== null: в обычном потоке это
     * лишний запрос на пустом месте.
     */
    public function isLocked(int $userId): bool;
}