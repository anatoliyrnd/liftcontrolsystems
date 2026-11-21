import { REPORTS } from "../../config.js";

/**
 * Страница отчётов: Сводка / Расширенный поиск / Поиск по ID.
 * Таблицы здесь нет — она открывается отдельной вкладкой браузера
 * (#/reports-results) по кнопке «Найти».
 *
 * Все id с префиксом rep*: unmount журналов трогает глобальные
 * #searchInput / #cityFilterBackdrop / #refreshBtn.
 */
export function reportsPageTemplate() {
  const tabBtn = (tab, label) =>
    `<button type="button" class="theme-toggle-btn rep-tab" data-tab="${tab}" style="border-radius:8px;width:auto;padding:0 16px;font-size:13px;">${label}</button>`;
  return `<div class="container">
    <div style="display:flex;justify-content:space-between;align-items:center;margin-bottom:0.5rem;gap:12px;flex-wrap:wrap;">
      <h1 style="margin:0;">Отчеты</h1>
      <div style="display:flex;gap:8px;flex-wrap:wrap;" id="repTabs">
        ${tabBtn("summary", REPORTS.TABS.summary)}
        ${tabBtn("advanced", REPORTS.TABS.advanced)}
        ${tabBtn("byId", REPORTS.TABS.byId)}
      </div>
    </div>
    <div id="repOfflineStub" class="rep-stub" style="display:none;"></div>
    <div id="repTabSummary" class="rep-panel">
      <div id="repSummaryHost"></div>
    </div>
    <div id="repTabAdvanced" class="rep-panel" style="display:none;">
      <div id="repFiltersHost"></div>
      <div class="rep-result-hint">
        <span id="repResultHintText">Таблица откроется в отдельной вкладке браузера.</span>
        <button type="button" id="repResultShowBtn" class="menu-item" style="display:none;">Показать таблицу</button>
      </div>
    </div>
    <div id="repTabById" class="rep-panel" style="display:none;">
      <div style="display:flex;gap:8px;align-items:center;max-width:420px;">
        <input id="repTicketId" type="text" class="search-input" placeholder="Номер заявки" autocomplete="off">
        <button id="repByIdBtn" class="theme-toggle-btn" style="border-radius:8px;width:auto;padding:0 16px;font-size:13px;">Найти</button>
      </div>
      <div style="font-size:12px;color:var(--text-secondary);margin-top:6px;">
        Поиск по ID игнорирует остальные фильтры: откроется карточка заявки.
      </div>
    </div>
  </div>`;
}
