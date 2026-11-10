<?php
declare(strict_types=1);
define('APP_ENTRY_POINT', true);
/**
 * Endpoint для очистки ОДНОГО тенанта из админки (AJAX).
 *
 * Вызывается из admin/tenants.php через fetch('/cr/cleanup_tenant.php').
 * Требует сессию админа.
 */

require_once __DIR__ . '/../bootstrap.php';
session_start();

header('Content-Type: application/json; charset=utf-8');

// Защита: только авторизованный админ
if (empty($_SESSION['admin_logged_in'])) {
    http_response_code(403);
    echo json_encode(['success' => false, 'error' => 'Unauthorized']);
    exit;
}

$id = $_POST['id'] ?? $_GET['id'] ?? null;
if (!$id) {
    http_response_code(400);
    echo json_encode(['success' => false, 'error' => 'Tenant ID required']);
    exit;
}

require_once __DIR__ . '/../cr/cleanup_notifications.php';

try {
    $registry = new \App\Registry();
    $tenants = $registry->listAll();

    $tenantData = null;
    foreach ($tenants as $t) {
        if ((string) $t['id'] === (string) $id) {
            $tenantData = $t;
            break;
        }
    }

    if (!$tenantData) {
        http_response_code(404);
        echo json_encode(['success' => false, 'error' => 'Tenant not found']);
        exit;
    }

    if (empty($tenantData['is_active'])) {
        http_response_code(400);
        echo json_encode(['success' => false, 'error' => 'Tenant is inactive']);
        exit;
    }

    if (!empty($tenantData['legacy_compat'])) {
        http_response_code(400);
        echo json_encode(['success' => false, 'error' => 'Legacy tenants do not have notifications']);
        exit;
    }

    $required = ['db_host', 'db_port', 'db_name', 'db_user', 'db_password'];
    foreach ($required as $field) {
        if (!isset($tenantData[$field]) || $tenantData[$field] === '') {
            throw new RuntimeException("Missing DB field: {$field}");
        }
    }

    $tenant = new \App\Tenant(
        (string) $tenantData['id'],
        $tenantData['org_name'],
        $tenantData['db_host'],
        (int) $tenantData['db_port'],
        $tenantData['db_name'],
        $tenantData['db_user'],
        \App\Support\Crypto::decrypt($tenantData['db_password']),
        (bool) ($tenantData['legacy_compat'] ?? true)
    );

    $cleanup = new CleanupNotifications();
    $deleted = $cleanup->cleanupForTenant($tenant);

    \App\Support\Logger::info("[cleanup-admin] {$tenantData['org_name']}: deleted {$deleted}");

    echo json_encode([
        'success' => true,
        'deleted' => $deleted,
        'message' => "Удалено {$deleted} уведомлений",
    ]);

} catch (Throwable $e) {
    http_response_code(500);
    echo json_encode([
        'success' => false,
        'error' => 'Cleanup failed: ' . $e->getMessage(),
    ]);
}