<?php
declare(strict_types=1);
namespace App\Service;

use App\Database\DB;

final class ConfigService
{
    public function __construct(private readonly DB $db)
    {
    }

    public function getConfig(array $user): array
    {
        // Получаем флаги для доп. проверок
        $u = $this->db->fetchOne("SELECT user_add_call FROM lift_users WHERE user_id = :id", ['id' => $user['id']]) ?: [];

        // ДОВЕРЯЕМ РОЛИ ИЗ AuthService, а не старым флагам!
        $role = $user['role'] ?? 'guest';

        $isAdmin = ($role === 'administrator');
        $isDisp = ($role === 'dispatcher');
        $canAdd = $isAdmin || $isDisp || !empty($u['user_add_call']);
        $readAll = $isAdmin || $isDisp;

        // Старый формат прав (для совместимости)
        $nav = [
            $user['id'],       // 0: user_id
            $readAll,          // 1: read_all
            $isAdmin || $isDisp, // 2: edit_call
            $isAdmin || $isDisp, // 3: close_call
            true,              // 4: note_call
            $canAdd,           // 5: add_call
            $isAdmin,          // 6: edit_user
            $isAdmin,          // 7: edit_obj
            $isAdmin           // 8: local_admin
        ];

        // Новый формат меню (v4.0)
        $menu = [];
        if ($canAdd) {
            $menu[] = [
                'id' => 'create',
                'title' => 'Добавить заявку',
                'type' => 'icon-button',
                'icon_svg' => "<svg viewBox='0 0 24 24' width='20' height='20' fill='currentColor'><path d='M19 13h-6v6h-2v-6H5v-2h6V5h2v6h6v2z'/></svg>",
                'target_hash' => '#/create',
                'required_permission' => 'can_add_ticket'
            ];
        }
        $menu[] = ['id' => 'open_tickets', 'title' => 'Открытые заявки', 'type' => 'nav-link', 'target_hash' => '#/', 'is_default' => true];
        $menu[] = ['id' => 'closed_tickets', 'title' => 'Закрытые заявки', 'type' => 'nav-link', 'target_hash' => '#/closed'];

        return [
            'user_permissions' => [
                'role' => $role,
                'user_id' => $user['id'],
                'can_add_ticket' => $canAdd,
                'can_view_reports' => true,
                'can_view_settings' => true
            ],
            'menu_structure' => $menu,
            'nav' => $nav,
            'staff' => $this->getDict(5),
            'staff_list' => $this->getStaffList(),
            'department' => $this->getDict(1),
            'request' => $this->getDict(2),
            'group' => $this->getDict(3),
            'repair_time' => ['не указан', '30 мин', 'Сегодня', 'Завтра', 'Три дня', '7 дней', '10 дней', '15 дней', '1 месяц', '3 месяца']
        ];
    }

    private function getDict(int $type): array
    {
        $rows = $this->db->fetchAll("SELECT type_id, type_name FROM lift_types WHERE type = :t ORDER BY type_name", ['t' => $type]);
        $result = [];
        foreach ($rows as $r) {
            $result[$r['type_id']] = $r['type_name'];
        }
        return $result;
    }

    private function getStaffList(): array
    {
        $rows = $this->db->fetchAll("SELECT user_id, user_name, user_phone FROM lift_users WHERE (user_level = 2 OR user_level = 0) AND user_block <> 1 ORDER BY user_name");
        return array_map(function ($r) {
            return [
                'id' => (int) $r['user_id'],
                'name' => $r['user_name'],
                'phone' => $r['user_phone'] ?: null
            ];
        }, $rows);
    }
}