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

        .btn-edit {
            background: #6f42c1;
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

        .btn:disabled {
            background: #ccc;
            cursor: not-allowed;
        }

        .btn-danger {
            background: #dc3545;
        }

        .btn-warning {
            background: #ffc107;
            color: #000;
        }

        .btn-cleanup {
            background: #17a2b8;
        }

        .form-group {
            margin-bottom: 10px;
        }

        .legacy-badge {
            background: #6c757d;
            color: #fff;
            padding: 2px 6px;
            border-radius: 3px;
            font-size: 12px;
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
            <th>Legacy</th>
            <th>Статус</th>
            <th>Действия</th>
        </tr>
        <?php foreach ($tenants as $t): ?>
            <tr>
                <td><?= htmlspecialchars($t['subdomain']) ?></td>
                <td><?= htmlspecialchars($t['org_name']) ?></td>
                <td><?= htmlspecialchars($t['db_name']) ?></td>
                <td>
                    <?php if (!empty($t['legacy_compat'])): ?>
                        <span class="legacy-badge">Legacy</span>
                    <?php else: ?>
                        —
                    <?php endif; ?>
                </td>
                <td><?= $t['is_active'] ? 'Активен' : 'Отключен' ?></td>
                <td>
                    <form action="/admin/tenants_save.php" method="POST" style="display:inline;">
                        <input type="hidden" name="id" value="<?= $t['id'] ?>">
                        <input type="hidden" name="action" value="toggle">
                        <a class="btn btn-edit" href="/admin/tenant_edit.php?id=<?= (int) $t['id'] ?>">Изменить</a>
                        <button class="btn btn-warning" type="submit">
                            <?= $t['is_active'] ? 'Выкл' : 'Вкл' ?>
                        </button>
                    </form>

                    <?php if (empty($t['legacy_compat']) && !empty($t['is_active'])): ?>
                        <button class="btn btn-cleanup" data-tenant-id="<?= $t['id'] ?>"
                            data-tenant-name="<?= htmlspecialchars($t['org_name']) ?>" onclick="cleanupTenant(this)">
                            Очистка уведомлений
                        </button>
                    <?php endif; ?>
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

    <script>
        function cleanupTenant(button) {
            const tenantId = button.dataset.tenantId;
            const tenantName = button.dataset.tenantName;

            // Блокируем кнопку и меняем текст
            button.disabled = true;
            const originalText = button.textContent;
            button.textContent = 'Очистка...';

            const formData = new FormData();
            formData.append('id', tenantId);

            fetch('/admin/cleanup_tenant.php', {
                method: 'POST',
                body: formData
            })
                .then(response => response.json())
                .then(data => {
                    if (data.success) {
                        alert(data.message || 'Очистка завершена успешно');
                    } else {
                        alert('Ошибка: ' + (data.error || 'Неизвестная ошибка'));
                    }
                })
                .catch(error => {
                    alert('Ошибка сети: ' + error.message);
                })
                .finally(() => {
                    // Возвращаем кнопку через 60 секунд
                    setTimeout(() => {
                        button.disabled = false;
                        button.textContent = originalText;
                    }, 60000);
                });
        }
    </script>
</body>

</html>