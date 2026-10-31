<?php
declare(strict_types=1);
require_once __DIR__ . '/../config/admin.php';
session_start();

if (isset($_GET['logout'])) {
    session_destroy();
    header('Location: /admin/');
    exit;
}

$error = '';
if ($_SERVER['REQUEST_METHOD'] === 'POST') {
    $pass = $_POST['password'] ?? '';
    if (password_verify($pass, ADMIN_PASSWORD_HASH)) {
        $_SESSION['admin_logged_in'] = true;
        header('Location: /admin/tenants.php');
        exit;
    } else {
        $error = 'Неверный пароль';
    }
}

if (!empty($_SESSION['admin_logged_in'])) {
    header('Location: /admin/tenants.php');
    exit;
}
?>
<!DOCTYPE html>
<html lang="ru">

<head>
    <meta charset="UTF-8">
    <title>Вход в админку</title>
</head>

<body style="font-family:sans-serif; max-width:400px; margin:50px auto;">
    <h2>Управление организациями</h2>
    <?php if ($error)
        echo "<p style='color:red;'>$error</p>"; ?>
    <form method="POST">
        <input type="password" name="password" placeholder="Пароль" required
            style="width:100%; padding:10px; margin-bottom:10px;">
        <button type="submit" style="width:100%; padding:10px;">Войти</button>
    </form>
</body>

</html>