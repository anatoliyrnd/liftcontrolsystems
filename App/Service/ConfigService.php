<?php
declare(strict_types=1);
namespace App\Service;

use App\Database\DB;
use App\Tenant;

final class ConfigService
{
    public function __construct(
        private readonly DB $db,
        private readonly Tenant $tenant
    ) {
    }

    // ✅ Убрали $includeLegacy из аргументов
    public function getConfig(array $user): array
    {
        // Получаем флаги для доп. проверок
        $u = $this->db->fetchOne("SELECT user_add_call FROM lift_users WHERE user_id = :id", ['id' => $user['id']]) ?: [];

        // ДОВЕРЯЕМ РОЛИ ИЗ AuthService
        $role = $user['role'] ?? 'guest';
        $isAdmin = ($role === 'administrator');
        $isDisp = ($role === 'dispatcher');
        $canAdd = $isAdmin || $isDisp || !empty($u['user_add_call']);
        $readAll = $isAdmin || $isDisp;

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

        if ($isAdmin || $isDisp) {
            $menu[] = ['id' => 'reports', 'title' => 'Отчеты', 'type' => 'nav-link', 'target_hash' => '#/reports'];
            $menu[] = ['id' => 'addresses', 'title' => 'Адреса', 'type' => 'nav-link', 'target_hash' => '#/addresses'];
        }

        if ($isAdmin) {
            $menu[] = ['id' => 'settings', 'title' => 'Настройки', 'type' => 'nav-link', 'target_hash' => '#/settings'];
        }

        $menu[] = ['id' => 'more', 'title' => 'Прочее', 'type' => 'nav-link', 'target_hash' => '#/more'];

        $result = [
            'user_permissions' => [
                'role' => $role,
                'user_id' => $user['id'],
                'can_add_ticket' => $canAdd,
                'can_view_reports' => $isAdmin || $isDisp,
                'can_view_settings' => $isAdmin
            ],
            'is_legacy' => $this->tenant->legacyCompat, // Отдаем флаг на фронт
            'menu_structure' => $menu,
            'staff' => $this->getDict(5),
            'staff_list' => $this->getStaffList(),
            'department' => $this->getDict(1),
            'request' => $this->getDict(2),
            'group' => $this->getDict(3),
            'repair_time' => ['не указан', '30 мин', 'Сегодня', 'Завтра', 'Три дня', '7 дней', '10 дней', '15 дней', '1 месяц', '3 месяца']
        ];

        // 🔥 ИСПРАВЛЕНО: Проверяем свойство тенанта, а не аргумент
        if ($this->tenant->legacyCompat) {
            $nav = [
                $user['id'],           // 0: user_id
                $readAll,              // 1: read_all
                $isAdmin || $isDisp,   // 2: edit_call
                $isAdmin || $isDisp,   // 3: close_call
                true,                  // 4: note_call
                $canAdd,               // 5: add_call
                $isAdmin,              // 6: edit_user
                $isAdmin,              // 7: edit_obj
                $isAdmin               // 8: local_admin
            ];
            $result['nav'] = $nav;
        }

        return $result;
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
    /**

     * Ожидаемые поля в объекте:
     *   - id (int)
     *   - name (string)
     *   - phone (string|null)
     *   - role (string)
     *   - position
     * Используемые фронтендом роли (для красивых ярлыков):
     *   - 'mechanic'               -> "Механик"
     *   - 'foreman'                -> "Прораб"
     *   - 'signalman'              -> "Связист"
     *   - 'electronic-engineer'    -> "Инженер-наладчик"
     *   - 'director'               -> "Директор"
     * 
     * Если бэкенд пришлет роль, которой нет в словаре (например, 'driver'), 
     * фронтенд просто выведет имя и подпись "Сотрудник".
     */
    private function getStaffList(): array
    {
        $rows = $this->db->fetchAll("
        SELECT user_id, user_name, user_phone, user_role, user_position 
        FROM lift_users 
        WHERE (user_role = 'mechanic' OR user_role = 'engineer' OR user_position = 'foreman')
          AND user_block <> 1
        ORDER BY user_name
    ");

        return array_map(function ($r) {
            return [
                'id' => (int) $r['user_id'],
                'name' => $r['user_name'],
                'phone' => $r['user_phone'] ?: null,
                'role' => $r['user_role'] ?: null,
                'position' => $r['user_position'] ?: null
            ];
        }, $rows);
    }
}