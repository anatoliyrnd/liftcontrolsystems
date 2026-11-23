<?php

declare(strict_types=1);

use Company\Admin\Controllers\AuthController;
use Company\Admin\Controllers\DashboardController;
use Company\Admin\Controllers\UsersController;

/**
 * Маршруты панели: ключ "page.action" → [контроллер, метод].
 * Все кроме login требуют авторизации — Bootstrap освобождает только login.
 *
 * users.delete нет намеренно: удаление заменено мягкой блокировкой
 * (user_block), история и связи пользователя сохраняются.
 *
 * revoke / reload / reloadall принимают только POST — проверяет контроллер,
 * здесь ограничение не дублируем. reloadall дополнительно требует
 * confirm=all: маркер осознанности массовой операции.
 *
 * Action в URL строчными, метод в camelCase — соответствие задаёт эта карта,
 * Router не выводит имя метода из строки.
 */
return [
    'login.index'     => [AuthController::class, 'index'],
    'logout.index'    => [AuthController::class, 'logout'],
    'dashboard.index' => [DashboardController::class, 'index'],

    'users.index'     => [UsersController::class, 'index'],
    'users.create'    => [UsersController::class, 'create'],
    'users.edit'      => [UsersController::class, 'edit'],
    'users.block'     => [UsersController::class, 'block'],
    'users.revoke'    => [UsersController::class, 'revoke'],
    'users.reload'    => [UsersController::class, 'reload'],
    'users.reloadall' => [UsersController::class, 'reloadAll'],
];