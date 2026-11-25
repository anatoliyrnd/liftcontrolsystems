<?php
/** @var string $content */
/** @var array|null $user */
/** @var list<array{type:string,message:string}> $flash */
$title = $title ?? 'Админ-панель';
?><!doctype html>
<html lang="ru">
<head>
    <meta charset="utf-8">
    <meta name="viewport" content="width=device-width, initial-scale=1">
    <title><?= htmlspecialchars($title, ENT_QUOTES, 'UTF-8') ?></title>
    <!-- Продакшн: заменить CDN на admin/assets/adminlte/... -->
    <link rel="stylesheet" href="admin/assets/adminlte/css/adminlte.min.css">
    <link rel="stylesheet" href="https://cdn.jsdelivr.net/npm/bootstrap-icons@1/font/bootstrap-icons.min.css">
</head>
<body class="layout-fixed sidebar-expand-lg bg-body-tertiary">
<div class="app-wrapper">
    <nav class="app-header navbar navbar-expand bg-body border-bottom">
        <div class="container-fluid">
            <span class="navbar-brand">Lift-Calls · Organization</span>
            <?php if (!empty($user)): ?>
                <span class="ms-auto small text-muted">
                    <?= htmlspecialchars((string) ($user['user_name'] ?? ''), ENT_QUOTES, 'UTF-8') ?>
                    · <a href="?page=logout">Выйти</a>
                </span>
            <?php endif; ?>
        </div>
    </nav>

    <aside class="app-sidebar bg-body-secondary border-end">
        <div class="sidebar-brand p-3 fw-semibold">Меню</div>
        <nav class="nav flex-column p-2">
            <a class="nav-link" href="?page=dashboard">Дашборд</a>
            <a class="nav-link" href="?page=users">Пользователи</a>
            <a class="nav-link" href="?page=settings">Настройки</a>
            <a class="nav-link" href="?page=spult">СПульт</a>
        </nav>
    </aside>

    <main class="app-main">
        <div class="container-fluid p-4">
            <?php foreach ($flash as $msg): ?>
                <div class="alert alert-<?= htmlspecialchars($msg['type'], ENT_QUOTES, 'UTF-8') ?>">
                    <?= htmlspecialchars($msg['message'], ENT_QUOTES, 'UTF-8') ?>
                </div>
            <?php endforeach; ?>
            <?= $content ?>
        </div>
    </main>
</div>
</body>
</html>