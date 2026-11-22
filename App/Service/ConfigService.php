<?php

declare(strict_types=1);

namespace App\Service;

use App\Database\DB;
use App\Support\CallPolicy;
use App\Support\CallScope;
use App\Support\DemoGuard;
use App\Tenant;

/**
 * Конфигурация SPA: права, меню, справочники.
 *
 * ИНВАРИАНТ: пункт меню и право на тот же экран вычисляются ОДНИМ
 * выражением. Раньше «$isAdmin || $isDisp» стояло и в условии меню,
 * и в can_view_reports — правка одного места давала пункт, на который
 * сервер отвечает отказом.
 *
 * ТОТ ЖЕ ИНВАРИАНТ для can_edit_profile: флаг обязан совпадать с тем,
 * что ответит save_user_settings. Решение принимает DemoGuard, здесь
 * только выдача. Своя формула «role !== admin» или проверка хоста
 * дали бы второй источник, и клиент рисовал бы разрешённое поле там,
 * где сервер откажет.
 */
final class ConfigService
{
    public function __construct(
        private readonly DB $db,
        private readonly Tenant $tenant
    ) {
    }

    /* Роль, флаги и должность берутся из AuthService::formatUser —
     * нормализация mechanic → engineer и foreman → dispatcher уже
     * выполнена там. Повторно не выводим: два источника роли рано или
     * поздно разъезжаются.
     *
     * Права считает CallPolicy, область чтения — CallScope, режим демо —
     * DemoGuard: те же предикаты отвечают на само действие. Своя формула
     * здесь давала кнопку, на которую сервер отвечал 403.
     */
    public function getConfig(array $user): array
    {
        $role    = (string) ($user['role'] ?? 'guest');
        $isAdmin = ($role === 'administrator');
        $isDisp  = ($role === 'dispatcher');

        // ?? обязателен: config — первый запрос SPA после авторизации.
        // При битой сессии необъявленный ключ даёт Warning, а
        // set_error_handler превращает его в ErrorException: не грузится
        // ни журнал, ни меню, ни справочники — экран остаётся пустым.
        // Приведение одно на оба места выдачи (user_permissions и nav[0]),
        // чтобы id не мог разойтись сам с собой в одном ответе.
        $uid = (int) ($user['id'] ?? 0);

        // Решение отдаём политике: can_add_ticket обязан совпадать с тем,
        // что ответит callnew.
        $canAdd  = CallPolicy::canCreate($user);

        // Область чтения — CallScope: флаг user_read_all_calls уважается
        // для любой роли (решение A), а не только admin/dispatcher.
        $readAll = CallScope::readAll($user);

        // Правила экранов — один раз, дальше уходят и в меню, и в права.
        //
        // Известное расхождение (§15.6): инженер с position=foreman
        // пункта «Отчеты» не увидит, но доступ по прямой ссылке получит —
        // область чтения шире меню. Волной 1 не расширяем осознанно.
        $canViewReports  = $isAdmin || $isDisp;
        $canViewSettings = $isAdmin;

        // Демо-тенант: учётки общие, смена пароля одним посетителем
        // запирает вход остальным, а смена ФИО подменяет автора во всех
        // заявках и заметках. Запрет на тенант, не на роль — включая
        // администратора: именно он меняет пароль себе и запирает остальных.
        //
        // Идентичность по поддомену И имени БД: переименование любого
        // из атрибутов не должно молча снимать запрет. Оба значения
        // проверены на сервере (id=demo, db=zamotaev_demo_liftcs).
        //
        // can_view_settings при этом НЕ меняется: экран настроек остаётся
        // доступным, блокируется только запись учётной записи. Настройки
        // колонок персональны и безвредны, их сохранение обязано работать.
        $canEditProfile = DemoGuard::canEditProfile($this->tenant->id, $this->tenant->dbName);

        // Должность — бизнес-тип, не роль: по ней фронт отличает прораба
        // от диспетчера (§2.1, отчёты). Пустая и NULL = «не задана».
        $position = trim((string) ($user['user_position'] ?? ''));

        $result = [
            'user_permissions' => [
                'role'              => $role,
                'user_id'           => $uid,
                // §2.1: правило отчётов «прораб фильтрует по ответственному»
                // опирается на position, а не на role.
                'user_position'     => $position !== '' ? $position : null,
                'can_add_ticket'    => $canAdd,
                'can_view_reports'  => $canViewReports,
                'can_view_settings' => $canViewSettings,
                // Аддитивное поле. Клиент обязан читать его, а не выводить
                // из role или домена: серверный отказ придёт по предикату
                // DemoGuard, и клиентское «мне кажется, это демо» разойдётся.
                //
                // Отсутствует у старых клиентов — они поле игнорируют,
                // контракт не ломается. Экшен save_user_settings пока не
                // реализован, поэтому флаг сегодня обслуживает только UI;
                // при появлении экшена тот же предикат встанет перед записью.
                'can_edit_profile'  => $canEditProfile,
            ],
            'is_legacy'      => $this->tenant->legacyCompat,
            'menu_structure' => $this->buildMenu($canAdd, $canViewReports, $canViewSettings),
            'staff'          => $this->getDict(5),
            'staff_list'     => $this->getStaffList(),
            'department'     => $this->getDict(1),
            'request'        => $this->getDict(2),
            'group'          => $this->getDict(3),
            'repair_time'    => ['не указан', '30 мин', 'Сегодня', 'Завтра', 'Три дня', '7 дней', '10 дней', '15 дней', '1 месяц', '3 месяца'],
        ];

        // Легаси-совместимость (Приложение A). Новый SPA эти поля не читает,
        // их использует прокси-слой. Состав и порядок 9 элементов не менять.
        //
        // Значения прав на заявки берём из CallPolicy, а не выводим из роли:
        // легаси-UI показывал кнопку, на которую сервер отвечал 403.
        // Контракт прокси — структура массива, а не конкретные значения.
        //
        // Контекст заявки здесь null: config сообщает возможность в принципе.
        // Права на конкретную заявку считает карточка (findByIdDetailed)
        // теми же предикатами, но уже с $call.
        //
        // Пункты 6–8 остаются ролевыми: это права на пользователей и объекты,
        // для них политика ещё не заведена — подменять их заявочной нельзя.
        // can_edit_profile сюда НЕ добавляется: массив позиционный, десятый
        // элемент сдвинул бы контракт прокси. Легаси-двери у демо нет.
        if ($this->tenant->legacyCompat) {
            $result['nav'] = [
                $uid,                           // 0: user_id (formatUser уже отдаёт int)
                $readAll,                       // 1: read_all
                CallPolicy::canEdit($user),     // 2: edit_call
                CallPolicy::canClose($user),    // 3: close_call
                CallPolicy::canComment($user),  // 4: note_call
                $canAdd,                        // 5: add_call
                $isAdmin,                       // 6: edit_user
                $isAdmin,                       // 7: edit_obj
                $isAdmin,                       // 8: local_admin
            ];
        }

        return $result;
    }

    /**
     * Меню (§2.4).
     *
     * Зависимости — те же самые булевы, что ушли в user_permissions.
     * Условия не выводятся здесь заново: меню должно быть проекцией
     * прав, а не второй их копией.
     *
     * SVG оставлен литералом: это данные пункта, а не шаблонизация.
     */
    private function buildMenu(bool $canAdd, bool $canViewReports, bool $canViewSettings): array
    {
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

        if ($canViewReports) {
            // B1.10: reports оставлен по решению. Роут #/reports зарегистрирован.
            $menu[] = ['id' => 'reports', 'title' => 'Отчеты', 'type' => 'nav-link', 'target_hash' => '#/reports'];

            // addresses удалён (B1.10): роута #/addresses нет, клик давал 404.
            // Вернуть вместе с реализацией экрана.
        }

        if ($canViewSettings) {
            $menu[] = ['id' => 'settings', 'title' => 'Настройки', 'type' => 'nav-link', 'target_hash' => '#/settings'];
        }

        // more удалён (B1.10): роута #/more нет, клик давал 404.

        return $menu;
    }

    /**
     * Справочник lift_types по категории: 1 отделы, 2 типы, 3 группы, 5 служебный.
     * Ассоциативный объект {"id": "name"}, сортировка по названию.
     *
     * Фильтра по vis нет намеренно: колонки vis в lift_types не существует.
     *
     * Тай-брейк type_id: одинаковые type_name в справочнике встречаются,
     * без второго ключа порядок строк менялся бы между запросами и
     * выпадающий список переставлял бы пункты на ровном месте.
     *
     * Пустая категория уйдёт в JSON как [], а не {}: тип массива сохранён
     * ради PHP-потребителей ответа. Клиент читает по ключу, для него
     * разницы нет.
     */
    private function getDict(int $type): array
    {
        $rows = $this->db->fetchAll(
            "SELECT type_id, type_name FROM lift_types WHERE type = :t ORDER BY type_name, type_id",
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
     * user_block в схеме NOT NULL DEFAULT 0, поэтому NULL-ловушки здесь нет.
     * Условие `(user_block IS NULL OR user_block <> 1)` оставлено как защита
     * на случай смены схемы: оно эквивалентно простому <> 1 при NOT NULL
     * и не теряет строки при NULL. Прежний комментарий утверждал, что
     * колонка NULLABLE — это было неверно, проверено по DDL.
     *
     * user_hiden здесь НЕ фильтруется осознанно: скрытие управляет списком
     * быстрого входа, а не возможностью назначить человека ответственным.
     * Добавление фильтра убрало бы людей из выпадающего списка действующих
     * заявок — это регресс, а не наведение порядка.
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
            WHERE (user_block IS NULL OR user_block <> 1)
              AND (
                user_position IN ('mechanic','foreman','signalman','electronic-engineer')
                OR (
                  (user_position IS NULL OR user_position = '')
                  AND user_role IN ('mechanic','engineer')
                )
              )
            ORDER BY user_name, user_id
        ");

        return array_map(static function (array $r): array {
            $id   = (int) $r['user_id'];
            $role = (string) ($r['user_role'] ?? '');

            $position = (string) ($r['user_position'] ?? '');
            if ($position === '') {
                // Без позиции UI показал бы «Сотрудник» вместо «Механик».
                $position = in_array($role, ['mechanic', 'engineer'], true)
                    ? 'mechanic'
                    : '';
            }

            // Пустое имя — невыбираемый пункт списка: диспетчер видит
            // пустую строку и не может назначить человека. Фолбэк тот же,
            // что в listQuickLogin: молча выкинуть сотрудника нельзя,
            // это закрыло бы назначение на него без объяснений.
            $name = trim((string) ($r['user_name'] ?? ''));
            if ($name === '') {
                $name = 'Сотрудник №' . $id;
            }

            return [
                'id'       => $id,
                'name'     => $name,
                'phone'    => ($r['user_phone'] ?? '') ?: null,
                'role'     => $role !== '' ? $role : null,
                'position' => $position !== '' ? $position : null,
            ];
        }, $rows);
    }
}