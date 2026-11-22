<?php

declare(strict_types=1);

namespace Company\Admin\Repositories\Contracts;

/**
 * Сессии пользователя: lift_access_tokens + lift_refresh_tokens.
 *
 * Отдельный агрегат, не часть UserRepositoryInterface — другие таблицы,
 * другая ответственность. Шов под Трек Б тем же приёмом: реализация
 * меняется одной строкой биндинга в Bootstrap.
 *
 * Отзыв — DELETE, а не пометка: revoked_at нет ни в одной из таблиц
 * (SHOW COLUMNS подтверждён), и Трек А делает так же
 * (App/Repository/UserRepository.php:261, 327, 344).
 *
 * Легаси api_token / user_token в lift_users НЕ трогаем — решение
 * владельца: легаси-клиенты вне охвата панели.
 */
interface TokenRepositoryInterface
{
    /**
     * Гасит все сессии пользователя на всех устройствах.
     *
     * Порядок обязателен: сначала refresh, потом access. Наоборот —
     * клиент обновит access по ещё живому refresh в окне между двумя
     * DELETE и переживёт отзыв.
     *
     * Число удалённых строк нужно аудиту и UI: «активных сессий не было»
     * и «завершено 5 сессий» — разные сообщения.
     *
     * @return array{refresh: int, access: int}
     */
    public function revokeAllForUser(int $userId): array;
}