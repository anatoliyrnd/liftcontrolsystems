/**
 * Сквозной обучающий тур по системе (driver.js).
 */
import "driver.js/dist/driver.css";

const STATE_KEY = "lift_tour_state";

const SEL = {
  // Журнал
  createBtn: '[data-tour="create-btn"]',
  search: "#searchInput",
  filters: "#openOnlyFilters",
  sort: '[data-tour="table-sort"]',
  resizer: '[data-tour="table-resizer"]',
  table: "#dataTable",
  tableWrapper: ".table-wrapper",
  refreshBtn: "#refreshBtn",
  syncIndicator: "#syncIndicator",
  userMenu: "#userProfileBtn",
  // Создание
  addressSlot: "#formAddressSlot",
  citySelect: "#formAddressSlot select",
  streetInput: "#formAddressSlot input.search-input",
  streetDropdown: "#formAddressSlot .address-pill",
  details: "#formDetails",
  staff: "#formStaffSlot",
  dicts: "#createGroupSlot",
  repair: "#repairTimeSlot",
  saveBtn: "#saveTicketBtn",
  // Карточка
  ticketHeader: '[data-tour="ticket-header"]',
  editBtn: "#editBtn",
  editDetails: "#detailsAddBlock",
  editStaff: "#staffSlotsContainer",
  editRepair: "#repairTimeEditBlock",
  notes: "#noteComposer",
  cardSaveBtn: "#saveBtn",
  cancelEditBtn: "#cancelEditBtn",
  closeBtn: "#closeBtn",
  solutionInput: "#solutionInput",
  closeAndCreate: "#closeAndCreateWrap",
  // Закрытые / очередь / профиль
  period: "#periodSelectorContainer",
  queueTable: "#queueTable",
  queueEmpty: "#queueEmpty",
  profileList: "#columnsSettingsList",
  profileSave: "#saveSettingsBtn",
  // Демо-строка очереди
  demoRow: 'tr[data-demo-row="true"]',
  demoConfirm: 'tr[data-demo-row="true"] button[data-action="confirm"]',
  demoDelete: 'tr[data-demo-row="true"] button[data-action="delete"]',
};

let driverObj = null;
let driverLib = null;
let selfNav = false;
let advancing = false;
let hashListener = null;
let queueObserver = null;

function loadState() {
  try {
    return JSON.parse(sessionStorage.getItem(STATE_KEY) || "null");
  } catch (e) {
    return null;
  }
}
function saveState(state) {
  try {
    sessionStorage.setItem(STATE_KEY, JSON.stringify(state));
  } catch (e) {}
}
function clearState() {
  try {
    sessionStorage.removeItem(STATE_KEY);
  } catch (e) {}
}

const SCENARIO_ORDER = [
  "journal",
  "create",
  "ticket",
  "closed",
  "queue",
  "profile",
];

function stepsFor(key) {
  switch (key) {
    case "journal":
      return [
        {
          element: SEL.createBtn,
          popover: {
            title: "Новая заявка",
            description: "Нажмите «+», чтобы создать заявку.",
          },
        },
        {
          element: SEL.search,
          popover: {
            title: "Быстрый поиск",
            description:
              "Ищите заявки по номеру, адресу или имени ответственного.",
          },
        },
        {
          element: SEL.filters,
          popover: {
            title: "Фильтрация",
            description:
              "Оставьте нужные города или скройте долгосрочные заявки.",
          },
        },
        {
          element: SEL.sort,
          popover: {
            title: "Сортировка",
            description:
              "Кликните по названию колонки, чтобы отсортировать заявки.",
          },
        },
        {
          element: SEL.resizer,
          popover: {
            title: "Ширина колонок",
            description:
              "Удерживайте границу заголовка и тяните влево или вправо.",
          },
        },
        {
          element: SEL.table,
          popover: {
            title: "Журнал",
            description:
              "Красный — авария. Жёлтый — нет механика. ⏳ — ждёт синхронизации.",
          },
        },
        {
          element: SEL.tableWrapper,
          popover: {
            title: "Прокрутка",
            description:
              "Зажмите SHIFT и крутите колесо мыши, чтобы листать колонки.",
          },
        },
        {
          element: SEL.refreshBtn,
          popover: {
            title: "Обновить",
            description: "Обновляет список заявок с сервера.",
          },
        },
        {
          element: SEL.syncIndicator,
          popover: {
            title: "Синхронизация",
            description: "Показывает количество офлайн-действий.",
          },
        },
        {
          element: SEL.userMenu,
          popover: {
            title: "Меню пользователя",
            description: "Здесь можно сменить тему или выйти из системы.",
          },
        },
      ];
    case "create":
      return [
        {
          element: SEL.citySelect,
          popover: {
            title: "1. Выбор города",
            description: "Тур сам выберет город из списка. Нажмите «Далее».",
          },
        },
        {
          element: SEL.streetInput,
          popover: {
            title: "2. Поиск улицы",
            description: "Нажмите «Далее», чтобы тур ввел название улицы.",
          },
        },
        {
          element: SEL.addressSlot,
          popover: {
            title: "3. Выбор лифта",
            description:
              "Нажмите «Далее», чтобы тур выбрал конкретный лифт из выпадающего списка.",
          },
        },
        {
          element: SEL.details,
          popover: {
            title: "4. Описание",
            description: "Обязательное поле. Опишите суть проблемы.",
          },
        },
        {
          element: SEL.staff,
          popover: {
            title: "5. Ответственный",
            description: "Необязательное поле. Можно назначить позже.",
          },
        },
        {
          element: SEL.dicts,
          popover: {
            title: "6. Категории",
            description: "Укажите Группу, Тип запроса и Отдел.",
          },
        },
        {
          element: SEL.repair,
          popover: {
            title: "7. Срок ремонта",
            description: "Можно указать позже.",
          },
        },
        {
          element: SEL.saveBtn,
          popover: {
            title: "8. Сохранение",
            description: "Если нет сети — заявка сохранится локально.",
          },
        },
      ];
    case "ticket":
      return [
        {
          element: SEL.ticketHeader,
          popover: {
            title: "Номер и статус",
            description: "Здесь видны номер и адрес объекта.",
          },
        },
        {
          element: SEL.editBtn,
          popover: {
            title: "Редактирование",
            description:
              "Нажмите «Далее», чтобы тур открыл режим редактирования.",
          },
        },
        {
          element: SEL.editDetails,
          popover: {
            title: "Дополнить описание",
            description: "Текст добавляется к исходному.",
          },
        },
        {
          element: SEL.editStaff,
          popover: {
            title: "Ответственный",
            description: "Выберите механика из списка.",
          },
        },
        {
          element: SEL.editRepair,
          popover: {
            title: "Дата ремонта",
            description: "Выберите срок или укажите дату.",
          },
        },
        {
          element: SEL.cardSaveBtn,
          popover: {
            title: "Сохранение",
            description: "После внесения изменений нажмите «Сохранить».",
          },
        },
        {
          element: SEL.cancelEditBtn,
          popover: {
            title: "Отмена",
            description: "Нажмите «Далее», чтобы тур отменил редактирование.",
          },
        },
        {
          element: SEL.notes,
          popover: {
            title: "Рабочий чат",
            description: "Пишите сюда, когда механик выехал.",
          },
        },
        {
          element: SEL.closeBtn,
          popover: {
            title: "Закрытие заявки",
            description: "Нажмите «Далее», чтобы перейти к закрытию.",
          },
        },
        {
          element: SEL.solutionInput,
          popover: {
            title: "Решение",
            description: "Введите здесь, что было сделано.",
          },
        },
        {
          element: SEL.closeAndCreate,
          popover: {
            title: "Новая заявка по адресу",
            description:
              "Поставьте галочку, чтобы закрыть текущую и сразу создать новую по этому же адресу.",
          },
        },
      ];
    case "closed":
      return [
        {
          element: SEL.period,
          popover: {
            title: "Период",
            description: "Выберите период отображения.",
          },
        },
        {
          element: SEL.table,
          popover: {
            title: "Закрытые заявки",
            description: "Завершённые заявки за период.",
          },
        },
      ];
    case "queue":
      return [
        {
          element: SEL.demoRow,
          popover: {
            title: "Очередь",
            description: "Демонстрационная запись. Исчезнет после тура.",
          },
        },
        {
          element: SEL.demoConfirm,
          popover: {
            title: "Дубликат",
            description: "Подтверждает создание дубликата.",
          },
        },
        {
          element: SEL.demoDelete,
          popover: {
            title: "Удалить",
            description: "Удаляет задание из очереди.",
          },
        },
      ];
    case "profile":
      return [
        {
          element: () =>
            document
              .querySelector(SEL.profileList)
              ?.closest("details")
              ?.querySelector("summary") || SEL.profileList,
          popover: {
            title: "Настройка таблицы",
            description: "Нажмите «Далее», чтобы тур раскрыл этот блок.",
          },
        },
        {
          element: SEL.profileList,
          popover: {
            title: "Порядок колонок",
            description:
              "Стрелки ↑ и ↓ меняют позицию. Настройки сохраняются только для текущего пользователя.",
          },
        },
        {
          element: SEL.profileSave,
          popover: {
            title: "Сохранение",
            description: "Не забудьте нажать «Сохранить».",
          },
        },
      ];
    default:
      return [];
  }
}

function scenarioHash(key, state) {
  switch (key) {
    case "journal":
      return "#/";
    case "create":
      return "#/create";
    case "ticket":
      return "#/ticket/" + encodeURIComponent(state.ticketId);
    case "closed":
      return "#/closed";
    case "queue":
      return "#/queue";
    case "profile":
      return "#/profile";
    default:
      return "#/";
  }
}

const TOTAL_STEPS = SCENARIO_ORDER.reduce((n, k) => n + stepsFor(k).length, 0);

// =========================================================================
// ПРОГРАММНЫЕ ДЕЙСТВИЯ
// =========================================================================

function autoFillCity() {
  const select = document.querySelector(SEL.citySelect);
  if (select && !select.value) {
    select.selectedIndex = 1;
    select.dispatchEvent(new Event("change", { bubbles: true }));
  }
}

function autoFillStreet() {
  const input = document.querySelector(SEL.streetInput);
  if (input && !input.value) {
    input.value = "Красноармейская";
    input.dispatchEvent(new Event("input", { bubbles: true }));
  }
}

function autoSelectObject() {
  setTimeout(() => {
    const pill = document.querySelector(SEL.streetDropdown);
    if (pill) pill.click();
  }, 600);
}

function insertDemoRow() {
  const tbody = document.querySelector(SEL.queueTable + " tbody");
  if (!tbody || document.querySelector(SEL.demoRow)) return;

  const tr = document.createElement("tr");
  tr.setAttribute("data-demo-row", "true");

  const cells = [
    "⚠ Демо",
    "Создание",
    "—",
    "г. Ростов-на-Дону, пр. Буденновский, д.1",
    "Требует подтверждения",
    "Дубликат (3)",
    "—",
  ];
  cells.forEach((text) => {
    const td = document.createElement("td");
    td.textContent = text;
    tr.appendChild(td);
  });

  const actionsTd = document.createElement("td");
  const confirmBtn = document.createElement("button");
  confirmBtn.type = "button";
  confirmBtn.className = "queue-action-btn";
  confirmBtn.dataset.action = "confirm";
  confirmBtn.disabled = true;
  confirmBtn.textContent = "Создать дубликат";

  const deleteBtn = document.createElement("button");
  deleteBtn.type = "button";
  deleteBtn.className = "queue-delete-btn";
  deleteBtn.dataset.action = "delete";
  deleteBtn.disabled = true;
  deleteBtn.textContent = "×";

  actionsTd.appendChild(confirmBtn);
  actionsTd.appendChild(deleteBtn);
  tr.appendChild(actionsTd);

  tbody.insertBefore(tr, tbody.firstChild);
  const empty = document.querySelector(SEL.queueEmpty);
  if (empty) empty.style.display = "none";
}

function removeDemoRow() {
  if (queueObserver) {
    queueObserver.disconnect();
    queueObserver = null;
  }
  const row = document.querySelector(SEL.demoRow);
  if (row) row.remove();
  const tbody = document.querySelector(SEL.queueTable + " tbody");
  const empty = document.querySelector(SEL.queueEmpty);
  if (empty && tbody && tbody.children.length === 0) empty.style.display = "";
}

function watchDemoRow() {
  const tbody = document.querySelector(SEL.queueTable + " tbody");
  if (!tbody || queueObserver) return;
  queueObserver = new MutationObserver(() => {
    if (!document.querySelector(SEL.demoRow)) insertDemoRow();
  });
  queueObserver.observe(tbody, { childList: true });
}

// =========================================================================
// ИНФРАСТРУКТУРА
// =========================================================================

async function loadDriver() {
  if (!driverLib) {
    const mod = await import("driver.js");
    driverLib = mod.driver;
  }
  return driverLib;
}

function filterAvailable(steps) {
  return steps
    .map((s, i) => ({ s, i }))
    .filter(
      ({ s }) =>
        !s.element ||
        typeof s.element === "function" ||
        document.querySelector(s.element) !== null,
    );
}

function destroyDriverInstance() {
  if (driverObj) {
    try {
      driverObj.destroy();
    } catch (e) {}
    driverObj = null;
  }
}

export function stopTour() {
  destroyDriverInstance();
}

function dropHashListener() {
  if (hashListener) {
    window.removeEventListener("hashchange", hashListener);
    hashListener = null;
  }
}

function abortTour() {
  destroyDriverInstance();
  dropHashListener();
  removeDemoRow();
  clearState();
  advancing = false;
}

async function finishTour(notify) {
  destroyDriverInstance();
  dropHashListener();
  removeDemoRow();
  clearState();
  advancing = false;
  notify.success(
    "Обучение завершено. Вы всегда можете запустить его снова из меню.",
  );
}

function updateGlobalProgress(step) {
  if (step.origIndex == null) return;
  const base = SCENARIO_ORDER.slice(
    0,
    SCENARIO_ORDER.indexOf(step.scenario),
  ).reduce((n, k) => n + stepsFor(k).length, 0);
  const text = `${base + step.origIndex + 1} из ${TOTAL_STEPS}`;
  requestAnimationFrame(() => {
    const el =
      document.querySelector(".driver-popover-progress-text") ||
      document.querySelector(".driver-popover-progress-txt");
    if (el) el.textContent = text;
  });
}

// =========================================================================
// ЗАПУСК
// =========================================================================

async function beginScenario(state, notify) {
  const key = state.scenario;

  if (key === "queue") {
    insertDemoRow();
    watchDemoRow();
  }

  // Принудительно закрываем details в профиле для начала тура
  if (key === "profile") {
    const details = document.querySelector(SEL.profileList)?.closest("details");
    if (details) details.open = false;
  }

  const all = stepsFor(key).map((s, i) => ({
    ...s,
    origIndex: i,
    scenario: key,
  }));
  const available = filterAvailable(all);

  if (available.length === 0) {
    goNextScenario(state, notify);
    return;
  }

  const driverFn = await loadDriver();

  driverObj = driverFn({
    showProgress: true,
    allowClose: true,
    overlayOpacity: 0.6,
    stagePadding: 6,
    popoverClass: "driver-tour-popover",
    nextBtnText: "Далее →",
    prevBtnText: "← Назад",
    doneBtnText: "Завершить",
    disableActiveInteraction: true,
    overlayClickBehavior: "none",
    steps: available.map(({ s }) => s),

    onHighlightStarted: (_el, step) => {
      updateGlobalProgress(step);
    },

    onNextClick: (_el, step) => {
      if (key === "create") {
        if (step.origIndex === 0) autoFillCity();
        if (step.origIndex === 1) autoFillStreet();
        if (step.origIndex === 2) autoSelectObject();
      }

      if (key === "ticket") {
        if (step.origIndex === 1) document.querySelector(SEL.editBtn)?.click();
        if (step.origIndex === 6)
          document.querySelector(SEL.cancelEditBtn)?.click();
        if (step.origIndex === 8) document.querySelector(SEL.closeBtn)?.click();
      }

      // Раскрываем details перед показом следующего шага в профиле
      if (key === "profile" && step.origIndex === 0) {
        const details = document
          .querySelector(SEL.profileList)
          ?.closest("details");
        if (details) details.open = true;
      }

      if (driverObj && driverObj.isLastStep()) advancing = true;
      driverObj.moveNext();
    },
    onPrevClick: () => {
      driverObj.movePrevious();
    },
    onDestroyed: () => {
      driverObj = null;
      if (advancing) {
        advancing = false;
        goNextScenario(state, notify);
      } else if (!selfNav) {
        abortTour();
      }
    },
  });

  driverObj.drive(0);
}

function goNextScenario(state, notify) {
  const idx = SCENARIO_ORDER.indexOf(state.scenario);
  let next = SCENARIO_ORDER[idx + 1] || null;

  if (state.scenario === "journal") {
    const idCell = document.querySelector(
      SEL.table + ' tbody tr td[data-col-id="id"]',
    );
    if (idCell) state.ticketId = idCell.textContent.trim();
  }

  if (next === "ticket" && !state.ticketId) {
    next = SCENARIO_ORDER[idx + 2] || null;
  }
  if (state.scenario === "queue") removeDemoRow();

  if (!next) {
    finishTour(notify);
    return;
  }

  state.scenario = next;
  saveState(state);
  selfNav = true;
  window.location.hash = scenarioHash(next, state).slice(1);
}

function scheduleResume(state, notify) {
  const deadline = Date.now() + 5000;

  const getContainer = (s) => {
    switch (s) {
      case "journal":
        return "#dataTable";
      case "create":
        return "#formAddressSlot";
      case "ticket":
        return "#ticketDetailsDynamicContainer";
      case "closed":
        return "#dataTable";
      case "queue":
        return "#queueTable";
      case "profile":
        return "#columnsSettingsList";
      default:
        return "#app";
    }
  };
  const containerSel = getContainer(state.scenario);

  const tick = async () => {
    if (document.querySelector(containerSel)) {
      await new Promise((r) => setTimeout(r, 400));
      await beginScenario(state, notify);
      return;
    }
    if (Date.now() < deadline) setTimeout(tick, 100);
    else abortTour();
  };
  setTimeout(tick, 50);
}

export async function startTour() {
  const { notify } = await import("./components/notify.js");
  if (driverObj) return;

  let state = loadState();
  if (!state) {
    state = { scenario: "journal", ticketId: null };
    saveState(state);
  }

  if (!hashListener) {
    hashListener = () => {
      if (selfNav) {
        selfNav = false;
        scheduleResume(state, notify);
      } else if (loadState()) {
        abortTour();
      }
    };
    window.addEventListener("hashchange", hashListener);
  }

  const target = scenarioHash(state.scenario, state);
  const current = window.location.hash || "#/";

  try {
    await loadDriver();
  } catch (e) {
    console.error("[tour] Ошибка загрузки:", e);
    notify.error("Обучающий тур недоступен.");
    clearState();
    return;
  }

  if (current !== target) {
    selfNav = true;
    window.location.hash = target.slice(1);
  } else {
    await beginScenario(state, notify);
  }
}
