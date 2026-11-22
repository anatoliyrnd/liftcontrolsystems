<?php

declare(strict_types=1);

namespace Company\Admin\Repositories\Db;

use App\Database\DB;
use Company\Admin\Repositories\Contracts\TokenRepositoryInterface;
use RuntimeException;

/**
 * Сессии пользователя на MariaDB тенанта.
 *
 * Отзыв — DELETE: revoked_at нет ни в lift_access_tokens, ни в
 * lift_refresh_tokens, и Трек А делает так же
 * (App/Repository/UserRepository.php:261, 327, 344).
 *
 * Легаси api_token / user_token не трогаем — вне охвата по решению владельца.
 */
final class DbTokenRepository implements TokenRepositoryInterface
{
    public function __construct(private readonly DB $db)
    {
    }

    public function revokeAllForUser(int $userId): array
    {
        // Транзакция обязательна: два DELETE вне неё оставляют окно,
        // в котором клиент обновит access по ещё живому refresh.
        //
        // Refresh первым: DELETE берёт исключительную блокировку строк,
        // и параллельная ротация Трека А (UPDATE lift_refresh_tokens)
        // заблокируется, а после нашего commit не найдёт строку.
               // Замыкание НЕ static: внутри нужен $this->db. Статическое
        // не привязывает $this → Error при первом же вызове.
        $result = $this->db->transaction(function () use ($userId): array {
            $refresh = $this->db->execute(
                'DELETE FROM lift_refresh_tokens WHERE user_id = ?',
                [$userId]
            );
            $access = $this->db->execute(
                'DELETE FROM lift_access_tokens WHERE user_id = ?',
                [$userId]
            );

            return ['refresh' => $refresh, 'access' => $access];
        });

        // Не подставляем нули при неожиданном результате: аудит и UI
        // получили бы ложное «сессий не было» вместо ошибки.
        if (!is_array($result) || !isset($result['refresh'], $result['access'])) {
            throw new RuntimeException('Отзыв сессий: неожиданный результат транзакции');
        }

        return [
            'refresh' => (int) $result['refresh'],
            'access'  => (int) $result['access'],
        ];
    }
}