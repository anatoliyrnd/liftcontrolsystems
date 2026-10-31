<?php
declare(strict_types=1);
require_once __DIR__ . '/../autoload.php';
session_start();

if (empty($_SESSION['admin_logged_in'])) {
    header('Location: /admin/');
    exit;
}

$registry = new \App\Registry();
$action = $_POST['action'] ?? '';

if ($action === 'add') {
    try {
        $registry->save($_POST);
    } catch (\Exception $e) {
        die('Ошибка: ' . $e->getMessage());
    }
} elseif ($action === 'toggle') {
    $id = (int) $_POST['id'];
    $newStatus = (int) !($_POST['current_status'] ?? 0); // Инвертируем (можно передавать точное значение)
    // Упрощенно: просто вызовем toggle
    $registry->toggle($id, $newStatus);
}

header('Location: /admin/tenants.php');
exit;