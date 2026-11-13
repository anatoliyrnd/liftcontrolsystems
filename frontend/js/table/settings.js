/**
 * Настройки таблиц: per-user и per-scope (ТЗ волна 3).
 *
 * 3.1 — на уровне модуля localStorage НЕ читается: до авторизации
 *       работают только дефолты, гостевой scope не заводится (3.4).
 * 3.2 — ключи: lift:{userId}:table:{scope}:order|hidden|widths|sortCol|sortDir,
 *              lift:{userId}:table:close:period,
 *              lift:{userId}:filters:open:cities|hideLong
 * 3.3 — ширины только локально, на сервер не уходят.
 * 3.5 — старые глобальные ключи игнорируются, миграция не выполняется.
 * 3.6 — getFreezeLeftOffset(scope): своя ширина id у отчётов.
 * 3.9 — applyUserSettings(userId, null) применяет локальный кэш мгновенно;
 *       applyUserSettings(userId, serverSettings) — серверные order/hidden
 *       поверх кэша с перезаписью кэша.
 *
 * ИСТОЧНИК КОЛОНОК:
 *   open / close — DEFAULT_COLUMNS (журнальные дефолты);
 *   report       — серверный reports_list.columns (§15.4), хранится
 *                  в state.reportSource. Журнальные дефолты к отчёту
 *                  не применяются никогда.
 *
 * Совместимость: tableSettings.columns — живой массив колонок активного
 * scope; body-render / header-render / sorting / drag-drop / resizer
 * работают без изменений структуры.
 */

const KEY_PREFIX = "lift";
const SCOPES = ["open", "close", "report"];
const DEFAULT_SCOPE = "open";
const DEFAULT_ID_WIDTH = 80;

/** Структурно скрытые колонки по режиму — пользователь их не открывает. */
export const HIDDEN_IN_MODE = {
    open: ["solution", "close_name", "close_date"],
    close: [],
    report: [],
};

/** Дефолты колонок журналов (3.1). */
export const DEFAULT_COLUMNS = [
    { id: "id", name: "№", sortable: true, dataType: "number", isAbsoluteFixed: true, minWidth: 80 },
    { id: "address", name: "Адрес", sortable: true, dataType: "string", isAbsoluteFixed: true, minWidth: 260 },
    { id: "details", name: "Описание проблемы", sortable: false, dataType: "string", isRequired: true, minWidth: 220 },
    { id: "staff_name", name: "Ответственный", sortable: true, dataType: "string", isRequired: true, minWidth: 160 },
    { id: "date", name: "Дата создания", sortable: true, dataType: "date", minWidth: 140 },
    { id: "notify_status", name: "Статус уведомления", sortable: true, dataType: "string", minWidth: 220 },
    { id: "staff_name2", name: "Ответственный 2", sortable: true, dataType: "string", hidden: true, minWidth: 160 },
    { id: "notify_status2", name: "Статус уведомления 2", sortable: true, dataType: "string", hidden: true, minWidth: 220 },
    { id: "staff_name3", name: "Ответственный 3", sortable: true, dataType: "string", hidden: true, minWidth: 160 },
    { id: "notify_status3", name: "Статус уведомления 3", sortable: true, dataType: "string", hidden: true, minWidth: 220 },
    { id: "repair_time", name: "Дата ремонта", sortable: true, dataType: "date", minWidth: 150 },
    { id: "other", name: "Дополнительно", sortable: false, dataType: "string", minWidth: 140 },
    { id: "close_date", name: "Дата закрытия", sortable: true, dataType: "date", minWidth: 140 },
    { id: "close_name", name: "Кто закрыл", sortable: true, dataType: "string", minWidth: 150 },
    { id: "solution", name: "Решение/Устранение", sortable: false, dataType: "string", minWidth: 180 },
    { id: "department", name: "Отдел", sortable: false, dataType: "string", hidden: true, minWidth: 160 },
    { id: "request", name: "Тип запроса", sortable: false, dataType: "string", hidden: true, minWidth: 160 },
    { id: "group", name: "Группа", sortable: false, dataType: "string", hidden: true, minWidth: 160 },
];

// =========================================================================
// Ключи и безопасный доступ к localStorage
// =========================================================================

function key(userId, ...parts) {
    return [KEY_PREFIX, userId, ...parts].join(":");
}

function readRaw(k) {
    try {
        return localStorage.getItem(k);
    } catch (e) {
        return null;
    }
}

function writeRaw(k, value) {
    try {
        localStorage.setItem(k, value);
    } catch (e) {
        console.warn("[tableSettings] Не удалось записать", k, e);
    }
}

function readJSON(k, fallback) {
    const raw = readRaw(k);
    if (!raw) return fallback;
    try {
        const parsed = JSON.parse(raw);
        return parsed == null ? fallback : parsed;
    } catch (e) {
        console.warn("[tableSettings] Битый JSON в", k, "— игнорируем.");
        return fallback;
    }
}

function writeJSON(k, value) {
    try {
        writeRaw(k, JSON.stringify(value));
    } catch (e) {
        console.warn("[tableSettings] Не удалось сериализовать", k, e);
    }
}

function readIdList(k) {
    const v = readJSON(k, null);
    if (!Array.isArray(v)) return null;
    return v.map(String).filter(Boolean);
}

function readWidths(k) {
    const v = readJSON(k, null);
    if (!v || typeof v !== "object" || Array.isArray(v)) return {};
    const out = {};
    for (const [id, w] of Object.entries(v)) {
        const n = parseInt(w, 10);
        if (Number.isFinite(n) && n > 0) out[id] = `${n}px`;
    }
    return out;
}

function normalizeScope(scope) {
    return SCOPES.includes(scope) ? scope : DEFAULT_SCOPE;
}

// =========================================================================
// Состояние
// =========================================================================

const state = {
    userId: null,
    scope: DEFAULT_SCOPE,
    columns: { open: [], close: [], report: [] },
    // Серверный источник колонок отчёта. Пока отчёт не открыт — null.
    reportSource: null,
};

export function isModeHidden(scope, columnId) {
    const list = HIDDEN_IN_MODE[normalizeScope(scope)] || [];
    return list.includes(columnId);
}

// =========================================================================
// Сборка колонок: журналы
// =========================================================================

/**
 * Порядок: id и address всегда первые (липкие колонки журнала),
 * далее пользовательский order, хвост — в порядке дефолтов.
 */
function buildColumns(scope, userOrder, userHidden, userWidths) {
    const modeHidden = HIDDEN_IN_MODE[scope] || [];
    const hasUserHidden = Array.isArray(userHidden);

    const cols = DEFAULT_COLUMNS.map((def) => {
        const hidden =
            modeHidden.includes(def.id) ||
            (hasUserHidden ? userHidden.includes(def.id) : def.hidden === true);
        const width =
            userWidths && userWidths[def.id]
                ? userWidths[def.id]
                : `${def.minWidth}px`;
        return { ...def, hidden, visible: !hidden, width };
    });

    const orderIndex = (id) => {
        if (!Array.isArray(userOrder)) return Number.MAX_SAFE_INTEGER;
        const i = userOrder.indexOf(id);
        return i === -1 ? Number.MAX_SAFE_INTEGER : i;
    };
    const defIndex = (id) => DEFAULT_COLUMNS.findIndex((c) => c.id === id);

    cols.sort((a, b) => {
        if (a.id === "id") return -1;
        if (b.id === "id") return 1;
        if (a.id === "address") return -1;
        if (b.id === "address") return 1;
        const d = orderIndex(a.id) - orderIndex(b.id);
        return d !== 0 ? d : defIndex(a.id) - defIndex(b.id);
    });

    return cols;
}

// =========================================================================
// Сборка колонок: отчёт (источник — сервер)
// =========================================================================

/** reports_list.columns → внутренние дефолты отчёта. */
function normalizeReportSource(serverColumns) {
    if (!Array.isArray(serverColumns)) return [];
    return serverColumns
        .filter((c) => c && c.id != null)
        .map((c) => {
            const id = String(c.id);
            const minWidth = Number(c.minWidth) || (id === "id" ? DEFAULT_ID_WIDTH : 120);
            return {
                id,
                name: String(c.name ?? id),
                sortable: c.sortable === true,
                dataType:
                    c.type === "timestamp" ? "date" : c.type === "number" ? "number" : "string",
                isAbsoluteFixed: id === "id" || id === "address",
                minWidth,
                defaultHidden: c.default_visible === false,
            };
        });
}

/**
 * Порядок и набор определяет сервер (§15.4), пользовательский order
 * накладывается поверх. id/address НЕ форсируются первыми: в отчёте
 * сервер может их не отдать вовсе. Новое серверное поле, которого нет
 * в сохранённом order, уезжает в конец и остаётся видимым.
 */
function buildReportColumns(source, userOrder, userHidden, userWidths) {
    const hasUserHidden = Array.isArray(userHidden);

    const cols = source.map((def) => {
        const hidden = hasUserHidden
            ? userHidden.includes(def.id)
            : def.defaultHidden === true;
        const width =
            userWidths && userWidths[def.id]
                ? userWidths[def.id]
                : `${def.minWidth}px`;
        return {
            id: def.id,
            name: def.name,
            sortable: def.sortable,
            dataType: def.dataType,
            isAbsoluteFixed: def.isAbsoluteFixed,
            minWidth: def.minWidth,
            hidden,
            visible: !hidden,
            width,
        };
    });

    if (Array.isArray(userOrder) && userOrder.length > 0) {
        const orderIndex = (id) => {
            const i = userOrder.indexOf(id);
            return i === -1 ? Number.MAX_SAFE_INTEGER : i;
        };
        const srcIndex = (id) => source.findIndex((c) => c.id === id);
        cols.sort((a, b) => {
            const d = orderIndex(a.id) - orderIndex(b.id);
            return d !== 0 ? d : srcIndex(a.id) - srcIndex(b.id);
        });
    }

    return cols;
}

// =========================================================================
// Пересборка
// =========================================================================

/** Пересборка одного scope из его источника + локального кэша. */
function rebuildScope(scope) {
    const s = normalizeScope(scope);
    const uid = state.userId;

    let order = null;
    let hidden = null;
    let widths = {};
    if (uid != null) {
        order = readIdList(key(uid, "table", s, "order"));
        hidden = readIdList(key(uid, "table", s, "hidden"));
        widths = readWidths(key(uid, "table", s, "widths"));
    }

    if (s === "report") {
        // Нет серверного источника — нет колонок. Журнальные дефолты
        // сюда подставлять нельзя (баг A).
        state.columns.report = state.reportSource
            ? buildReportColumns(state.reportSource, order, hidden, widths)
            : [];
        return;
    }

    state.columns[s] = buildColumns(s, order, hidden, widths);
}

/** Все scope, включая report (баг C). */
function rebuildAllScopes() {
    for (const s of SCOPES) rebuildScope(s);
}

// =========================================================================
// Публичный рабочий объект (совместимость с потребителями)
// =========================================================================

export const tableSettings = {
    get columns() {
        return state.columns[state.scope];
    },
    set columns(value) {
        if (Array.isArray(value)) state.columns[state.scope] = value;
    },
    get scope() {
        return state.scope;
    },
    get userId() {
        return state.userId;
    },
};

// До авторизации — только дефолты, никакого localStorage (3.1, 3.4).
rebuildAllScopes();

// =========================================================================
// Применение настроек (3.1, 3.8, 3.9)
// =========================================================================

/**
 * Серверный column_settings: разрез по scope либо плоский {order, hidden}
 * (обратная совместимость — трактуем как open, протокол §13.3).
 */
function normalizeServerSettings(serverSettings) {
    const out = { open: null, close: null, report: null };
    if (!serverSettings || typeof serverSettings !== "object") return out;

    const src =
        serverSettings.column_settings &&
        typeof serverSettings.column_settings === "object"
            ? serverSettings.column_settings
            : serverSettings;

    const looksFlat = Array.isArray(src.order) || Array.isArray(src.hidden);
    if (looksFlat) {
        out.open = { order: src.order, hidden: src.hidden };
        return out;
    }
    for (const scope of SCOPES) {
        const s = src[scope];
        if (s && typeof s === "object") {
            out[scope] = { order: s.order, hidden: s.hidden };
        }
    }
    return out;
}

/**
 * Главная точка входа.
 * @param {number|string|null} userId
 * @param {Object|null} serverSettings — null = применить локальный кэш (3.9)
 * @returns {boolean} применены ли настройки пользователя
 */
export function applyUserSettings(userId, serverSettings = null) {
    const uid = userId == null || userId === "" ? null : String(userId);

    // 3.4: без пользователя настройки не применяются.
    if (uid == null) {
        resetSettings();
        return false;
    }

    const userChanged = state.userId !== uid;
    state.userId = uid;
    if (userChanged) {
        state.scope = DEFAULT_SCOPE;
        state.columns.report = [];
        state.reportSource = null;   // чужой набор колонок не наследуем
    }

    const byScope = normalizeServerSettings(serverSettings);
    for (const scope of SCOPES) {
        const srv = byScope[scope];
        if (!srv) continue;
        // Сервер — источник правды только для order/hidden (3.3).
        if (Array.isArray(srv.order)) {
            writeJSON(key(uid, "table", scope, "order"), srv.order.map(String));
        }
        if (Array.isArray(srv.hidden)) {
            writeJSON(key(uid, "table", scope, "hidden"), srv.hidden.map(String));
        }
    }

    rebuildAllScopes();
    return true;
}

/** Сброс на дефолты (logout / auth:lost). Гостевой scope не создаём. */
export function resetSettings() {
    state.userId = null;
    state.scope = DEFAULT_SCOPE;
    state.columns.report = [];
    state.reportSource = null;
    rebuildAllScopes();
}

/** Переключение активного scope. */
export function setScope(scope) {
    const s = normalizeScope(scope);
    if (state.scope === s) return;
    state.scope = s;
    if (s !== "report" && (!state.columns[s] || state.columns[s].length === 0)) {
        rebuildScope(s);
    }
}

/**
 * Совместимость со старым вызовом. Старые глобальные ключи не читаются
 * (3.5) — переприменяем локальный кэш текущего пользователя.
 * @deprecated использовать applyUserSettings(userId, null)
 */
export function syncTableSettingsFromStorage() {
    if (state.userId == null) return;
    rebuildAllScopes();
}

// =========================================================================
// Колонки: чтение и запись
// =========================================================================

/** Порядок и скрытые колонки для сохранения на сервер. */
export function getColumnsState(scope = state.scope) {
    const s = normalizeScope(scope);
    const cols = state.columns[s] || [];
    return {
        order: cols.map((c) => c.id),
        hidden: cols.filter((c) => c.hidden && !isModeHidden(s, c.id)).map((c) => c.id),
    };
}

export function setOrder(scope, orderIds) {
    const s = normalizeScope(scope);
    if (state.userId == null || !Array.isArray(orderIds)) return;
    writeJSON(key(state.userId, "table", s, "order"), orderIds.map(String));
    rebuildScope(s);   // report пересоберётся из reportSource (баг A)
}

export function setHidden(scope, hiddenIds) {
    const s = normalizeScope(scope);
    if (state.userId == null || !Array.isArray(hiddenIds)) return;
    writeJSON(key(state.userId, "table", s, "hidden"), hiddenIds.map(String));
    rebuildScope(s);
}

/** 3.3: ширины только локально, на сервер не уходят. */
export function setWidth(scope, columnId, widthPx) {
    const s = normalizeScope(scope);
    if (state.userId == null || !columnId) return;
    const n = parseInt(widthPx, 10);
    if (!Number.isFinite(n) || n <= 0) return;
    const k = key(state.userId, "table", s, "widths");
    const widths = readWidths(k);
    widths[columnId] = `${n}px`;
    writeJSON(k, widths);
    const col = (state.columns[s] || []).find((c) => c.id === columnId);
    if (col) col.width = `${n}px`;
}

export function getWidths(scope = state.scope) {
    const s = normalizeScope(scope);
    if (state.userId == null) return {};
    return readWidths(key(state.userId, "table", s, "widths"));
}

/**
 * 3.6: липкий «Адрес» смещается на ширину id СВОЕГО scope.
 * Отчёты со своей шириной id не влияют на журналы.
 */
export function getFreezeLeftOffset(scope = state.scope) {
    const s = normalizeScope(scope);
    const col = (state.columns[s] || []).find((c) => c.id === "id");
    const fromColumn = col ? parseInt(col.width, 10) : NaN;
    if (Number.isFinite(fromColumn) && fromColumn > 0) return fromColumn;
    const widths = getWidths(s);
    const fromStorage = parseInt(widths.id, 10);
    return Number.isFinite(fromStorage) && fromStorage > 0
        ? fromStorage
        : DEFAULT_ID_WIDTH;
}

/**
 * Отчёт открыт: сервер прислал reports_list.columns.
 * Источник сохраняется, поверх применяются локальные order/hidden/widths
 * (баг B). Повторный вызов с тем же набором идемпотентен.
 */
export function setReportColumns(serverColumns) {
    const source = normalizeReportSource(serverColumns);
    if (source.length === 0) return;
    state.reportSource = source;
    rebuildScope("report");
}

/** Есть ли серверный источник колонок отчёта. */
export function hasReportColumns() {
    return Array.isArray(state.reportSource) && state.reportSource.length > 0;
}

// =========================================================================
// Сортировка, период, фильтры (per-user, только после логина)
// =========================================================================

export function getSortState(scope = state.scope) {
    const s = normalizeScope(scope);
    if (state.userId == null) return { columnId: -1, isAscending: true };
    const col = readRaw(key(state.userId, "table", s, "sortCol"));
    const dir = readRaw(key(state.userId, "table", s, "sortDir"));
    return {
        columnId: col == null || col === "" ? -1 : col,
        isAscending: dir !== "desc",
    };
}

export function setSortState(scope, columnId, isAscending) {
    const s = normalizeScope(scope);
    if (state.userId == null) return;
    writeRaw(key(state.userId, "table", s, "sortCol"), String(columnId));
    writeRaw(key(state.userId, "table", s, "sortDir"), isAscending ? "asc" : "desc");
}

export function getClosePeriod() {
    if (state.userId == null) return "1";
    return readRaw(key(state.userId, "table", "close", "period")) || "1";
}

export function setClosePeriod(value) {
    if (state.userId == null) return;
    writeRaw(key(state.userId, "table", "close", "period"), String(value));
}

/**
 * Фильтры открытых. cities === null означает «ключ не сохранён» —
 * контроллер подставит полный список городов. Пустой массив — валидное
 * состояние «Все», его не перезаписываем.
 */
export function getOpenFilters() {
    if (state.userId == null) return { cities: null, hideLong: false };
    const raw = readJSON(key(state.userId, "filters", "open", "cities"), null);
    const cities = Array.isArray(raw)
        ? raw.map(Number).filter(Number.isFinite)
        : null;
    const hideLong =
        readRaw(key(state.userId, "filters", "open", "hideLong")) === "true";
    return { cities, hideLong };
}

export function setOpenFilters({ cities, hideLong }) {
    if (state.userId == null) return;
    if (Array.isArray(cities)) {
        writeJSON(key(state.userId, "filters", "open", "cities"), cities);
    }
    if (typeof hideLong === "boolean") {
        writeRaw(key(state.userId, "filters", "open", "hideLong"), String(hideLong));
    }
}