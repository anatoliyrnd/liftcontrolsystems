import { tableSettings, getFreezeLeftOffset } from "./settings.js";
import { formatTs, nowTs } from "../utils/date-utils.js";

// Выносим за пределы функции, чтобы не создавать объект при каждой итерации
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

  const freezeLeftOffset = getFreezeLeftOffset();
  const currentTs = nowTs();

  serverData.forEach((rowData) => {
    const tr = document.createElement("tr");

    // 1. Определяем проблемы для подсветки по контракту API 4.0
    const isClosed = rowData.type === "close";
    const isOverdue =
      !isClosed &&
      rowData.repair_time &&
      Number(rowData.repair_time) < currentTs;

    // Не назначен ответственный
    const isUnassigned = !rowData.staff_id || rowData.staff_id === 0;

    // Не уведомлен (если назначен, но статус 0/пустой ИЛИ нет даты уведомления)
    const isUnnotified =
      !isUnassigned &&
      (rowData.notify_status === 0 ||
        rowData.notify_status === "0" ||
        rowData.notify_status == null ||
        !rowData.notify_date);

    // Определяем приоритет для ячейки "№"
    let idCellClass = "";
    // 1. Приоритет серверного alert_level
    // Исправленная логика приоритетов по стандарту системы Lift-Calls

    if (rowData.alert_level === 3 || isOverdue) {
      // Абсолютный критический приоритет (авария на сервере ИЛИ просрочка на клиенте)
      idCellClass = "cell-alert-danger";
    } else if (rowData.alert_level === 2 || isUnassigned) {
      // Приоритет предупреждения (внимание от сервера ИЛИ не назначен механик)
      idCellClass = "cell-alert-warning";
    } else if (isUnnotified) {
      // Информационный статус (механик есть, но еще не прочитал/не подтвердил)
      idCellClass = "cell-alert-info";
    }

    tableSettings.columns.forEach((col) => {
      // Пропускаем скрытые колонки
      if (col.hidden || col.visible === false) return;

      const td = document.createElement("td");
      td.setAttribute("data-col-id", col.id);
      td.setAttribute("data-label", col.name);
      const finalWidth = col.width || `${col.minWidth}px`;
      td.style.width = finalWidth;
      td.style.minWidth = `${col.minWidth}px`;
      td.style.maxWidth = finalWidth;

      if (col.id === "address") {
        td.style.left = `${freezeLeftOffset}px`;
        td.classList.add("sticky-freeze-border");
      }

      // 2. Применяем классы подсветки (только для главного ответственного и №)
      if (col.id === "id" && idCellClass) {
        td.classList.add(idCellClass);
      }
      if (col.id === "repair_time" && isOverdue) {
        td.classList.add("cell-alert-danger");
      }
      if (col.id === "staff_name" && isUnassigned) {
        td.classList.add("cell-alert-warning");
      }
      if (col.id === "notify_status" && isUnnotified) {
        td.classList.add("cell-alert-info");
      }

      let cellValue = "";

      // === ЛОГИКА ДЛЯ ОТВЕТСТВЕННЫХ ===
      if (col.id === "staff_name") {
        cellValue = isUnassigned ? "Не назначен" : rowData.staff_name || "—";
      } else if (col.id === "staff_name2") {
        cellValue = rowData.staff_name2 || "—";
      } else if (col.id === "staff_name3") {
        cellValue = rowData.staff_name3 || "—";
      }

      // === ЛОГИКА ДЛЯ СТАТУСОВ УВЕДОМЛЕНИЯ ===
      else if (col.id === "notify_status") {
        if (isUnassigned) {
          cellValue = "—";
        } else if (isUnnotified) {
          cellValue = "Не уведомлен";
        } else {
          const suffix = NOTIFY_SUFFIXES[rowData.notify_status] || "уведомлен";
          const dateStr = rowData.notify_date
            ? formatTs(rowData.notify_date)
            : "";
          cellValue = dateStr ? `${dateStr} - ${suffix}` : suffix;
        }
      } else if (col.id === "notify_status2") {
        if (!rowData.staff_id2) {
          cellValue = "—";
        } else {
          const suffix = NOTIFY_SUFFIXES[rowData.notify_status2] || "уведомлен";
          const dateStr = rowData.notify_date2
            ? formatTs(rowData.notify_date2)
            : "";
          cellValue = dateStr ? `${dateStr} - ${suffix}` : suffix;
        }
      } else if (col.id === "notify_status3") {
        if (!rowData.staff_id3) {
          cellValue = "—";
        } else {
          const suffix = NOTIFY_SUFFIXES[rowData.notify_status3] || "уведомлен";
          const dateStr = rowData.notify_date3
            ? formatTs(rowData.notify_date3)
            : "";
          cellValue = dateStr ? `${dateStr} - ${suffix}` : suffix;
        }
      }

      // === СТАНДАРТНОЕ ФОРМАТИРОВАНИЕ ===
      else {
        cellValue = rowData[col.id] !== undefined ? rowData[col.id] : "";

        if (col.dataType === "date" && cellValue && cellValue !== "—") {
          cellValue = formatTs(cellValue);
        }
      }

      // Защита от пустых дат
      if (
        col.dataType === "date" &&
        (cellValue === "" || cellValue === "—" || cellValue === null)
      ) {
        cellValue = "—";
      }

      // Спец. тексты для пустых полей
      if (
        ["solution", "close_name", "other"].includes(col.id) &&
        String(cellValue).trim() === ""
      ) {
        cellValue = "—";
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
