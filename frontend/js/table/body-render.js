import { tableSettings, getFreezeLeftOffset } from "./settings.js";
import { formatTs, nowTs } from "../utils/date-utils.js";

const NOTIFY_SUFFIXES = {
  1: "по телефону",
  2: "онлайн",
  3: "в телеграм",
  4: "в макс",
  5: "в вк",
  6: "по смс",
  7: "по email",
};

export function renderTableBody(tableElement, serverData) {
  const tbody =
    tableElement.querySelector("tbody") ||
    tableElement.appendChild(document.createElement("tbody"));
  tbody.innerHTML = "";

  // 3.6: липкий «Адрес» смещается на ширину id СВОЕГО scope.
  const scope =
    tableElement.getAttribute("data-scope") ||
    tableElement.getAttribute("data-mode") ||
    tableSettings.scope;
  const freezeLeftOffset = getFreezeLeftOffset(scope);
  const currentTs = nowTs();

  serverData.forEach((rowData) => {
    const tr = document.createElement("tr");

    const isClosed = rowData.type === "close";
    const isOverdue =
      !isClosed &&
      rowData.repair_time &&
      Number(rowData.repair_time) < currentTs;
    const isUnassigned = !rowData.staff_id || rowData.staff_id === 0;
    const isUnnotified =
      !isUnassigned &&
      (rowData.notify_status === 0 ||
        rowData.notify_status === "0" ||
        rowData.notify_status == null ||
        !rowData.notify_date);

    let idCellClass = "";
    if (rowData.alert_level === 3 || isOverdue) {
      idCellClass = "cell-alert-danger";
    } else if (rowData.alert_level === 2 || isUnassigned) {
      idCellClass = "cell-alert-warning";
    } else if (isUnnotified) {
      idCellClass = "cell-alert-info";
    }

    tableSettings.columns.forEach((col) => {
      if (col.hidden || col.visible === false) return;

      const td = document.createElement("td");
      td.setAttribute("data-col-id", col.id);
      td.setAttribute("data-label", col.name);

      // Ключ сортировки — только для адреса: сортировать по подписи
      // значит снова группировать улицы под «у», а дома под «д».
      // Ставим ТОЛЬКО при непустом значении: пустой атрибут sorting.js
      // прочитал бы优先 над текстом и обнулил порядок хуже, чем без него.
      // Номерной колонке ключ не нужен — нечисловой offline_… уезжает
      // в конец сам, это и есть политика «своя нумерация отдельно».
      if (col.id === "address") {
        const sortKey = rowData.address_sort_key;
        if (sortKey != null && String(sortKey).trim() !== "") {
          td.setAttribute("data-sort-key", String(sortKey));
        }
      }

      const finalWidth = col.width || `${col.minWidth}px`;
      td.style.width = finalWidth;
      td.style.minWidth = `${col.minWidth}px`;
      td.style.maxWidth = finalWidth;

      if (col.id === "address") {
        td.style.left = `${freezeLeftOffset}px`;
        td.classList.add("sticky-freeze-border");
      }

      if (col.id === "id" && idCellClass) td.classList.add(idCellClass);
      if (col.id === "repair_time" && isOverdue)
        td.classList.add("cell-alert-danger");
      if (col.id === "staff_name" && isUnassigned)
        td.classList.add("cell-alert-warning");
      if (col.id === "notify_status" && isUnnotified)
        td.classList.add("cell-alert-info");

      let cellValue = "";

      if (col.id === "staff_name") {
        cellValue = isUnassigned ? "Не назначен" : rowData.staff_name || "—";
      } else if (col.id === "staff_name2") {
        cellValue = rowData.staff_name2 || "—";
      } else if (col.id === "staff_name3") {
        cellValue = rowData.staff_name3 || "—";
      } else if (col.id === "notify_status") {
        if (isUnassigned) cellValue = "—";
        else if (isUnnotified) cellValue = "Не уведомлен";
        else {
          const suffix = NOTIFY_SUFFIXES[rowData.notify_status] || "уведомлен";
          const dateStr = rowData.notify_date
            ? formatTs(rowData.notify_date)
            : "";
          cellValue = dateStr ? `${dateStr} - ${suffix}` : suffix;
        }
      } else if (col.id === "notify_status2") {
        if (!rowData.staff_id2) cellValue = "—";
        else {
          const suffix = NOTIFY_SUFFIXES[rowData.notify_status2] || "уведомлен";
          const dateStr = rowData.notify_date2
            ? formatTs(rowData.notify_date2)
            : "";
          cellValue = dateStr ? `${dateStr} - ${suffix}` : suffix;
        }
      } else if (col.id === "notify_status3") {
        if (!rowData.staff_id3) cellValue = "—";
        else {
          const suffix = NOTIFY_SUFFIXES[rowData.notify_status3] || "уведомлен";
          const dateStr = rowData.notify_date3
            ? formatTs(rowData.notify_date3)
            : "";
          cellValue = dateStr ? `${dateStr} - ${suffix}` : suffix;
        }
      } else {
        cellValue = rowData[col.id] !== undefined ? rowData[col.id] : "";
        if (col.dataType === "date" && cellValue && cellValue !== "—") {
          cellValue = formatTs(cellValue);
        }
      }

      if (
        col.dataType === "date" &&
        (cellValue === "" || cellValue === "—" || cellValue === null)
      ) {
        cellValue = "—";
      }

      if (
        ["solution", "close_name", "other"].includes(col.id) &&
        String(cellValue).trim() === ""
      ) {
        cellValue = "—";
      }

      if (col.dataType === "date") {
        const raw = rowData[col.id];
        if (raw != null && raw !== "") {
          const n = Number(raw);
          if (Number.isFinite(n) && n > 0) {
            const tsSec = n > 9999999999 ? Math.floor(n / 1000) : n;
            td.setAttribute("data-ts", String(tsSec));
          }
        }
      }

      td.textContent = cellValue;

      if (
        [
          "solution",
          "details",
          "address",
          "close_name",
          "notify_status",
          "notify_status2",
          "notify_status3",
        ].includes(col.id) &&
        cellValue !== "—"
      ) {
        td.setAttribute("title", cellValue);
      }

      tr.appendChild(td);
    });

    tbody.appendChild(tr);
  });
}
