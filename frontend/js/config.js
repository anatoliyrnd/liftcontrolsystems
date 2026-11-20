/**
 * Глобальные константы проекта.
 *
 * Сгруппированы по слоям:
 *   API        — сетевые параметры
 *   VALIDATION — правила проверки пользовательского ввода
 *   UI         — тайминги и анимации интерфейса
 *   BUSINESS   — бизнес-значения и справочники
 *мёртвые константы: OFFLINE.SYNC_BATCH_SIZE, OFFLINE.MAX_SYNC_RETRIES, OFFLINE.SYNC_COOLDOWN_MS, SYNC.VERSIONS_STORAGE_KEY, API.TICKETS_REFRESH_MS.
 * Правила:
 *   1. Константа, используемая только в одном файле, живёт в этом файле.
 *   2. Сюда выносим то, что используется в 2+ местах или меняется при настройке.
 */

// ============================================================================
// API — сетевые параметры
// ============================================================================
export const API = {
  /** Единая точка входа шлюза */
  URL: "/api.php", // на поддомене sh.liftcs.ru
  URL_LEGACY: "/calls.php", // legacy (пока не перенесли config)

  /** Таймаут HTTP-запроса, мс */
  REQUEST_TIMEOUT_MS: 15000,

  /** Интервал автообновления журнала открытых заявок, мс */
  TICKETS_REFRESH_MS: 20000,

  /** Интервал опроса серверных уведомлений, мс */
  NOTIFICATIONS_POLL_MS: 120000,

  /** Ключ last_id уведомлений в localStorage */
  NOTIFICATIONS_STORAGE_KEY: "notificationsLastId",
};

// ============================================================================
// VALIDATION — правила проверки ввода
// ============================================================================
export const VALIDATION = {
  /** 5+ заглавных подряд — признак «капса» */
  CAPS_REGEX: /[А-ЯЁA-Z]{5,}/,

  /** Максимум заглавных подряд до срабатывания капса */
  MAX_CAPS_IN_ROW: 4,

  /** Минимум символов для текста решения при закрытии заявки */
  MIN_SOLUTION_LEN: 6,
};

// ============================================================================
// UI — тайминги и анимации интерфейса
// ============================================================================
export const UI = {
  /** Автовозврат в журнал после успешного сохранения, мс */
  AUTO_RETURN_MS: 20000,

  /** Разблокировка карточки/формы после ошибки сохранения, мс */
  ERROR_UNLOCK_MS: 3000,

  /** Пауза тишины для голосового ввода, мс */
  VOICE_SILENCE_MS: 5000,
  /**
   * Задержка редиректа на #/create после закрытия заявки
   * с галочкой «Закрыть и создать новую для этого объекта».
   * Короче AUTO_RETURN_MS: пользователь уже нажал галочку,
   * карточку читать не нужно — только увидеть статус «закрыта».
   */
  CLOSE_AND_CREATE_REDIRECT_MS: 3000,
  /** TTL флага «голосовой ввод недоступен» в localStorage, мс */
  VOICE_DISABLED_TTL_MS: 24 * 60 * 60 * 1000,

  /** Максимальное количество строк в блоке "История" */
  HISTORY_MAX_LINES: 5,
  /** Количество дней для фильтра "Скрыть долгосрочные заявки" */
  FILTER_REPAIR_DAYS: 14,

  /** Текст для чекбокса фильтра */
  FILTER_REPAIR_LABEL: "Скрыть заявки со сроком ремонта более 14 дней",
  /** Сколько последних адресов показывать в выпадающем списке */
  RECENT_ADDRESSES_LIMIT: 5,
};

// ============================================================================
// BUSINESS — бизнес-значения и справочники
// ============================================================================
export const BUSINESS = {
  /** Канал «Принял в работу» для механика — WEB */
  ACCEPT_CHANNEL: 2,
    /**
     * Быстрые шаблоны решения для модалки закрытия из контекстного меню.
     * UI-шорткаты, не справочник. Подмена из серверного config — на будущее
     * (прецедент: пресеты repair_time клиент игнорирует, §2.6 ⚠️).
     */
    QUICK_CLOSE_TEMPLATES: [
        "Перезапуск станции управления",
        "Освобождение пассажира из кабины",
        "Замена предохранителя в цепи управления",
        "Ложный вызов, неисправность не подтвердилась",
    ],
  /** Каналы уведомления для отображения статуса ответственного */
  NOTIFY_CHANNELS: {
    0: "— Не уведомлён —",
    1: "📞 По телефону",
    2: "🖥 WEB (онлайн)",
    3: "✈️ Telegram",
    4: "💬 Max",
    5: "🔵 VK",
    6: "📱 SMS",
    7: "✉️ Email",
  },
  // 🔥 Расшифровка позиций (ролей) сотрудников
  POSITIONS: {
    mechanic: "Механик",
    foreman: "Прораб",
    signalman: "Связист",
    "electronic-engineer": "Инженер-наладчик",
    director: "Директор",
    dispatcher: "Диспетчер",
    admin: "Администратор",
    auditor: "Аудитор",
  },
  /**
   * Маппинг event_type серверных событий → тип тоста (API_PROTOCOL §11.2).
   * Покрывает всё, что сервер генерирует или планирует генерировать.
   * Алиасы имён (ticket_note → note_added) — в notifications-poller.js.
   * Тип задаёт только оформление и дефолтный таймаут; sound и timeout
   * приходят с сервера и здесь не переопределяются (§11.1).
   */
  EVENT_TOAST_TYPE: {
    ticket_created: "info",
    ticket_closed: "success",
    ticket_edited: "info",
    note_added: "info",
    ticket_reassigned: "info",
    staff_accepted: "success",
    staff_unassigned: "warning",
    ticket_overdue: "warning",
    emergency: "error",
    // СПульт: сигнал не обработан либо обработан с расхождением.
    // ticket_id nullable, timeout: 0 и sound — с сервера.
    spult_error: "error",
  },
};
// ============================================================================
// AUTH — параметры авторизации (полка под будущую систему)
// ============================================================================
export const AUTH = {
  /** Временный флаг для обхода авторизации (для тестов на сервере) */
  BYPASS_AUTH: false, // <--- ВКЛЮЧИТЬ ДЛЯ ТЕСТА, ВЫКЛЮЧИТЬ (false) ДЛЯ ПРОДА

  /** true — используем auth_stub.php; false — реальный auth.php */
  USE_STUB: false,
  LOGIN_URL: "/auth.php", // на поддомене sh.liftcs.ru

  /** Ключи localStorage (только user, токен в памяти!) */
  USER_STORAGE_KEY: "lift_auth_user",
  WEBGL_STORAGE_KEY: "lift_auth_webgl",

  /**
   * УСТАРЕЛО: Ключ для хранения токена в localStorage.
   * В новой архитектуре (v1.1) access_token хранится только в памяти (authStore).
   * Оставлено для обратной совместимости, но нигде не используется.
   */
  // TOKEN_STORAGE_KEY: 'lift_auth_token',

  /** Роли */
  ROLES: {
    ADMIN: "administrator",
    DISPATCHER: "dispatcher",
    ENGINEER: "engineer",
    GUEST: "guest",
    RESERVED: "reserved",
  },
};

// ============================================================================
// SYNC — синхронизация справочников через polling
// ============================================================================
export const SYNC = {
  VERSIONS_STORAGE_KEY: "syncVersions",
  VERSIONS_PAYLOAD_KEY: "versions",
};
// ============================================================================
// OFFLINE — настройки офлайн-режима и синхронизации
// ============================================================================
export const OFFLINE = {
  /** Максимум офлайн-заявок на устройстве */
  MAX_OFFLINE_TICKETS: 50,

  /** Размер пачки для отправки на сервер (чтобы показывать прогресс) */
  SYNC_BATCH_SIZE: 10,

  /** Сколько раз пробуем отправить пачку при ошибке сети */
  MAX_SYNC_RETRIES: 5,

  /** Время блокировки кнопки синхронизации после 5 неудачных попыток (в мс) */
  SYNC_COOLDOWN_MS: 3 * 60 * 1000,
};
// ============================================================================
// REPORTS — модуль отчётов (§15 v6.2). Только онлайн, без outbox.
// ============================================================================
export const REPORTS = {
  /** Максимальная дельта периода, дней (90 календарных включительно) */
  MAX_RANGE_DAYS: 90,
  /** Минимальная длина полнотекстового поиска */
  MIN_TEXT_LEN: 6,
  /** Пагинация: сервер режет min(LIMIT_MAX, max(LIMIT_MIN, limit)) */
  LIMIT_DEFAULT: 50,
  LIMIT_MIN: 10,
  LIMIT_MAX: 200,
  /** Потолок строк экспорта; 2001-я строка на сервере = ошибка */
  EXPORT_MAX_ROWS: 2000,
  /** Кулдаун экспорта, с; читается из resp.retryAfterSec, это фолбэк */
  EXPORT_COOLDOWN_SEC: 30,
  /** Таймаут запроса экспорта, мс (аддитивный параметр api-service) */
  EXPORT_TIMEOUT_MS: 30000,
  /** Период по умолчанию при первом входе, дней назад */
  DEFAULT_PERIOD_DAYS: 7,
  /** Белый список сортировок; направление фиксировано сервером */
  SORTS: {
    date: "По дате",
    address: "По адресу",
    department: "По отделу",
  },
  SORT_DEFAULT: "date",
  TABS: {
    summary: "Сводка",
    byId: "Поиск по ID",
    advanced: "Расширенный поиск",
  },
  TAB_DEFAULT: "summary",
  /**
   * Пресеты сводки. Границы считает СЕРВЕР в МСК: неделя = понедельник→
   * сегодня, месяц = 1-е→сегодня. Подписи полные, не «7 дней»: пользователь
   * должен видеть, что период календарный, а не скользящий.
   */
  SUMMARY_PERIODS: {
    today: "Сегодня",
    "2days": "2 дня",
    week: "Текущая неделя",
    month: "Текущий месяц",
  },
  SUMMARY_PERIOD_DEFAULT: "today",
  /** Дебаунс автообновления сводки при серии кликов по городам, мс */
  SUMMARY_DEBOUNCE_MS: 250,
  /**
   * Корзины просрочки. Порядок = порядок строк в подсказке.
   * Диапазоны непересекающиеся, сумма совпадает с плиткой «Просрочено»:
   * накопительные подписи посчитали бы заявку дважды.
   */
  OVERDUE_BUCKETS: [
    { key: "lt_hour", label: "меньше часа" },
    { key: "lt_5hours", label: "от 1 до 5 часов" },
    { key: "lt_day", label: "от 5 часов до суток" },
    { key: "lt_week", label: "от суток до недели" },
    { key: "gte_week", label: "больше недели" },
  ],
  /**
   * Подсказки только на больших экранах с настоящим ховером.
   * На тач-устройствах тап «залипал» бы в открытом состоянии.
   * Порог продублирован в style.css (@media 1023px) — CSS не читает JS.
   */
  TOOLTIP_MIN_WIDTH: 1024,
  /** Пауза перед закрытием: курсор должен успеть войти в подсказку. */
  TOOLTIP_HIDE_DELAY_MS: 140,
  /**
   * Колонки отчёта — источник на клиенте (волна 1, сервер columns не
   * отдаёт). Форма — та, что ждёт normalizeReportSource в settings.js:
   * type "timestamp" станет dataType "date". sortable:false у всех:
   * header-render вешает клик только внутри if (col.sortable), значит
   * заголовки некликабельны и клиентский sorting.js не вызывается.
   */
  COLUMNS: [
    { id: "id", name: "№", type: "number", sortable: false, default_visible: true, minWidth: 80 },
    { id: "address", name: "Адрес", type: "string", sortable: false, default_visible: true, minWidth: 260 },
    { id: "details", name: "Описание проблемы", type: "string", sortable: false, default_visible: true, minWidth: 220 },
    { id: "department", name: "Отдел", type: "string", sortable: false, default_visible: true, minWidth: 160 },
    { id: "staff_name", name: "Ответственный", type: "string", sortable: false, default_visible: true, minWidth: 160 },
    { id: "notify_status", name: "Статус уведомления", type: "string", sortable: false, default_visible: true, minWidth: 220 },
    { id: "date", name: "Дата создания", type: "timestamp", sortable: false, default_visible: true, minWidth: 140 },
    { id: "repair_time", name: "Срок ремонта", type: "timestamp", sortable: false, default_visible: true, minWidth: 150 },
    { id: "close_date", name: "Дата закрытия", type: "timestamp", sortable: false, default_visible: true, minWidth: 140 },
    { id: "close_name", name: "Кто закрыл", type: "string", sortable: false, default_visible: true, minWidth: 150 },
    { id: "solution", name: "Решение/Устранение", type: "string", sortable: false, default_visible: true, minWidth: 180 },
    { id: "staff_name2", name: "Ответственный 2", type: "string", sortable: false, default_visible: false, minWidth: 160 },
    { id: "notify_status2", name: "Статус уведомления 2", type: "string", sortable: false, default_visible: false, minWidth: 220 },
    { id: "staff_name3", name: "Ответственный 3", type: "string", sortable: false, default_visible: false, minWidth: 160 },
    { id: "notify_status3", name: "Статус уведомления 3", type: "string", sortable: false, default_visible: false, minWidth: 220 },
  ],
};