// Восстанавливаем сохраненные настройки из localStorage при старте
// js/table/settings.js

// Безопасный парсинг JSON из localStorage
function safeParseJSON(str, fallback) {
  if (!str) return fallback;
  try {
    return JSON.parse(str);
  } catch (e) {
    console.warn("[tableSettings] Ошибка парсинга JSON из localStorage:", e);
    return fallback;
  }
}

// Восстанавливаем сохраненные настройки из localStorage при старте
const savedOrder = localStorage.getItem("tableColumnOrder");
// Передаем {} как fallback, если данных нет или они битые
const savedWidths = safeParseJSON(
  localStorage.getItem("tableColumnWidths"),
  {},
);
// Передаем null как fallback
let savedHidden = safeParseJSON(
  localStorage.getItem("tableColumnHidden"),
  null,
);

// Дополнительная защита: если savedHidden распарсился, но это не массив — сбрасываем
if (savedHidden !== null && !Array.isArray(savedHidden)) {
  console.warn("[tableSettings] savedHidden не является массивом, игнорируем.");
  savedHidden = null;
}

export const HIDDEN_IN_MODE = {
  open: ["solution", "close_name", "close_date"],
  close: [],
};

export const tableSettings = {
  columns: [
    {
      id: "id",
      name: "№",
      sortable: true,
      dataType: "number",
      isAbsoluteFixed: true,
      minWidth: 80,
    },
    {
      id: "address",
      name: "Адрес",
      sortable: true,
      dataType: "string",
      isAbsoluteFixed: true,
      minWidth: 260,
    },
    {
      id: "details",
      name: "Описание проблемы",
      sortable: false,
      dataType: "string",
      isRequired: true,
      minWidth: 220,
    },
    {
      id: "staff_name",
      name: "Ответственный",
      sortable: true,
      dataType: "string",
      isRequired: true,
      minWidth: 160,
    },
    {
      id: "date",
      name: "Дата создания",
      sortable: true,
      dataType: "date",
      minWidth: 140,
    },
    {
      id: "notify_status",
      name: "Статус уведомления",
      sortable: true,
      dataType: "string",
      minWidth: 220,
    },
    {
      id: "staff_name2",
      name: "Ответственный 2",
      sortable: true,
      dataType: "string",
      hidden: true,
      minWidth: 160,
    },
    {
      id: "notify_status2",
      name: "Статус уведомления 2",
      sortable: true,
      dataType: "string",
      hidden: true,
      minWidth: 220,
    },
    {
      id: "staff_name3",
      name: "Ответственный 3",
      sortable: true,
      dataType: "string",
      hidden: true,
      minWidth: 160,
    },
    {
      id: "notify_status3",
      name: "Статус уведомления 3",
      sortable: true,
      dataType: "string",
      hidden: true,
      minWidth: 220,
    },
    {
      id: "repair_time",
      name: "Дата ремонта",
      sortable: true,
      dataType: "date",
      minWidth: 150,
    },
    {
      id: "other",
      name: "Дополнительно",
      sortable: false,
      dataType: "string",
      minWidth: 140,
    },
    {
      id: "close_date",
      name: "Дата закрытия",
      sortable: true,
      dataType: "date",
      minWidth: 140,
    },
    {
      id: "close_name",
      name: "Кто закрыл",
      sortable: true,
      dataType: "string",
      minWidth: 150,
    },
    {
      id: "solution",
      name: "Решение/Устранение",
      sortable: false,
      dataType: "string",
      minWidth: 180,
    },
    {
      id: "department",
      name: "Отдел",
      sortable: false,
      dataType: "string",
      hidden: true,
      minWidth: 160,
    },
    {
      id: "request",
      name: "Тип запроса",
      sortable: false,
      dataType: "string",
      hidden: true,
      minWidth: 160,
    },
    {
      id: "group",
      name: "Группа",
      sortable: false,
      dataType: "string",
      hidden: true,
      minWidth: 160,
    },
  ],
};

tableSettings.columns.forEach((col) => {
  if (savedWidths[col.id]) {
    col.width = savedWidths[col.id];
  } else {
    col.width = `${col.minWidth}px`;
  }

  if (savedHidden !== null) {
    col.hidden = savedHidden.includes(col.id);
    col.visible = !col.hidden;
  } else {
    col.visible = !col.hidden;
  }
});

if (savedOrder) {
  const orderIds = savedOrder.split(",");
  // Защита от колонок, которых нет в старом сохраненном списке (улетают в конец)
  const getOrderIndex = (id) => {
    const i = orderIds.indexOf(id);
    return i === -1 ? Number.MAX_SAFE_INTEGER : i;
  };

  tableSettings.columns.sort((a, b) => {
    if (a.id === "id") return -1;
    if (b.id === "id") return 1;
    if (a.id === "address") return -1;
    if (b.id === "address") return 1;
    return getOrderIndex(a.id) - getOrderIndex(b.id);
  });
}

export function getFreezeLeftOffset() {
  const idColumn = tableSettings.columns.find((c) => c.id === "id");
  return idColumn && idColumn.width ? parseInt(idColumn.width) : 80;
}
// js/table/settings.js (в самом конце, после всех текущих манипуляций)

/**
 * Синхронизирует порядок и видимость колонок из localStorage
 * с текущим объектом tableSettings в памяти.
 * Вызывать при старте приложения (main.js) и после сохранения в ProfileController.
 */
export function syncTableSettingsFromStorage() {
  const savedOrderRaw = localStorage.getItem("tableColumnOrder");
  const savedHiddenRaw = localStorage.getItem("tableColumnHidden");

  if (savedHiddenRaw) {
    try {
      const hidden = JSON.parse(savedHiddenRaw);
      tableSettings.columns.forEach((col) => {
        col.hidden = hidden.includes(col.id);
        col.visible = !col.hidden;
      });
    } catch (e) {
      console.error("[tableSettings] Ошибка парсинга hidden", e);
    }
  }

  if (savedOrderRaw) {
    const orderArr = savedOrderRaw.split(",");
    const getOrderIndex = (id) => {
      const i = orderArr.indexOf(id);
      return i === -1 ? Number.MAX_SAFE_INTEGER : i;
    };
    // Важно: гарантируем, что id и address всегда идут первыми
    tableSettings.columns.sort((a, b) => {
      if (a.id === "id") return -1;
      if (b.id === "id") return 1;
      if (a.id === "address") return -1;
      if (b.id === "address") return 1;
      return getOrderIndex(a.id) - getOrderIndex(b.id);
    });
  }
}
