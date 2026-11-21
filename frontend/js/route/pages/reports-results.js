/**
 * Разметка вкладки браузера «Таблица отчёта» (#/reports-results).
 *
 * Оболочку приложения гасит main.js по маршруту: меню, история, LED,
 * баннер офлайна и синк-индикатор здесь не нужны — это служебное окно
 * с одной таблицей и кнопками выгрузки.
 *
 * Таблица создаётся контроллером через createTableView: семь
 *-колонок с переносом строк, а не пятнадцать обрезанных.
 */
export function reportsResultsPageTemplate() {
  return `<div class="container">
    <div class="rep-results-head">
      <h1 style="margin:0;">Таблица отчёта</h1>
      <div class="rep-results-actions">
        <span id="rrCount" class="rep-results-count"></span>
        <button type="button" id="rrRefreshBtn" class="menu-item">Обновить</button>
        <button type="button" id="rrExportBtn" class="menu-item rep-primary">Выгрузить CSV</button>
        <button type="button" id="rrPrintBtn" class="menu-item">Печать</button>
      </div>
    </div>
    <div id="rrStub" class="rep-stub" style="display:none;"></div>
    <div id="rrEcho" class="rep-results-echo"></div>
    <div id="rrPeriod" class="rep-summary-period"></div>
    <details id="rrStatsDetails" class="rep-results-stats">
      <summary id="rrStatsSummary">Сводка по выборке</summary>
      <div id="rrStatsHost"></div>
    </details>
    <div class="table-wrapper">
      <table id="reportsTable" data-scope="report" data-mode="report">
        <thead></thead>
        <tbody></tbody>
      </table>
      <div id="rrEmpty" class="rep-empty" style="display:none;">
        По вашему запросу ничего не найдено. Измените фильтры во вкладке отчётов и нажмите «Найти».
      </div>
    </div>
    <div id="rrPagination" class="rep-pagination"></div>
  </div>`;
}
