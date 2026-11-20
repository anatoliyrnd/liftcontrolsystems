import { REPORTS } from "../../config.js";

/**
 * Шаблон экрана отчётов. Строка, как у остальных страниц (router
 * вставляет её innerHTML): статический шаблон — разрешённое исключение
 * правила «DOM через createElement».
 *
 * Все id с префиксом rep*: unmount журналов не защищён guard и трогает
 * #searchInput / #cityFilterBackdrop / #refreshBtn по глобальному
 * getElementById — совпадение имени сломало бы чужой teardown.
 *
 * Таблица — своя (#reportsTable), не #dataTable: CSS зебры/липких
 * колонок журналов привязан к #dataTable, а тур и sync-кнопка ищут
 * журнальную разметку. data-scope/data-mode="report" дают settings.js
 * и body-render свою ширину липкого id и свой набор колонок.
 */
export function reportsPageTemplate() {
    const tabBtn = (tab, label) =>
        `<button type="button" class="theme-toggle-btn rep-tab" data-tab="${tab}" style="border-radius:8px;width:auto;padding:0 16px;font-size:13px;">${label}</button>`;
    return `<div class="container">
    <div style="display:flex;justify-content:space-between;align-items:center;margin-bottom:0.5rem;gap:12px;flex-wrap:wrap;">
      <h1 style="margin:0;">Отчеты</h1>
      <div style="display:flex;gap:8px;" id="repTabs">
        ${tabBtn("summary", REPORTS.TABS.summary)}
        ${tabBtn("byId", REPORTS.TABS.byId)}
        ${tabBtn("advanced", REPORTS.TABS.advanced)}
      </div>
    </div>
    <div id="repOfflineStub" class="rep-stub" style="display:none;">
      Отчеты доступны только при наличии интернета.
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
    <div id="repTabMain" class="rep-panel">
      <div id="repFiltersHost"></div>
      <div id="repStatsHost"></div>
      <div class="table-wrapper">
        <table id="reportsTable" data-scope="report" data-mode="report">
          <thead></thead>
          <tbody></tbody>
        </table>
        <div id="repEmptyStub" style="display:none;text-align:center;padding:2rem;color:var(--text-secondary);font-size:14px;">
          По вашему запросу ничего не найдено. Попробуйте изменить параметры поиска.
        </div>
      </div>
      <div id="repPagination" style="display:flex;gap:8px;align-items:center;justify-content:flex-end;font-size:13px;color:var(--text-secondary);"></div>
    </div>
  </div>`;
}