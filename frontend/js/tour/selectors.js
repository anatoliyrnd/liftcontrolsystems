/**
 * Единственное место, где живут селекторы тура.
 * Правки разметки экрана → правка только здесь.
 *
 * Функции вместо строк — для элементов, которых может не быть в DOM
 * на момент старта сценария (раскрывающиеся блоки). driver.js v1
 * принимает функцию-резолвер элемента.
 */
export const SEL = {
    // --- Журнал ---
    createBtn: '[data-tour="create-btn"]',
    search: "#searchInput",
    filters: "#openOnlyFilters",
    sort: '[data-tour="table-sort"]',
    resizer: '[data-tour="table-resizer"]',
    table: "#dataTable",
    tableWrapper: ".table-wrapper",
    refreshBtn: "#refreshBtn",
    syncIndicator: "#syncIndicator",
    userMenu: "#userProfileBtn",

    // --- Создание ---
    addressSlot: "#formAddressSlot",
    details: "#formDetails",
    staff: "#formStaffSlot",
    dicts: "#createGroupSlot",
    repair: "#repairTimeSlot",
    saveBtn: "#saveTicketBtn",

    // --- Карточка ---
    ticketHeader: '[data-tour="ticket-header"]',
    editBtn: "#editBtn",
    staffSlots: "#staffSlotsContainer",
    notes: "#noteComposer",
    closeBtn: "#closeBtn",
        // --- Карточка: блоки, видимые только после открытия режима ---
    editDetails: "#detailsAddBlock",
    editRepair: "#repairTimeEditBlock",
    cardSaveBtn: "#saveBtn",
    cancelEditBtn: "#cancelEditBtn",
    solutionInput: "#solutionInput",
    solutionMic: "#closeBlock .btn-voice-mic",
    closeAndCreate: "#closeAndCreateWrap",

    // --- Закрытые / очередь / профиль ---
    period: "#periodSelectorContainer",
    queueTable: "#queueTable",
    queueEmpty: "#queueEmpty",
    profileList: "#columnsSettingsList",
    profileSave: "#saveSettingsBtn",

    // Раскрывающийся блок настроек таблицы в профиле.
    profileSummary: () =>
        document
            .querySelector("#columnsSettingsList")
            ?.closest("details")
            ?.querySelector("summary") || "#columnsSettingsList",

    // --- Демо-строка очереди (создаётся туром, живёт только на время тура) ---
    demoRow: 'tr[data-demo-row="true"]',
    demoConfirm: 'tr[data-demo-row="true"] button[data-action="confirm"]',
    demoDelete: 'tr[data-demo-row="true"] button[data-action="delete"]',
};

/** Якорный контейнер экрана — по нему определяем, что роут отрисован. */
export function scenarioContainer(scenario) {
    switch (scenario) {
        case "journal":
        case "closed":
            return "#dataTable";
        case "create":
            return "#formAddressSlot";
        case "ticket":
            return "#ticketDetailsDynamicContainer";
        case "queue":
            return "#queueTable";
        case "profile":
            return "#columnsSettingsList";
        default:
            return "#app";
    }
}