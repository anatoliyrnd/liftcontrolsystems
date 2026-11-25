/**
 * Глобальное хранилище роли и прав пользователя.
 * Заполняется один раз при инициализации SPA из ответа config.
 *
 * Модель: роль + контекст. Фронт сам решает, доступно ли действие,
 * на основе роли пользователя и текущего состояния заявки.
 *
 * REPORTS §17: уровень доступа к отчётам — свойство ТЕНАНТА, не
 * пользователя. Хранится здесь рядом с ролью, потому что точка
 * применения одна — menu-manager.initialize(). Матрицу уровней фронт
 * НЕ хранит: он рендерит присланные сервером reports_features /
 * reports_limits.
 *
 * Использование:
 *   userStore.setRole('dispatcher');
 *   userStore.can('close_ticket', { isAssigned: true });       // → true
 *   userStore.can('change_group', { currentValue: '' });       // → true
 *   userStore.can('change_group', { currentValue: '8' });      // → false
 *   userStore.hasReportFeature('export_csv');                  // → замок кнопки
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
   * §17: доступ к отчётам. null = поля reports_* не пришли.
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
  /** Сигнатура набора — чтобы событие reports:access не звало зря. */
  _reportsAccessSig: "",

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
   * §17: применить блок доступа из config. Возвращает true, если
   * что-то изменилось — menu-manager диспатчит reports:access только
   * при изменении, иначе повторный config по staff/dicts дёргал бы
   * перерисовку замков и пересборку формы на каждом полле.
   *
   * Пустой массив — валидное значение (light: способностей нет) и
   * обязан отличаться от null (гейта нет). Приведение [] → null
   * открыло бы light весь экран, поэтому проверяем именно Array.isArray.
   */
  setReportsAccess(level, features, limits) {
    const nextLevel = typeof level === "string" && level ? level : null;
    const nextFeatures = Array.isArray(features) ? features.map(String) : null;
    const nextLimits = limits && typeof limits === "object" ? limits : null;

    const sig = JSON.stringify([nextLevel, nextFeatures, nextLimits]);
    const changed = sig !== this._reportsAccessSig;
    this._reportsAccessSig = sig;
    this.reportsLevel = nextLevel;
    this.reportsFeatures = nextFeatures;
    this.reportsLimits = nextLimits;
    return changed;
  },

  /**
   * Булева способность: summary, export_csv, export_print, export_xlsx.
   * Ключи — из REPORTS.ACCESS.FEATURES, значения совпадают с серверными
   * константами ReportsAccess::FEATURE_*.
   */
  hasReportFeature(key) {
    if (this.reportsFeatures === null) return true;
    return this.reportsFeatures.includes(String(key));
  },

  /** Группа фильтров payload: date, address, department, status, staff, text… */
  reportGroupAllowed(group) {
    const groups = this.reportsLimits?.filter_groups;
    if (!Array.isArray(groups)) return true;
    return groups.includes(String(group));
  },

  /** Числовой потолок уровня; fallback — константа config.js (правило 8). */
  reportLimit(key, fallback) {
    const v = Number(this.reportsLimits?.[key]);
    return Number.isFinite(v) && v > 0 ? v : fallback;
  },

  /** light: отчёт только по конкретному лифту, дом/город недоступны. */
  reportObjectOnly() {
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

      // ---------- МЕНЮ ----------
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
