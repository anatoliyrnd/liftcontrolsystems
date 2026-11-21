<?php

declare(strict_types=1);

use Company\Admin\Support\Csrf;
use Company\Admin\Support\Position;

/**
 * @var string                     $title
 * @var array<string, mixed>|null  $record   редактируемая запись или null
 * @var array<string, mixed>       $old      значения полей
 * @var array<string, string>      $errors
 * @var array<string, string>      $positions
 */

$e = static fn(mixed $v): string => htmlspecialchars((string) $v, ENT_QUOTES, 'UTF-8');

$isEdit = $record !== null;
$id = $isEdit ? (int) $record['user_id'] : 0;

// Значение поля: только из $old, пароль никогда не переотрисовывается.
$val = static fn(string $key): string => (string) ($old[$key] ?? '');

// Чекбокс: 'on' из POST и '1' из БД одинаково означают «отмечен».
$on = static fn(string $key): bool => !empty($old[$key]);

$err = static function (string $key) use ($errors, $e): string {
    return isset($errors[$key])
        ? '<div class="invalid-feedback d-block">' . $e($errors[$key]) . '</div>'
        : '';
};

$invalid = static fn(string $key): string => isset($errors[$key]) ? ' is-invalid' : '';

$currentPosition = Position::tryFrom($val('user_position'));

$flags = [
    'allow_dispatcher_quick_login' => 'Показывать в списке быстрого входа диспетчера',
    'user_hiden'                   => 'Скрыт из списков сотрудников',
    'user_add_call'                => 'Создание заявок (user_add_call)',
    'user_read_all_calls'          => 'Видит все заявки (user_read_all_calls)',
    'user_disppermission'          => 'Права диспетчера (user_disppermission)',
    'user_edit_obj'                => 'Редактирование объектов (user_edit_obj)',
    'user_edit_user'               => 'Редактирование пользователей (user_edit_user)',
];
?>
<div class="d-flex align-items-center mb-3">
    <h1 class="h3 mb-0"><?= $e($title) ?></h1>
    <a class="btn btn-outline-secondary ms-auto" href="?page=users">К списку</a>
</div>

<form method="post" action="?page=users&amp;action=<?= $isEdit ? 'edit' : 'create' ?>">
    <input type="hidden" name="_csrf" value="<?= $e(Csrf::token()) ?>">
    <?php if ($isEdit): ?>
        <input type="hidden" name="id" value="<?= $id ?>">
    <?php endif; ?>

    <div class="card mb-3">
        <div class="card-header">Учётная запись</div>
        <div class="card-body">
            <div class="row g-3">
                <div class="col-md-4">
                    <label class="form-label" for="user_surname">Фамилия</label>
                    <input class="form-control<?= $invalid('user_surname') ?>" id="user_surname"
                           name="user_surname" maxlength="100" required
                           value="<?= $e($val('user_surname')) ?>" <?= $isEdit ? '' : 'autofocus' ?>>
                    <?= $err('user_surname') ?>
                </div>
                <div class="col-md-4">
                    <label class="form-label" for="user_firstname">Имя</label>
                    <input class="form-control<?= $invalid('user_firstname') ?>" id="user_firstname"
                           name="user_firstname" maxlength="100" required
                           value="<?= $e($val('user_firstname')) ?>">
                    <?= $err('user_firstname') ?>
                </div>
                <div class="col-md-4">
                    <label class="form-label" for="user_patronymic">Отчество</label>
                    <input class="form-control<?= $invalid('user_patronymic') ?>" id="user_patronymic"
                           name="user_patronymic" maxlength="100"
                           value="<?= $e($val('user_patronymic')) ?>">
                    <?= $err('user_patronymic') ?>
                </div>

                <div class="col-md-4">
                    <label class="form-label" for="user_login">Логин</label>
                    <input class="form-control<?= $invalid('user_login') ?>" id="user_login"
                           name="user_login" maxlength="30" required autocomplete="off"
                           value="<?= $e($val('user_login')) ?>">
                    <?= $err('user_login') ?>
                </div>
                <div class="col-md-4">
                    <label class="form-label" for="user_email">Email</label>
                    <input type="email" class="form-control<?= $invalid('user_email') ?>" id="user_email"
                           name="user_email" maxlength="200" required autocomplete="off"
                           value="<?= $e($val('user_email')) ?>">
                    <?= $err('user_email') ?>
                </div>
                <div class="col-md-4">
                    <label class="form-label" for="user_phone">Телефон</label>
                    <input class="form-control<?= $invalid('user_phone') ?>" id="user_phone"
                           name="user_phone" maxlength="39"
                           value="<?= $e($val('user_phone')) ?>">
                    <?= $err('user_phone') ?>
                </div>

                <div class="col-md-6">
                    <label class="form-label" for="password">Пароль</label>
                    <input type="password" class="form-control<?= $invalid('password') ?>" id="password"
                           name="password" autocomplete="new-password"
                           <?= $isEdit ? '' : 'required' ?>>
                    <div class="form-text">
                        <?= $isEdit
                            ? 'Пусто = не менять. Минимум 8 символов при смене.'
                            : 'Минимум 8 символов. Задаётся вручную, автоматически не генерируется.' ?>
                    </div>
                    <?= $err('password') ?>
                </div>
            </div>
        </div>
    </div>

    <div class="card mb-3">
        <div class="card-header">Должность и права</div>
        <div class="card-body">
            <div class="row g-3">
                <div class="col-md-6">
                    <label class="form-label" for="user_position">Должность</label>
                    <select class="form-select<?= $invalid('user_position') ?>" id="user_position"
                            name="user_position" required>
                        <option value="">— выберите —</option>
                        <?php foreach ($positions as $slug => $label): ?>
                            <option value="<?= $e($slug) ?>" <?= $val('user_position') === $slug ? 'selected' : '' ?>>
                                <?= $e($label) ?>
                            </option>
                        <?php endforeach; ?>
                    </select>
                    <?= $err('user_position') ?>
                    <div class="form-text">
                        Роль назначается автоматически:
                        <code><?= $currentPosition !== null ? $e($currentPosition->role()) : '—' ?></code>
                    </div>
                </div>
            </div>

            <hr>

            <?php foreach ($flags as $flag => $label): ?>
                <div class="form-check">
                    <input class="form-check-input" type="checkbox" value="1"
                           id="<?= $e($flag) ?>" name="<?= $e($flag) ?>" <?= $on($flag) ? 'checked' : '' ?>>
                    <label class="form-check-label" for="<?= $e($flag) ?>"><?= $e($label) ?></label>
                </div>
            <?php endforeach; ?>

            <div class="form-text mt-2">
                Блокировка входа меняется кнопкой в списке, не здесь.
            </div>
        </div>
    </div>

    <button type="submit" class="btn btn-primary"><?= $isEdit ? 'Сохранить' : 'Создать' ?></button>
    <a class="btn btn-outline-secondary" href="?page=users">Отмена</a>
</form>