import { REPORTS } from "../config.js";
import { getReportFilters, setReportFilters } from "../table/settings.js";
import { mskTodayYmd } from "../utils/date-utils.js";

/**
 * Состояние экрана отчётов: фильтры, вкладка, страница.
 * Хранение — только через table/settings.js (правило 4): ключ содержит
 * user_id, читается в mount после авторизации, до логина работают
 * дефолты. Прямых ключей localStorage здесь нет.
 *
 * departmentIds === null означает «ключ не сохранён» — контроллер
 * подставит все отделы из справочника. Пустой массив — валидное
 * состояние, но UI его не создаёт (минимум один отдел).
 */
function ymdMinusDays(days) {
    const d = new Date(Date.now() + 3 * 3600 * 1000 - days * 86400 * 1000);
    const pad = (n) => String(n).padStart(2, "0");
    return `${d.getUTCFullYear()}-${pad(d.getUTCMonth() + 1)}-${pad(d.getUTCDate())}`;
}

export function defaultReportState() {
    return {
        fromYmd: ymdMinusDays(REPORTS.DEFAULT_PERIOD_DAYS - 1),
        toYmd: mskTodayYmd(),
        dateType: "created",
        address: null,
        cityOnly: false,
        departmentIds: null,
        status: "all",
        staffEnabled: false,
        staffId: null,
        detailsText: "",
        solutionText: "",
        sort: REPORTS.SORT_DEFAULT,
        tab: REPORTS.TAB_DEFAULT,
        page: 1,
        // Сводка живёт отдельно от расширенного поиска: свои контролы,
        // свой запрос. summaryCities: null = ключ не сохранён → все города;
        // [] = «Все» (журнальная семантика, ноль не ошибка).
        summaryPeriod: REPORTS.SUMMARY_PERIOD_DEFAULT,
        summaryCities: null,
    };
}

export function loadReportState() {
    const saved = getReportFilters();
    const base = defaultReportState();
    if (!saved || typeof saved !== "object" || Array.isArray(saved)) return base;
    return { ...base, ...saved };
}

export function saveReportState(state) {
    setReportFilters(state);
}