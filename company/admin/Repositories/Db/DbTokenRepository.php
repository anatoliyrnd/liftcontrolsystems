<?php

declare(strict_types=1);

namespace Company\Admin\Repositories\Db;

use App\Database\DB;
use App\Repository\UserRepository;
use Company\Admin\Repositories\Contracts\TokenRepositoryInterface;

/**
 * Сессии пользователя: делегирование владельцу.
 *
 * Оба действия уже есть в App\Repository\UserRepository и объявлены
 * публичными. Свои DELETE не пишем: его docblock прямо называет две
 * копии с разным WHERE тем дефектом, который расходится при первой
 * же правке. Третья копия была бы хуже двух.
 *
 * Связность допустима: она живёт в Db-реализации, которая и так
 * зависит от App\Database\DB. Api-реализация Трека Б будет отдельной,
 * биндинг в Bootstrap не меняется — конструктор по-прежнему принимает DB.
 *
 * Легаси api_token / user_token вне охвата по решению владельца.
 */
final class DbTokenRepository implements TokenRepositoryInterface
{
    private readonly UserRepository $owner;

    public function __construct(private readonly DB $db)
    {
        $this->owner = new UserRepository($db);
    }

    /**
     * Не вызывать внутри уже открытой транзакции: transaction()
     * откроет вложенную, а обёртка этого не поддерживает.
     */
    public function revokeAllForUser(int $userId): void
    {
        // Транзакция обязательна: методы владельца делают по одному
        // DELETE каждый и обёртку не открывают. Без неё между удалениями
        // клиент обновил бы access по ещё живому refresh.
        //
        // Замыкание НЕ static: внутри нужен $this->owner. Статическое
        // не привязывает $this → Error при первом же вызове.
        $this->db->transaction(function () use ($userId): void {
            // Порядок обязателен: refresh первым. DELETE берёт
            // исключительные блокировки строк, параллельная ротация
            // Трека А заблокируется на своём UPDATE, а после нашего
            // commit не найдёт строку и вернёт invalid.
            //
            // null вторым аргументом = погасить ВСЕ семьи пользователя,
            // а не сохранить текущую: это выход со всех устройств.
            $this->owner->revokeOtherRefreshFamilies($userId, null);
            $this->owner->deleteAccessTokensByUser($userId);
        });
    }
}