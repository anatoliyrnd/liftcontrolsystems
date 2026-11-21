<?php

declare(strict_types=1);

use Company\Admin\Support\Csrf;
use Company\Admin\Support\Position;

/**
 * @var string $title
 * @var list<array<string, mixed>> $users
 */

$e = static fn(mixed $value): string => htmlspecialchars((string) $value, ENT_QUOTES, 'UTF-8');

// Unix-метки абсолютны: date() в Europe/Moscow корректен, скоса зоны нет.
$ts = static function (mixed $value) use ($e): string {
    $unix = (int) $value;
    return $unix > 0 ? $e(date('d.m.Y H:i', $unix)) : '—';
};
?>
<div class="d-flex align-items-center mb-3">
    <h1 class="h3 mb-0"><?= $e($title ?? 'Пользователи') ?></h1>
    <a class="btn btn-primary ms-auto" href="?page=users&amp;action=create">Создать</a>
</div>

<div class="card">
    <div class="table-responsive">
        <table class="table table-hover align-middle mb-0">
            <thead>
                <tr>
                    <th>ФИО</th>
                    <th>Логин</th>
                    <th>Должность</th>
                    <th>Роль</th>
                    <th>Статус</th>
                    <th>Отметки</th>
                    <th>Создан</th>
                    <th>Вход</th>
                    <th class="text-end">Действия</th>
                </tr>
            </thead>
            <tbody>
            <?php if ($users === []): ?>
                <tr><td colspan="9" class="text-center text-muted py-4">Пользователей нет</td></tr>
            <?php endif; ?>
            <?php foreach ($users as $row): ?>
                <?php
                $id = (int) $row['user_id'];
                $blocked = (int) $row['user_block'] === 1;
                $rawPosition = (string) ($row['user_position'] ?? '');
                $position = Position::tryFrom($rawPosition);
                ?>
                <tr>
                    <td>
                        <?= $e($row['user_name']) ?>
                        <?php if ((int) $row['user_hiden'] === 1): ?>
                            <span class="badge text-bg-secondary ms-1">скрыт</span>
                        <?php endif; ?>
                    </td>
                    <td><code><?= $e($row['user_login']) ?></code></td>
                    <td>
                        <?php if ($position !== null): ?>
                            <?= $e($position->label()) ?>
                        <?php else: ?>
                            <span class="text-danger"><?= $e($rawPosition !== '' ? $rawPosition : '—') ?></span>
                            <small class="text-muted d-block">вне словаря</small>
                        <?php endif; ?>
                    </td>
                    <td><small class="text-muted"><?= $e($row['user_role']) ?></small></td>
                    <td>
                        <?php if ($blocked): ?>
                            <span class="badge text-bg-danger">заблокирован</span>
                        <?php else: ?>
                            <span class="badge text-bg-success">активен</span>
                        <?php endif; ?>
                        <?php if ((int) $row['is_locked'] === 1): ?>
                            <span class="badge text-bg-warning d-block mt-1">вход до срока</span>
                        <?php endif; ?>
                    </td>
                    <td>
                        <?php if ((int) $row['allow_dispatcher_quick_login'] === 1): ?>
                            <span class="badge text-bg-info">быстрый вход</span>
                        <?php endif; ?>
                        <?php if ((int) $row['login_attempts'] > 0): ?>
                            <small class="text-muted d-block">
                                ошибок входа: <?= (int) $row['login_attempts'] ?>
                            </small>
                        <?php endif; ?>
                    </td>
                    <td><small><?= $ts($row['user_date']) ?></small></td>
                    <td><small><?= $ts($row['last_login']) ?></small></td>
                    <td class="text-end text-nowrap">
                        <a class="btn btn-sm btn-outline-secondary"
                           href="?page=users&amp;action=edit&amp;id=<?= $id ?>">Редактировать</a>
                        <form method="post" action="?page=users&amp;action=block" class="d-inline">
                            <input type="hidden" name="_csrf" value="<?= $e(Csrf::token()) ?>">
                            <input type="hidden" name="id" value="<?= $id ?>">
                            <input type="hidden" name="blocked" value="<?= $blocked ? 0 : 1 ?>">
                            <button type="submit"
                                    class="btn btn-sm <?= $blocked ? 'btn-outline-success' : 'btn-outline-danger' ?>"
                                    onclick="return confirm('<?= $blocked ? 'Разблокировать' : 'Заблокировать' ?> пользователя?')">
                                <?= $blocked ? 'Разблокировать' : 'Блокировать' ?>
                            </button>
                        </form>
                    </td>
                </tr>
            <?php endforeach; ?>
            </tbody>
        </table>
    </div>
</div>

<p class="text-muted small mt-3 mb-0">
    Удаление не предусмотрено: блокировка сохраняет историю и связи пользователя.
    Роль назначается автоматически из должности.
</p>