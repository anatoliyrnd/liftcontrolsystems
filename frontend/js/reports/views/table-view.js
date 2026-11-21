import { REPORTS } from "../../config.js";
import { setScope, setReportColumns } from "../../table/settings.js";
import { rebuildTableHeaders } from "../../table/header-render.js";
import { renderTableBody } from "../../table/body-render.js";
import { toTableRow, alertClass, isOverdue } from "../reports-formatters.js";
import { nowTs } from "../../utils/date-utils.js";

/**
 * Таблица отчёта: семь-колонок, перенос строк вместо обрезки.
 *
 * body-render переиспользуется без правок: новые id колонок не входят
 * в его спец-случаи, поэтому собранный многострочный текст уходит в
 * ячейку через textContent. Перенос даёт CSS pre-line.
 *
 * Подсветку и data-ticket-id ставим пост-проходом: body-render красит
 * только колонку с id "id", которой в новом наборе нет, а клик по
 * строке больше не может читать текст первой ячейки — там теперь
 * «№ 1217\nадрес», и валидация /^\d+$/ его не пропустит.
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
    rebuildTableHeaders(
      table,
      () => {},
      () => {},
    );
  }

  function renderRows(items) {
    ensureColumns();
    const list = Array.isArray(items) ? items : [];
    renderTableBody(table, list.map(toTableRow));
    decorate(list);
  }

  /** Подсветка тревоги + номер заявки для навигации. */
  function decorate(items) {
    const tbody = table.querySelector("tbody");
    if (!tbody) return;
    const now = nowTs();
    const rows = tbody.querySelectorAll("tr");
    items.forEach((item, i) => {
      const tr = rows[i];
      if (!tr) return;
      const id = item.id ?? item.call_id ?? "";
      tr.dataset.ticketId = String(id);

      const first = tr.querySelector('td[data-col-id="ticket"]');
      if (first) {
        const cls = alertClass(item, now);
        if (cls) first.classList.add(cls);
        first.classList.add("sticky-freeze-border");
      }
      if (isOverdue(item, now)) {
        tr.querySelector('td[data-col-id="opening"]')?.classList.add(
          "cell-alert-danger",
        );
      }
      if (!Number(item.staff_id)) {
        tr.querySelector('td[data-col-id="resp1"]')?.classList.add(
          "cell-alert-warning",
        );
      }
      // Полный текст по наведению: описание СПульта с дополнениями
      // может быть длинным, а(title) даёт прочитать без раскрытия.
      const opening = tr.querySelector('td[data-col-id="opening"]');
      if (opening) opening.title = opening.textContent;
      const closure = tr.querySelector('td[data-col-id="closure"]');
      if (closure && closure.textContent !== "—")
        closure.title = closure.textContent;
    });
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
        const id = String(row.dataset.ticketId || "").trim();
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
    const mk = (label, disabled, next) => {
      const b = document.createElement("button");
      b.type = "button";
      b.className = "theme-toggle-btn";
      b.style.cssText =
        "border-radius:6px;width:auto;padding:0 10px;font-size:13px;";
      b.textContent = label;
      b.disabled = disabled;
      b.addEventListener("click", () => onPage(next));
      return b;
    };
    const info = document.createElement("span");
    info.textContent = `Стр. ${page} из ${pages} (всего ${pagination.total_items})`;
    container.appendChild(mk("‹", page <= 1, page - 1));
    container.appendChild(info);
    container.appendChild(mk("›", page >= pages, page + 1));
  }

  function destroy() {
    if (rowClickAbort) rowClickAbort.abort();
    rowClickAbort = null;
  }

  return {
    ensureColumns,
    rebuildHeaders,
    renderRows,
    bindRowClick,
    renderPagination,
    destroy,
  };
}
