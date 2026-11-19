<?php
use Company\Admin\Support\Csrf;
?><!doctype html>
<html lang="ru">
<head>
    <meta charset="utf-8">
    <meta name="viewport" content="width=device-width, initial-scale=1">
    <title>Вход · Organization Admin</title>
    <!-- Продакшн: заменить CDN на admin/assets/adminlte/... -->
    <link rel="stylesheet" href="https://cdn.jsdelivr.net/npm/admin-lte@4/dist/css/adminlte.min.css">
</head>
<body class="bg-body-tertiary d-flex align-items-center" style="min-height:100vh">
<div class="container" style="max-width:420px">
    <div class="card shadow-sm">
        <div class="card-body p-4">
            <h1 class="h4 mb-3">Вход в настройки организации</h1>

            <?php foreach (($flash ?? []) as $msg): ?>
                <div class="alert alert-<?= htmlspecialchars($msg['type'], ENT_QUOTES, 'UTF-8') ?>">
                    <?= htmlspecialchars($msg['message'], ENT_QUOTES, 'UTF-8') ?>
                </div>
            <?php endforeach; ?>

            <form method="post" action="?page=login">
                <input type="hidden" name="_csrf" value="<?= htmlspecialchars(Csrf::token(), ENT_QUOTES, 'UTF-8') ?>">
                <div class="mb-3">
                    <label class="form-label" for="login">Логин или email</label>
                    <input class="form-control" id="login" name="login" required autofocus>
                </div>
                <div class="mb-3">
                    <label class="form-label" for="password">Пароль</label>
                    <input class="form-control" id="password" name="password" type="password" required>
                </div>
                <button class="btn btn-primary w-100" type="submit">Войти</button>
            </form>
        </div>
    </div>
</div>
</body>
</html>