import { REPORTS } from "./config.js";

/**
 * Глобальное хранилище роли и прав пользователя.
 * Заполняется один раз при инициализации SPA из ответа config.
 *
 * Модель: роль + контекст. Фронт сам решает, доступно ли действие,
 * на основе роли пользователя и текущего состояния заявки.
 *
 * §16: уровень доступа к отчётам — свойство ТЕНАНТА, не пользователя.
 * Хранится здесь рядом с ролью, потому что точка применения одна —
 * menu-manager.initialize(). Матрицу уровней фронт НЕ хранит: он
 * рендерит присланные сервером reports_features / reports_limits.
 *
 * Использование:
 *   userStore.setRole('dispatcher');
 *   userStore.can('close_ticket', { isAssigned: true });       // → true
 *   userStore.can('change_group', { currentValue: '' });       // → true (поле пусто)
 *   userStore.can('change_group', { currentValue: '8' });      // → false (уже заполнено)
 *   userStore.hasReportFeature('export_xlsx');                 // → замок кнопки
 */
export const userStore = {
  /**
   * Допустимые роли. Всё, что приходит извне с другим значением,
   * нормализуется в 'guest' (fail-safe).
   */
  ROLES: ["administrator", "dispatcher", "engineer", "guest", "reserved"],

  /** Текущая роль. По умолчанию — гость. */
  role: "guest",

  /** ID текущего пользователя. Заполняется из user_permissions.user_id. */
  userId: null,

  /**
   * §16: доступ к отчётам. null = поля reports_* не пришли.
   *
   * Дефолт null осознан и НЕ противоречит серверному fail-closed:
   * старый сервер без гейта разрешает всё, поэтому UI без замков
   * совпадает с его поведением. Сервер при неизвестном уровне режет
   * до light — разные слои, разные дефолты, расхождения нет.
   * Роль guest и так закрывает экран до первого config.
   */
  reportsLevel: null,
  reportsFeatures: null,
  reportsLimits: null,

  /**
   * Роли, которым разрешено базовое редактирование заявки.
   * Используется как быстрый фильтр в can().
   */
  ROLES_EDIT: ["administrator", "dispatcher"],

  /**
   * Установить ID текущего пользователя (из user_permissions.user_id).
   */
  setUserId(id) {
    this.userId = id != null ? Number(id) : null;
  },
  setRole(newRole) {
    this.role = this.ROLES.includes(newRole) ? newRole : "guest";
  },

  /**
   * §16: применить блок доступа из config. Возвращает true, если
   * что-то изменилось — menu-manager диспатчит reports:access только
   * при изменении, иначе повторный config по staff/dicts дёргал бы
   * перерисовку замков на каждом полле.
   *
   * Неизвестный уровень → null (без замков): сервер нормализует сам,
   * мусор сюда не доходит; клиент не выводит уровень заново.
   */
  setReportsAccess(level, features, limits) {
    const known = REPORTS.ACCESS.LEVELS;
    const nextLevel =
      typeof level === "string" &&
      Object.prototype.hasOwnProperty.call(known, level)
        ? level
        : null;
    const nextFeatures = Array.isArray(features) ? features.map(String) : null;
    const nextLimits =
      limits && typeof limits === "object" ? { ...limits } : null;

    const sig = (l, f, m) => JSON.stringify([l, f, m]);
    const changed =
      sig(this.reportsLevel, this.reportsFeatures, this.reportsLimits) !==
      sig(nextLevel, nextFeatures, nextLimits);

    this.reportsLevel = nextLevel;
    this.reportsFeatures = nextFeatures;
    this.reportsLimits = nextLimits;
    return changed;
  },

  /** §16: булева способность (сводка, форматы экспорта). */
  hasReportFeature(name) {
    if (this.reportsFeatures === null) return true;
    return this.reportsFeatures.includes(String(name));
  },

  /** §16: группа фильтров payload (date/address/department/status/…). */
  reportGroupAllowed(group) {
    const groups = this.reportsLimits?.filter_groups;
    if (!Array.isArray(groups)) return true;
    return groups.includes(String(group));
  },

  /**
   * §16: числовой лимит уровня с фолбэком на константу config.js.
   * Фолбэк — прежнее поведение standard (90 дней / 2000 строк):
   * сервер без reports_limits не должен сужать форму.
   */
  reportLimit(key, fallback) {
    const raw = this.reportsLimits?.[key];
    const n = Number(raw);
    return raw != null && Number.isFinite(n) ? n : fallback;
  },

  /** §16: light — отчёт только по конкретному лифту. */
  isObjectOnlyAddress() {
    return this.reportsLimits?.address_scope === "object_only";
  },

  isAdmin() {
    return this.role === "administrator";
  },
  isDispatcher() {
    return this.role === "dispatcher";
  },
  isEngineer() {
    return this.role === "engineer";
  },
  isGuest() {
    return this.role === "guest" || this.role === "reserved";
  },
  canEditBase() {
    return this.ROLES_EDIT.includes(this.role);
  },

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
      case "view_ticket":
        // Сервер уже отдал только те заявки, которые пользователь может видеть.
        return true;

      case "create_ticket":
        return this.isAdmin() || this.isDispatcher();

      // ---------- РЕДАКТИРОВАНИЕ ЗАЯВКИ ----------
      case "add_details":
      case "close_ticket":
      case "add_note":
        if (this.isAdmin() || this.isDispatcher()) return true;
        if (this.isEngineer() && ctx.isAssigned) return true;
        return false;

      // Назначение и снятие ответственных — только админ и диспетчер
      case "assign_staff":
      case "unassign_staff":
        return this.isAdmin() || this.isDispatcher();

      // Дата ремонта — только админ и диспетчер
      case "set_repair_time":
        return this.isAdmin() || this.isDispatcher();

      // ---------- «ТОЛЬКО ЕСЛИ ПУСТО» ----------
      // Админ — всегда. Диспетчер — только если поле не заполнено.
      case "change_group":
      case "change_department":
      case "change_level":
      case "change_request":
        if (this.isAdmin()) return true;
        if (this.isDispatcher()) return !ctx.currentValue;
        return false;

      // ---------- СТАТУС УВЕДОМЛЕНИЯ ----------
      // Админ — всегда. Диспетчер — если пусто.
      // Механик — если он в ответственных заявки и статус пуст.
      case "set_notify_status":
        if (this.isAdmin()) return true;
        if (this.isDispatcher()) return !ctx.notifyStatus;
        if (this.isEngineer()) return !!ctx.isAssigned && !ctx.notifyStatus;
        return false;

      // ---------- МЕНЮ (грубая проверка, что вообще имеет смысл показывать) ----------
      // Что видно в меню — решает сервер через menu_structure.required_permission.
      case "view_reports":
        return this.isAdmin() || this.isDispatcher();

      default:
        console.warn("[userStore] Неизвестное действие:", action);
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
    return ids.some((id) => id != null && String(id) === String(currentUserId));
  },
};
