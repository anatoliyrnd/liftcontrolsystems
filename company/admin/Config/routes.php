<?php
declare(strict_types=1);
use Company\Admin\Controllers\AuthController;
use Company\Admin\Controllers\DashboardController;

return [
    'login.index'     => [AuthController::class,      'index'],
    'logout.index'    => [AuthController::class,      'logout'],
    'dashboard.index' => [DashboardController::class, 'index'],
];