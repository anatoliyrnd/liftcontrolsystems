<?php
declare(strict_types=1);
require_once __DIR__ . '/../autoload.php';
session_start();

if (empty($_SESSION['admin_logged_in'])) {
    header('Location: /admin/');
    exit;
}

$registry = new \App\Registry();
$tenants = $registry->listAll();
?>
<!DOCTYPE html>
<html lang="ru">

<head>
    <meta charset="UTF-8">
    <title>Организации</title>
    <style>
        body {
            font-family: sans-serif;
            padding: 20px;
        }

        table {
            width: 100%;
            border-collapse: collapse;
            margin-bottom: 20px;
        }

        th,
        td {
            border: 1px solid #ccc;
            padding: 8px;
            text-align: left;
        }

        .btn {
            padding: 5px 10px;
            background: #007bff;
            color: #fff;
            text-decoration: none;
            border: none;
            cursor: pointer;
        }

        .btn-danger {
            background: #dc3545;
        }

        .btn-warning {
            background: #ffc107;
            color: #000;
        }

        .form-group {
            margin-bottom: 10px;
        }
    </style>
</head>

<body>
    <div style="display:flex; justify-content:space-between;">
        <h2>Организации</h2>
        <a href="/admin/?logout=1" class="btn btn-danger">Выйти</a>
    </div>

    <table>
        <tr>
            <th>Поддомен</th>
            <th>Название</th>
            <th>БД</th>
            <th>Статус</th>
            <th>Действия</th>
        </tr>
        <?php foreach ($tenants as $t): ?>
            <tr>
                <td><?= htmlspecialchars($t['subdomain']) ?></td>
                <td><?= htmlspecialchars($t['org_name']) ?></td>
                <td><?= htmlspecialchars($t['db_name']) ?></td>
                <td><?= $t['is_active'] ? 'Активен' : 'Отключен' ?></td>
                <td>
                    <form action="/admin/tenants_save.php" method="POST" style="display:inline;">
                        <input type="hidden" name="id" value="<?= $t['id'] ?>">
                        <input type="hidden" name="action" value="toggle">
                        <button class="btn btn-warning" type="submit"><?= $t['is_active'] ? 'Выкл' : 'Вкл' ?></button>
                    </form>
                </td>
            </tr>
        <?php endforeach; ?>
    </table>

    <h3>Добавить организацию</h3>
    <form action="/admin/tenants_save.php" method="POST">
        <input type="hidden" name="action" value="add">
        <div class="form-group"><input type="text" name="subdomain" placeholder="Поддомен (например, sh)" required>
        </div>
        <div class="form-group"><input type="text" name="org_name" placeholder="Название (ООО БДОМ)" required></div>
        <div class="form-group"><input type="text" name="db_host" value="localhost" required></div>
        <div class="form-group"><input type="number" name="db_port" value="3306" required></div>
        <div class="form-group"><input type="text" name="db_name" placeholder="Имя БД" required></div>
        <div class="form-group"><input type="text" name="db_user" placeholder="Логин БД" required></div>
        <div class="form-group"><input type="password" name="db_password" placeholder="Пароль БД" required></div>
        <button type="submit" class="btn">Добавить</button>
    </form>
</body>

</html>