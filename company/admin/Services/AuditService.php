<?php
declare(strict_types=1);
namespace Company\Admin\Services;

use App\Database\DB;

final class AuditService
{
    public function __construct(private readonly DB $db) {}

    public function log(string $action, array $params = [], ?int $userId = null): void
    {
        $this->db->insert('audit_log', [
            'user_id'    => $userId ?? (int) ($_SESSION['user_id'] ?? 0),
            'action'     => $action,
            'params'     => json_encode($params, JSON_UNESCAPED_UNICODE),
            'created_at' => time(),
        ]);
    }
}