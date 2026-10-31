/**
 * Глобальное хранилище роли и прав пользователя.
 * Заполняется один раз при инициализации SPA из ответа config.
 *
 * Модель: роль + контекст. Фронт сам решает, доступно ли действие,
 * на основе роли пользователя и текущего состояния заявки.
 *
 * Использование:
 *   userStore.setRole('dispatcher');
 *   userStore.can('close_ticket', { isAssigned: true });       // → true
 *   userStore.can('change_group', { currentValue: '' });       // → true (поле пусто)
 *   userStore.can('change_group', { currentValue: '8' });      // → false (уже заполнено)
 */
export const userStore = {
    /**
     * Допустимые роли. Всё, что приходит извне с другим значением,
     * нормализуется в 'guest' (fail-safe).
     */
    ROLES: ['administrator', 'dispatcher', 'engineer', 'guest', 'reserved'],

    /** Текущая роль. По умолчанию — гость. */
    role: 'guest',

    /** ID текущего пользователя. Заполняется из user_permissions.user_id. */
    userId: null,
    /**
     * Роли, которым разрешено базовое редактирование заявки.
     * Используется как быстрый фильтр в can().
     */
    ROLES_EDIT: ['administrator', 'dispatcher'],


    /**
     * Установить ID текущего пользователя (из user_permissions.user_id).
     */
    setUserId(id) {
        this.userId = (id != null) ? Number(id) : null;
    },
    setRole(newRole) {
        this.role = this.ROLES.includes(newRole) ? newRole : 'guest';
    },

    isAdmin()      { return this.role === 'administrator'; },
    isDispatcher() { return this.role === 'dispatcher'; },
    isEngineer()   { return this.role === 'engineer'; },
    isGuest()      { return this.role === 'guest' || this.role === 'reserved'; },
    canEditBase()  { return this.ROLES_EDIT.includes(this.role); },

    /**
     * Главный метод проверки права на действие.
     *
     * @param {string} action   — см. список ниже.
     * @param {Object} ctx      — контекст заявки (зависит от действия).
     * @returns {boolean}
     *
     * Контексты:
     *   {}                              — простые действия
     *   { currentValue }                — «только если поле пусто»
     *   { isAssigned }                  — «он в ответственных этой заявки»
     *   { notifyStatus }                — текущий статус уведомления
     */
    can(action, ctx = {}) {
        switch (action) {

            // ---------- БАЗОВЫЕ ----------
            case 'view_ticket':
                // Сервер уже отдал только те заявки, которые пользователь может видеть.
                return true;

            case 'create_ticket':
                return this.isAdmin() || this.isDispatcher();

            // ---------- РЕДАКТИРОВАНИЕ ЗАЯВКИ ----------
            case 'add_details':
            case 'close_ticket':
            case 'add_note':
                if (this.isAdmin() || this.isDispatcher()) return true;
                if (this.isEngineer() && ctx.isAssigned) return true;
                return false;

            // Назначение и снятие ответственных — только админ и диспетчер
            case 'assign_staff':
            case 'unassign_staff':
                return this.isAdmin() || this.isDispatcher();

            // Дата ремонта — только админ и диспетчер
            case 'set_repair_time':
                return this.isAdmin() || this.isDispatcher();
            // ---------- «ТОЛЬКО ЕСЛИ ПУСТО» ----------
            // Админ — всегда. Диспетчер — только если поле не заполнено.
            case 'change_group':
            case 'change_department':
            case 'change_level':
            case 'change_request':
                if (this.isAdmin()) return true;
                if (this.isDispatcher()) return !ctx.currentValue;
                return false;
            // ---------- СТАТУС УВЕДОМЛЕНИЯ ----------
            // Админ — всегда. Диспетчер — если пусто.
            // Механик — если он в ответственных заявки и статус пуст.
            case 'set_notify_status':
                if (this.isAdmin()) return true;
                if (this.isDispatcher()) return !ctx.notifyStatus;
                if (this.isEngineer())   return !!ctx.isAssigned && !ctx.notifyStatus;
                return false;

            // ---------- МЕНЮ (грубая проверка, что вообще имеет смысл показывать) ----------
            // Что видно в меню — решает сервер через menu_structure.required_permission.
            case 'view_reports':
                return this.isAdmin() || this.isDispatcher();

            default:
                console.warn('[userStore] Неизвестное действие:', action);
                return false;
        }
    },

    /**
     * Проверка «пользователь в ответственных этой заявки».
     * Используется для вычисления ctx.isAssigned перед вызовом can().
     * @param {Object} ticket
     * @param {number|string} currentUserId
     */
    isAssignedTo(ticket, currentUserId) {
        if (!ticket || currentUserId == null) return false;
        const ids = [ticket.staff_id, ticket.staff_id2, ticket.staff_id3];
        return ids.some(id => id != null && String(id) === String(currentUserId));
    }
};