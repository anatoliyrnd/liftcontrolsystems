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

    /**
     * Конфигурация и права для SPA (§2).
     *
     * Роль берётся из AuthService::formatUser — нормализация
     * mechanic → engineer и foreman → dispatcher уже выполнена там.
     * Повторно не выводим: два источника роли рано или поздно разъезжаются.
     */
    public function getConfig(array $user): array
    {
        // Один запрос на два поля: флаг создания и позиция для прав отчётов.
        // Отдельный SELECT для позиции не нужен — она лежит в той же строке.
        $u = $this->db->fetchOne(
            "SELECT user_add_call, user_position FROM lift_users WHERE user_id = :id",
            ['id' => $user['id']]
        ) ?: [];

        $role    = $user['role'] ?? 'guest';
        $isAdmin = ($role === 'administrator');
        $isDisp  = ($role === 'dispatcher');

        // §2.2: флаг user_add_call даёт право создания любому, включая engineer.
        // Конфликт с sync-путём (там только admin/dispatcher) закрывается
        // в B3 через CallPolicy — здесь поведение не меняем.
        $canAdd  = $isAdmin || $isDisp || !empty($u['user_add_call']);
        $readAll = $isAdmin || $isDisp;

        $position = trim((string) ($u['user_position'] ?? ''));

        // --- Меню (§2.4) ---
        $menu = [];

        if ($canAdd) {
            $menu[] = [
                'id'                  => 'create',
                'title'               => 'Добавить заявку',
                'type'                => 'icon-button',
                'icon_svg'            => "<svg viewBox='0 0 24 24' width='20' height='20' fill='currentColor'><path d='M19 13h-6v6h-2v-6H5v-2h6V5h2v6h6v2z'/></svg>",
                'target_hash'         => '#/create',
                'required_permission' => 'can_add_ticket',
            ];
        }

        $menu[] = ['id' => 'open_tickets', 'title' => 'Открытые заявки', 'type' => 'nav-link', 'target_hash' => '#/', 'is_default' => true];
        $menu[] = ['id' => 'closed_tickets', 'title' => 'Закрытые заявки', 'type' => 'nav-link', 'target_hash' => '#/closed'];

        if ($isAdmin || $isDisp) {
            // B1.10: reports оставлен по решению — фронт покажет заглушку
            // до этапа отчётов. Требует placeholder-роута #/reports.
            $menu[] = ['id' => 'reports', 'title' => 'Отчеты', 'type' => 'nav-link', 'target_hash' => '#/reports'];

            // addresses удалён (B1.10): роута #/addresses нет, клик давал 404.
            // Вернуть вместе с реализацией экрана.
        }

        if ($isAdmin) {
            $menu[] = ['id' => 'settings', 'title' => 'Настройки', 'type' => 'nav-link', 'target_hash' => '#/settings'];
        }

        // more удалён (B1.10): роута #/more нет, клик давал 404.

        $result = [
            'user_permissions' => [
                'role'              => $role,
                'user_id'           => (int) $user['id'],
                // §2.1: правило отчётов «прораб фильтрует по ответственному»
                // опирается на position, а не на role. Без поля прораб
                // на фронте неотличим от диспетчера.
                'user_position'     => $position !== '' ? $position : null,
                'can_add_ticket'    => $canAdd,
                'can_view_reports'  => $isAdmin || $isDisp,
                'can_view_settings' => $isAdmin,
            ],
            'is_legacy'      => $this->tenant->legacyCompat,
            'menu_structure' => $menu,
            'staff'          => $this->getDict(5),
            'staff_list'     => $this->getStaffList(),
            'department'     => $this->getDict(1),
            'request'        => $this->getDict(2),
            'group'          => $this->getDict(3),
            'repair_time'    => ['не указан', '30 мин', 'Сегодня', 'Завтра', 'Три дня', '7 дней', '10 дней', '15 дней', '1 месяц', '3 месяца'],
        ];

        // Легаси-совместимость (Приложение A). Новый SPA эти поля не читает,
        // их использует прокси-слой. Состав и порядок 9 элементов не менять.
        if ($this->tenant->legacyCompat) {
            $result['nav'] = [
                $user['id'],           // 0: user_id
                $readAll,              // 1: read_all
                $isAdmin || $isDisp,   // 2: edit_call
                $isAdmin || $isDisp,   // 3: close_call
                true,                  // 4: note_call
                $canAdd,               // 5: add_call
                $isAdmin,              // 6: edit_user
                $isAdmin,              // 7: edit_obj
                $isAdmin,              // 8: local_admin
            ];
        }

        return $result;
    }

    /**
     * Справочник lift_types по категории: 1 отделы, 2 типы, 3 группы, 5 служебный.
     * Ассоциативный объект {"id": "name"}, сортировка по названию.
     */
    private function getDict(int $type): array
    {
        $rows = $this->db->fetchAll(
            "SELECT type_id, type_name FROM lift_types WHERE type = :t ORDER BY type_name",
            ['t' => $type]
        );

        $result = [];
        foreach ($rows as $r) {
            $result[$r['type_id']] = $r['type_name'];
        }

        return $result;
    }

    /**
     * Список ответственных (B1.9, §2.5).
     *
     * Попадают механики, прорабы, связисты и электронищики. Диспетчеры — нет:
     * они назначают, а не исполняют. Вторая ветка WHERE — страховка для
     * записей без user_position, иначе легаси-механики исчезли бы из списка.
     *
     * Поля: id, name, phone, role (для прав), position (для подписи должности).
     * Словарь подписей на клиенте: mechanic → Механик, foreman → Прораб,
     * signalman → Связист, electronic-engineer → Инженер-наладчик,
     * director → Директор. Неизвестное → «Сотрудник».
     */
    private function getStaffList(): array
    {
        $rows = $this->db->fetchAll("
            SELECT user_id, user_name, user_phone, user_role, user_position
            FROM lift_users
            WHERE user_block <> 1
              AND (
                    user_position IN ('mechanic','foreman','signalman','electronic-engineer')
                    OR (
                         (user_position IS NULL OR user_position = '')
                         AND user_role IN ('mechanic','engineer')
                    )
                  )
            ORDER BY user_name
        ");

        return array_map(static function (array $r): array {
            $position = (string) ($r['user_position'] ?? '');

            if ($position === '') {
                // Без позиции UI показал бы «Сотрудник» вместо «Механик».
                $position = in_array($r['user_role'], ['mechanic', 'engineer'], true)
                    ? 'mechanic'
                    : '';
            }

            return [
                'id'       => (int) $r['user_id'],
                'name'     => $r['user_name'],
                'phone'    => $r['user_phone'] ?: null,
                'role'     => $r['user_role'] ?: null,
                'position' => $position !== '' ? $position : null,
            ];
        }, $rows);
    }
}