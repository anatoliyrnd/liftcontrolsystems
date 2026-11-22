import { REPORTS } from "../config.js";

/**
 * Изоляция api.post для отчётов. Контроллер классифицирует ответы
 * сам: offline === true — отказ канала, code:"aborted" без offline —
 * отмена при unmount, http_* — ошибка сервера, не офлайн.
 *
 * Тег "reports" обязателен: unmount гасит только свои запросы и не
 * задевает журнальные. filters_data идёт silent (null): справочники
 * не должны мигать статус-баром поверх работы пользователя.
 */
export function createReportsRepository(api) {
  const tag = "reports";
  return {
    fetchFiltersData: () =>
      api.post({ action: "reports_filters_data" }, null, tag),
    // Сводка: silent (null) — автообновление на каждый клик по городу
    // не должно мигать статус-баром; индикатор загрузки — скелетон.
    // Тег отдельный: уход с вкладки «Сводка» не гасит запросы
    // расширенного поиска и наоборот.
    fetchSummary: (period, cityIds) =>
      api.post(
        { action: "reports_summary", period, city_ids: cityIds },
        null,
        "reports_summary",
      ),
    fetchStats: (filters) =>
      api.post(
        { action: "reports_stats", ...filters },
        "Формирование сводки...",
        tag,
      ),
    fetchList: (filters, page, limit) =>
      api.post(
        { action: "reports_list", ...filters, page, limit },
        "Загрузка отчёта...",
        tag,
      ),
    // 30 с: 2000 строк CSV не укладываются в дефолтные 15 с.
    // Бюджет цепочки api-service масштабируется от этого значения.
    exportCsv: (filters) =>
      api.post(
        { action: "reports_export", format: "csv", ...filters },
        "Генерация CSV...",
        tag,
        { timeoutMs: REPORTS.EXPORT_TIMEOUT_MS },
      ),
    // Печать: тот же reports_export, но format=json — сервер отдаёт
    // строки в контракте items, документ собирает браузер. Таймаут
    // тот же: до 2000 строк в дефолтные 15 с не укладываются.
    // Сообщение null: индикатор загрузки живёт в окне печати,
    // статус-бар вкладки результатов мигать не должен.
    fetchPrintRows: (filters) =>
      api.post(
        { action: "reports_export", format: "json", ...filters },
        null,
        tag,
        { timeoutMs: REPORTS.EXPORT_TIMEOUT_MS },
      ),
    // XLSX: сервер собирает книгу, клиент только декодирует base64.
    // Таймаут тот же — 2000 строк плюс заметки не быстрее CSV.
    exportXlsx: (filters) =>
      api.post(
        { action: "reports_export", format: "xlsx", ...filters },
        "Генерация XLSX...",
        tag,
        { timeoutMs: REPORTS.EXPORT_TIMEOUT_MS },
      ),
  };
}
