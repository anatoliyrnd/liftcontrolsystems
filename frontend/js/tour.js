/**
 * Сквозной обучающий тур по системе (driver.js).
 */

const STATE_KEY = "lift_tour_state";

/** Все селекторы тура в одном месте. */
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
  // Создание
  addressSlot: "#formAddressSlot",
  details: "#formDetails",
  staff: "#formStaffSlot",
  dicts: "#createGroupSlot",
  repair: "#repairTimeSlot", // ИСПРАВЛЕНО
  saveBtn: "#saveTicketBtn",
  // Карточка
  ticketHeader: '[data-tour="ticket-header"]',
  editBtn: "#editBtn",
  editDetails: "#detailsAddBlock", // ИСПРАВЛЕНО
  editStaff: "#staffSlotsContainer", // ИСПРАВЛЕНО
  editNotify: "#staffSlotsContainer", // ИСПРАВЛЕНО (статус ставится там же)
  editRepair: "#repairTimeEditBlock", // ИСПРАВЛЕНО
  staffSlots: "#staffSlotsContainer",
  notes: "#noteComposer",
  closeBtn: "#closeBtn",
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

// =========================================================================
// СОСТОЯНИЕ
// =========================================================================

let driverObj = null;
let driverLib = null;
let cssLoaded = false;
let selfNav = false;
let advancing = false;
let hashListener = null;
let addressObserver = null;

function loadState() {
  try {
    const raw = sessionStorage.getItem(STATE_KEY);
    return raw ? JSON.parse(raw) : null;
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

// =========================================================================
// СЦЕНАРИИ
// =========================================================================

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
            side: "bottom",
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
      ];
    case "create":
      return [
        {
          element: SEL.addressSlot,
          popover: {
            title: "1. Город",
            description: "Вначале выберите город.",
          },
          gate: "city",
          hint: "Сначала выберите город",
        },
        {
          element: SEL.addressSlot,
          popover: {
            title: "2. Улица и дом",
            description: "Выберите объект из выпадающего списка.",
          },
          gate: "city",
          hint: "Сначала выберите город",
        },
        {
          element: SEL.details,
          popover: {
            title: "3. Описание",
            description:
              "Обязательное поле. Опишите суть проблемы (минимум 6 символов).",
          },
        },
        {
          element: SEL.staff,
          popover: {
            title: "4. Ответственный",
            description: "Необязательное поле. Можно назначить позже.",
          },
        },
        {
          element: SEL.dicts,
          popover: {
            title: "5. Категории",
            description: "Укажите Группу, Тип запроса и Отдел.",
          },
        },
        {
          element: SEL.repair,
          popover: {
            title: "6. Срок ремонта",
            description: "Можно указать позже.",
          },
        },
        {
          element: SEL.saveBtn,
          popover: {
            title: "7. Сохранение",
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
            description: "Нажмите «Редактировать», чтобы продолжить.",
          },
          gate: "edit",
          hint: "Нажмите «Редактировать»",
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
          element: SEL.editNotify,
          popover: {
            title: "Статус уведомления",
            description: "Отметьте, если механик уведомлён.",
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
          element: SEL.staffSlots,
          popover: {
            title: "Слоты",
            description: "Нажмите на слот, чтобы назначить ответственного.",
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
            title: "Закрытие",
            description: "Нажмите сюда, чтобы ввести решение.",
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
          element: SEL.profileList,
          popover: {
            title: "Настройки таблиц",
            description: "Кликните по строке, чтобы менять порядок колонок.",
          },
        },
        {
          element: SEL.profileList + " > div:first-child",
          popover: {
            title: "Порядок колонок",
            description: "Стрелки ↑ и ↓ меняют позицию.",
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
// ГЕЙТЫ И ДЕТЕКТЫ
// =========================================================================

function streetControlExists() {
  const slot = document.querySelector(SEL.addressSlot);
  return (
    slot &&
    slot.querySelectorAll("select, input:not([type='hidden'])").length >= 2
  );
}

function editModeActive() {
  return !!document.querySelector(SEL.editDetails);
}

const GATES = {
  city: streetControlExists,
  edit: editModeActive,
};

function createStartIndex() {
  let start = 0;
  if (streetControlExists()) start = 2;
  const details = document.querySelector(SEL.details);
  if (start === 2 && details && details.value.trim().length >= 6) start = 3;
  const staffInput = document.querySelector(
    SEL.staff + " input, " + SEL.staff + " select",
  );
  if (start === 3 && staffInput && String(staffInput.value || "").trim() !== "")
    start = 4;

  // ИСПРАВЛЕНО: проверяем select внутри div-контейнера
  const groupSelect = document.querySelector(SEL.dicts + " select");
  if (start === 4 && groupSelect && String(groupSelect.value || "") !== "")
    start = 6;

  return start;
}

// =========================================================================
// ДЕМО-СТРОКА ОЧЕРЕДИ
// =========================================================================

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
  const row = document.querySelector(SEL.demoRow);
  if (row) row.remove();
  const tbody = document.querySelector(SEL.queueTable + " tbody");
  const empty = document.querySelector(SEL.queueEmpty);
  if (empty && tbody && tbody.children.length === 0) empty.style.display = "";
}

// =========================================================================
// ИНФРАСТРУКТУРА
// =========================================================================

async function loadDriver() {
<<<<<<< HEAD
    if (!driverLib) {
        const mod = await import('driver.js');
        driverLib = mod.driver;
    }
    if (!cssLoaded) {
        await import('driver.js/dist/driver.css');
        cssLoaded = true;
    }
    return driverLib;
=======
  if (!driverLib) {
    const mod = await import("driver.js");
    driverLib = mod.driver;
  }
  if (!cssLoaded) {
    await import("driver.js/dist/driver.css");
    cssLoaded = true;
  }
  return driverLib;
>>>>>>> 3864c5800864bca73b94bd8061505624f9f3fa98
}

function filterAvailable(steps) {
  return steps
    .map((s, i) => ({ s, i }))
    .filter(
      ({ s }) => !s.element || document.querySelector(s.element) !== null,
    );
}

function destroyDriverInstance() {
  if (addressObserver) {
    addressObserver.disconnect();
    addressObserver = null;
  }
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
  const el = document.querySelector(".driver-popover-progress-txt");
  if (!el || step.origIndex == null) return;
  const base = SCENARIO_ORDER.slice(
    0,
    SCENARIO_ORDER.indexOf(step.scenario),
  ).reduce((n, k) => n + stepsFor(k).length, 0);
  el.textContent = `${base + step.origIndex + 1} из ${TOTAL_STEPS}`;
}

// =========================================================================
// ЗАПУСК
// =========================================================================

async function beginScenario(state, notify) {
  const key = state.scenario;
  if (key === "queue") insertDemoRow();

  if (key === "create") {
    const slot = document.querySelector(SEL.addressSlot);
    if (slot) {
      addressObserver = new MutationObserver(() => {
        if (driverObj && streetControlExists()) {
          const active = driverObj.getActiveStep?.();
          if (
            active &&
            active.step &&
            active.step.gate === "city" &&
            active.step.origIndex === 0
          ) {
            driverObj.moveNext();
          }
        }
      });
      addressObserver.observe(slot, { childList: true, subtree: true });
    }
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

  let startAt = 0;
  if (key === "create") {
    const wanted = createStartIndex();
    const pos = available.findIndex(({ i }) => i >= wanted);
    startAt = pos === -1 ? available.length - 1 : pos;
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
    steps: available.map(({ s }) => s),
    onHighlightStarted: (_el, step) => updateGlobalProgress(step),

    // ИСПРАВЛЕНО: используем onNextClick и onPrevClick
    onNextClick: (_el, step, options) => {
      if (step.gate && GATES[step.gate] && !GATES[step.gate]()) {
        notify.info(step.hint || "Сначала выполните действие");
        return false;
      }
      // Ставим флаг только если это последний шаг
      if (step === options.steps[options.steps.length - 1]) {
        advancing = true;
      }
      return true;
    },
    onPrevClick: () => true,

    onDestroyed: () => {
      driverObj = null;
      if (addressObserver) {
        addressObserver.disconnect();
        addressObserver = null;
      }
      if (advancing) {
        advancing = false;
        goNextScenario(state, notify);
      } else if (!selfNav) {
        abortTour();
      }
    },
  });

  driverObj.drive(startAt);
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
    next = SCENARIO_ORDER[idx + 2] || null; // Пропускаем карточку, если нет ID
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
  const deadline = Date.now() + 3000;
  const tick = async () => {
    const first = stepsFor(state.scenario).find(
      (s) => !s.element || document.querySelector(s.element) !== null,
    );
    if (first) {
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
    console.error("[tour] Ошибка загрузки driver.js:", e);
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
