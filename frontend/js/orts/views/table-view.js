import { REPORTS } from "../../config.js";
import { setScope, setReportColumns } from "../../table/settings.js";
import { rebuildTableHeaders } from "../../table/header-render.js";
import { renderTableBody } from "../../table/body-render.js";

/**
 * Таблица отчёта переиспользует header-render/body-render: липкие
 * колонки, ширины per-user и подсветка тревоги достаются бесплатно.
 *
 * Своё здесь только одно — гарантия источника колонок: setScope +
 * setReportColumns перед КАЖДЫМ рендером, по образцу _renderTableFull
 * журналов. applyUserSettings сбрасывает scope на "open" и обнуляет
 * reportSource при смене пользователя, поэтому точка гарантии одна.
 *
 * Колонки sortable:false целиком ⇒ header-render не вешает клики,
 * sorting.js не вызывается: сортировка отчёта серверная, направление
 * фиксировано белым списком REPORTS.SORTS.
 */
export function createTableView(table, router) {
    let rowClickAbort = null;

    function ensureColumns() {
        setScope("report");
        setReportColumns(REPORTS.COLUMNS);
    }

    function rebuildHeaders() {
        ensureColumns();
        const old = table.querySelector("thead");
        if (old) old.remove();
        // onSortCallback не вызывается никогда (sortable:false), но
        // сигнатура обязательна — передаём noop осознанно.
        rebuildTableHeaders(table, () => {}, () => {});
    }

    function renderRows(items) {
        ensureColumns();
        renderTableBody(table, Array.isArray(items) ? items : []);
    }

    function bindRowClick() {
        if (rowClickAbort) rowClickAbort.abort();
        rowClickAbort = new AbortController();
        const tbody = table.querySelector("tbody");
        if (!tbody) return;
        tbody.addEventListener(
            "click",
            (e) => {
                if (e.target.classList.contains("resizer")) return;
                const row = e.target.closest("tr");
                if (!row) return;
                const idCell = row.querySelector('td[data-col-id="id"]');
                const id = idCell ? idCell.textContent.trim() : "";
                // Только серверные номера: роутер валидирует param строго.
                if (!/^\d+$/.test(id)) return;
                router.navigate("#/ticket/" + encodeURIComponent(id));
            },
            { signal: rowClickAbort.signal },
        );
    }

    function renderPagination(container, pagination, onPage) {
        container.innerHTML = "";
        if (!pagination || !pagination.total_items) return;
        const page = pagination.current_page;
        const pages = Math.max(1, pagination.total_pages);
        const prev = document.createElement("button");
        prev.type = "button";
        prev.className = "theme-toggle-btn";
        prev.style.cssText = "border-radius:6px;width:auto;padding:0 10px;font-size:13px;";
        prev.textContent = "‹";
        prev.disabled = page <= 1;
        prev.addEventListener("click", () => onPage(page - 1));
        const next = document.createElement("button");
        next.type = "button";
        next.className = "theme-toggle-btn";
        next.style.cssText = "border-radius:6px;width:auto;padding:0 10px;font-size:13px;";
        next.textContent = "›";
        next.disabled = page >= pages;
        next.addEventListener("click", () => onPage(page + 1));
        const info = document.createElement("span");
        info.textContent = `Стр. ${page} из ${pages} (всего ${pagination.total_items})`;
        container.appendChild(prev);
        container.appendChild(info);
        container.appendChild(next);
    }

    function destroy() {
        if (rowClickAbort) rowClickAbort.abort();
        rowClickAbort = null;
    }

    return { ensureColumns, rebuildHeaders, renderRows, bindRowClick, renderPagination, destroy };
}