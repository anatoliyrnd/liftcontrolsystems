<?php
declare(strict_types=1);
define('APP_ENTRY_POINT', true);
require_once __DIR__ . '/../autoload.php';
session_start();

if (empty($_SESSION['admin_logged_in'])) {
    header('Location: /admin/');
    exit;
}

function esc(?string $v): string
{
    return htmlspecialchars((string) $v, ENT_QUOTES, 'UTF-8');
}

$registry = new \App\Registry();
$id = (int) ($_GET['id'] ?? $_POST['id'] ?? 0);

if ($id <= 0) {
    header('Location: /admin/tenants.php');
    exit;
}

// --- Загружаем организацию ---
$tenant = null;
foreach ($registry->listAll() as $t) {
    if ((string) $t['id'] === (string) $id) {
        $tenant = $t;
        break;
    }
}

if (!$tenant) {
    http_response_code(404);
    die('Организация не найдена. <a href="/admin/tenants.php">Назад к списку</a>');
}

// --- Значения формы (по умолчанию из БД) ---
$form = [
    'subdomain' => (string) ($tenant['subdomain'] ?? ''),
    'org_name' => (string) ($tenant['org_name'] ?? ''),
    'db_host' => (string) ($tenant['db_host'] ?? ''),
    'db_port' => (string) ($tenant['db_port'] ?? '3306'),
    'db_name' => (string) ($tenant['db_name'] ?? ''),
    'db_user' => (string) ($tenant['db_user'] ?? ''),
    'legacy_compat' => !empty($tenant['legacy_compat']) ? 1 : 0,
];

$error = '';

// --- Обработка сохранения (форма постит сама в себя) ---
if ($_SERVER['REQUEST_METHOD'] === 'POST') {
    $post = $_POST;
    $post['legacy_compat'] = isset($post['legacy_compat']) ? 1 : 0;

    $required = [
        'subdomain' => 'Поддомен',
        'org_name' => 'Название организации',
        'db_host' => 'Хост БД',
        'db_port' => 'Порт БД',
        'db_name' => 'Имя БД',
        'db_user' => 'Логин БД',
    ];

    foreach ($required as $field => $label) {
        if (trim((string) ($post[$field] ?? '')) === '') {
            $error = "Поле «{$label}» обязательно для заполнения";
            break;
        }
    }

    if ($error === '' && !preg_match('/^[a-z0-9-]+$/', (string) ($post['subdomain'] ?? ''))) {
        $error = 'Поддомен может содержать только строчные латинские буквы, цифры и дефисы';
    }

    if ($error === '' && !ctype_digit((string) ($post['db_port'] ?? ''))) {
        $error = 'Порт БД должен быть числом';
    }

    // Уникальность поддомена
    if ($error === '') {
        foreach ($registry->listAll() as $t) {
            if ((string) $t['id'] !== (string) $id && ($t['subdomain'] ?? '') === $post['subdomain']) {
                $error = 'Поддомен «' . $post['subdomain'] . '» уже занят другой организацией';
                break;
            }
        }
    }

    if ($error === '') {
        $data = [
            'id' => $id,
            'subdomain' => trim((string) $post['subdomain']),
            'org_name' => trim((string) $post['org_name']),
            'db_host' => trim((string) $post['db_host']),
            'db_port' => (int) $post['db_port'],
            'db_name' => trim((string) $post['db_name']),
            'db_user' => trim((string) $post['db_user']),
            'legacy_compat' => (int) $post['legacy_compat'],
            'is_active' => (int) ($tenant['is_active'] ?? 1), // статус не трогаем здесь
        ];

        if (trim((string) ($post['db_password'] ?? '')) === '') {
            // save() шифрует сам, поэтому старый пароль нужно РАСШИФРОВАТЬ
            // и передать в открытом виде — тогда он зашифруется корректно заново
            $data['db_password'] = \App\Support\Crypto::decrypt((string) $tenant['db_password']);
        } else {
            $data['db_password'] = (string) $post['db_password'];
        }
        try {
            // Предполагается, что save() при наличии 'id' обновляет запись.
            // Если в твоём \App\Registry обновление — отдельный метод, замени вызов.
            $registry->save($data);
            header('Location: /admin/tenants.php');
            exit;
        } catch (\Throwable $e) {
            $error = 'Ошибка сохранения: ' . $e->getMessage();
        }
    }

    // При ошибке возвращаем введённые значения в форму
    if ($error !== '') {
        $form = [
            'subdomain' => (string) ($post['subdomain'] ?? ''),
            'org_name' => (string) ($post['org_name'] ?? ''),
            'db_host' => (string) ($post['db_host'] ?? ''),
            'db_port' => (string) ($post['db_port'] ?? ''),
            'db_name' => (string) ($post['db_name'] ?? ''),
            'db_user' => (string) ($post['db_user'] ?? ''),
            'legacy_compat' => (int) ($post['legacy_compat'] ?? 0),
        ];
    }
}
?>
<!DOCTYPE html>
<html lang="ru">

<head>
    <meta charset="UTF-8">
    <title>Редактирование организации</title>
    <style>
        body {
            font-family: sans-serif;
            padding: 20px;
            max-width: 550px;
        }

        .btn {
            display: inline-block;
            padding: 6px 14px;
            background: #007bff;
            color: #fff;
            text-decoration: none;
            border: none;
            cursor: pointer;
        }

        .btn-secondary {
            background: #6c757d;
        }

        .form-group {
            margin-bottom: 12px;
        }

        .form-group label {
            display: block;
            margin-bottom: 4px;
            font-weight: bold;
        }

        .form-group input[type="text"],
        .form-group input[type="number"],
        .form-group input[type="password"] {
            width: 100%;
            padding: 6px;
            box-sizing: border-box;
        }

        .error {
            background: #f8d7da;
            color: #721c24;
            border: 1px solid #f5c6cb;
            padding: 10px;
            margin-bottom: 15px;
            border-radius: 4px;
        }

        .form-actions {
            display: flex;
            gap: 10px;
            margin-top: 20px;
        }

        .hint {
            font-size: 12px;
            color: #666;
        }
    </style>
</head>

<body>

    <div style="display:flex; justify-content:space-between; align-items:center;">
        <h2>Редактирование организации</h2>
        <a href="/admin/tenants.php" class="btn btn-secondary">← К списку</a>
    </div>

    <?php if ($error !== ''): ?>
        <div class="error"><?= esc($error) ?></div>
    <?php endif; ?>

    <form method="POST" id="editForm">
        <input type="hidden" name="id" value="<?= (int) $id ?>">

        <div class="form-group">
            <label for="subdomain">Поддомен *</label>
            <input type="text" id="subdomain" name="subdomain" value="<?= esc($form['subdomain']) ?>" required
                pattern="[a-z0-9-]+">
        </div>

        <div class="form-group">
            <label for="org_name">Название организации *</label>
            <input type="text" id="org_name" name="org_name" value="<?= esc($form['org_name']) ?>" required>
        </div>

        <div class="form-group">
            <label for="db_host">Хост БД *</label>
            <input type="text" id="db_host" name="db_host" value="<?= esc($form['db_host']) ?>" required>
        </div>

        <div class="form-group">
            <label for="db_port">Порт БД *</label>
            <input type="number" id="db_port" name="db_port" value="<?= esc($form['db_port']) ?>" required>
        </div>

        <div class="form-group">
            <label for="db_name">Имя БД *</label>
            <input type="text" id="db_name" name="db_name" value="<?= esc($form['db_name']) ?>" required>
        </div>

        <div class="form-group">
            <label for="db_user">Логин БД *</label>
            <input type="text" id="db_user" name="db_user" value="<?= esc($form['db_user']) ?>" required>
        </div>

        <div class="form-group">
            <label for="db_password">Пароль БД</label>
            <input type="password" id="db_password" name="db_password" autocomplete="new-password">
            <div class="hint">Оставьте пустым, чтобы не менять текущий пароль.</div>
        </div>

        <div class="form-group">
            <label>
                <input type="checkbox" name="legacy_compat" value="1" <?= $form['legacy_compat'] ? 'checked' : '' ?>>
                Legacy режим
            </label>
        </div>

        <div class="form-actions">
            <button type="submit" class="btn">Сохранить</button>
            <a href="/admin/tenants.php" class="btn btn-secondary">Отмена</a>
        </div>
    </form>

    <script>
        const originalSubdomain = <?= json_encode((string) $tenant['subdomain']) ?>;
        const originalLegacy = <?= (int) !empty($tenant['legacy_compat']) ?>;

        document.getElementById('editForm').addEventListener('submit', function (e) {
            const subdomain = document.getElementById('subdomain').value.trim();
            const legacy = document.querySelector('[name="legacy_compat"]').checked ? 1 : 0;

            if (subdomain !== originalSubdomain) {
                if (!confirm('Вы меняете поддомен. Старые ссылки и закладки перестанут работать. Продолжить?')) {
                    e.preventDefault();
                    return;
                }
            }

            if (legacy !== originalLegacy) {
                if (!confirm(
                    'Вы меняете режим совместимости (legacy). Это может повлиять на работу уведомлений. Продолжить?'
                )) {
                    e.preventDefault();
                }
            }
        });
    </script>

</body>

</html>