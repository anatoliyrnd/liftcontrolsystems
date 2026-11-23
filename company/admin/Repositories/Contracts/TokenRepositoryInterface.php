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
 * Отзыв делегирован владельцу — App\Repository\UserRepository:
 * revokeOtherRefreshFamilies($id, null) и deleteAccessTokensByUser($id).
 * Свои DELETE не пишем: docblock владельца прямо называет две копии
 * с разным WHERE тем дефектом, который расходится при первой правке.
 * Третья копия была бы хуже двух.
 *
 * Легаси api_token / user_token в lift_users НЕ трогаем — решение
 * владельца: легаси-клиенты вне охвата панели.
 */
interface TokenRepositoryInterface
{
    /**
     * Гасит все сессии пользователя на всех устройствах.
     *
     * void, а не счётчики: методы владельца возвращают void, а считать
     * строки отдельными SELECT ради сообщения в UI — лишние запросы
     * и гонка. Аудит пишет кто/кому/что, число строк ему не нужно.
     *
     * Реализация обязана сохранить два инварианта:
     *   1. refresh гасится ПЕРЕД access — наоборот клиент обновит
     *      access по ещё живому refresh и переживёт отзыв;
     *   2. оба удаления в одной транзакции — методы владельца
     *      транзакцию не открывают, каждый делает один DELETE.
     */
    public function revokeAllForUser(int $userId): void;
}