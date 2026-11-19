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
     */
    public function registerFailedLogin(int $userId): int;

    /**
     * Блокировка входа до абсолютной метки. Запись — FROM_UNIXTIME(:ts).
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
     */
    public function isLocked(int $userId): bool;

    /**
     * Все пользователи для раздела «Пользователи», сортировка по имени.
     *
     * БЕЗ user_password: хэши не должны попадать в HTML списка.
     * Пагинации нет осознанно — учётных записей десятки, не тысячи.
     *
     * @return list<array<string, mixed>>
     */
    public function list(): array;

    /**
     * Создание учётной записи, возвращает новый user_id.
     *
     * Пароль отдельно от $fields: хэш считает контроллер через Password::hash,
     * репозиторий только сохраняет. Ключи $fields — имена колонок; ключ вне
     * белого списка реализации → InvalidArgumentException, а не молчаливый
     * пропуск (иначе опечатка в контроллере теряется бесследно).
     *
     * @param array<string, mixed> $fields
     */
    public function create(array $fields, string $passwordHash): int;

    /**
     * Обновление полей. Пароль НЕ трогаем — для него updatePasswordHash.
     * Ключ вне белого списка → InvalidArgumentException.
     *
     * @param array<string, mixed> $fields
     */
    public function update(int $userId, array $fields): void;

    /**
     * Мягкая блокировка: user_block = 1/0, без удаления записи.
     *
     * Установка целевого состояния, а не инверсия: toggle потребовал бы
     * чтения текущего значения и дал бы гонку при двух администраторах.
     *
     * Сброс rate-limit при разблокировке — решение контроллера
     * (resetLoginState отдельным вызовом), не этого метода.
     */
    public function setBlocked(int $userId, bool $blocked): void;

    /**
     * Занятость логина или email другим пользователем.
     *
     * Один запрос вместо двух exists*: WHERE (login = ? OR email = ?)
     * AND user_id <> $exceptId. Возвращает 'login', 'email' или null —
     * UI должен сказать, что именно занято, а не «что-то дублируется».
     *
     * @param int $exceptId 0 при создании, id записи при редактировании
     */
    public function findIdentityConflict(string $login, string $email, int $exceptId = 0): ?string;
}