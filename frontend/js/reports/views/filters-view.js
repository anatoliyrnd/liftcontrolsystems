import { REPORTS } from "../../config.js";
import { createAddressPicker } from "../../components/address-picker.js";
import { notify } from "../../components/notify.js";
import {
  mskDayStartTs,
  mskDayEndTs,
  mskTodayYmd,
  formatTsMsk,
} from "../../utils/date-utils.js";

const TEXT_HINT = "Выберите конкретный дом или лифт для полнотекстового поиска";

function el(tag, attrs = {}, text = null) {
  const node = document.createElement(tag);
  for (const [k, v] of Object.entries(attrs)) {
    if (k === "class") node.className = v;
    else if (k === "style") node.style.cssText = v;
    else node.setAttribute(k, v);
  }
  if (text != null) node.textContent = text;
  return node;
}

function field(labelText, control, cls = "") {
  const box = el("div", { class: `rep-f${cls ? " " + cls : ""}` });
  if (labelText) box.appendChild(el("label", { class: "rep-fl" }, labelText));
  box.appendChild(control);
  return box;
}

function radio(name, value, text, checked) {
  const r = el("input", { type: "radio", name, value });
  r.checked = checked === true;
  const item = el("label", { class: "rep-chip" });
  item.appendChild(r);
  item.appendChild(el("span", {}, text));
  return { input: r, item };
}

function check(text, checked) {
  const c = el("input", { type: "checkbox" });
  c.checked = checked === true;
  const item = el("label", { class: "rep-chip" });
  item.appendChild(c);
  item.appendChild(el("span", {}, text));
  return { input: c, item };
}

/**
 * Панель расширенного поиска — только фильтры, три плотные строки.
 * Таблицы и экспорта здесь нет: они живут в отдельной вкладке
 * браузера. «Найти» отдаёт payload контроллеру синхронно — тот
 * обязан открыть вкладку до первого await, иначе браузер заблокирует
 * её как не пользовательский жест.
 *
 * Бизнес-правила прежние: последний отдел не снимается, полнотекст
 * только при доме/лифте и не при city_only, «до» не больше сегодня.
 * Потолок периода теперь приезжает опцией access (уровень тенанта),
 * REPORTS.MAX_RANGE_DAYS — фолбэк для сервера без REPORTS §17.
 *
 * REPORTS §17: замки групп. Матрицу уровней вьюха НЕ хранит: контроллер
 * передаёт снимок access из userStore, вьюха только применяет.
 * Заблокированная группа приводится к дефолту В UI (иначе radio
 * «Открытые» врал бы при payload status=all), а payload шлёт дефолт
 * сервера: department_ids [] = «условия по отделу нет».
 */
export function createFiltersView(opts) {
  const {
    departments = [],
    staff = [],
    canStaffFilter = false,
    access = null,
    initial = null,
    onSubmit,
    onReset,
  } = opts;

  // Фолбэк = прежнее поведение standard: сервер без REPORTS §17 не присылает
  // limits, и форма не должна сужаться сама по себе.
  const acc = {
    objectOnly: false,
    maxRangeDays: REPORTS.MAX_RANGE_DAYS,
    maxRows: REPORTS.EXPORT_MAX_ROWS,
    ...(access || {}),
    groups: {
      department: true,
      status: true,
      staff: true,
      text: true,
      addressMulti: true,
      ...((access && access.groups) || {}),
    },
  };
  const g = acc.groups;
  //const LOCK_FILTER = REPORTS.ACCESS.LOCK_FILTER_HINT;
  const LOCK_FILTER = REPORTS.ACCESS.LOCK_HINT;
  const v = initial || {};
  const root = el("div", { class: "rep-filters" });
  let busy = false;

  const isKnownSort = (s) =>
    Object.prototype.hasOwnProperty.call(REPORTS.SORTS, s);
  const safeStatus = (s) => (["all", "open", "close"].includes(s) ? s : "all");

  function lockControl(node, hint) {
    node.disabled = true;
    node.title = hint;
    node.classList.add("locked");
  }

  // --- период -------------------------------------------------------
  const fromInput = el("input", {
    type: "date",
    class: "search-input rep-date",
    id: "repDateFrom",
  });
  const toInput = el("input", {
    type: "date",
    class: "search-input rep-date",
    id: "repDateTo",
  });
  toInput.max = mskTodayYmd();
  fromInput.value = v.fromYmd || "";
  toInput.value = v.toYmd || "";

  const created = radio(
    "repDateType",
    "created",
    "создание",
    v.dateType !== "closed",
  );
  const closed = radio(
    "repDateType",
    "closed",
    "закрытие",
    v.dateType === "closed",
  );
  const dateTypeBox = el("div", { class: "rep-chips" });
  dateTypeBox.appendChild(created.item);
  dateTypeBox.appendChild(closed.item);

  const cityOnly = check("только город", v.cityOnly === true);

  // --- адрес --------------------------------------------------------
  // REPORTS §17 light: mode elevator — заголовок дома не кликабелен, выбрать
  // можно только лифт. Обязательность лифта дублируется в validate():
  // setValue из snapshot может восстановить дом-выборку и в этом режиме.
  const picker = createAddressPicker({
    mode: acc.objectOnly ? "elevator" : "any",
    autoOpen: false,
    onChange: () => {
      refreshTextEnabled();
      scheduleChange();
    },
  });
  const addressBox = el("div", { class: "rep-f-address" });
  addressBox.appendChild(el("label", { class: "rep-fl" }, "Адрес"));
  addressBox.appendChild(picker.element);
  if (v.address) picker.setValue(v.address);

  // --- полнотекст и сортировка --------------------------------------
  const detailsInput = el("input", {
    type: "text",
    class: "search-input",
    id: "repDetailsText",
    placeholder: "текст в описании",
  });
  const solutionInput = el("input", {
    type: "text",
    class: "search-input",
    id: "repSolutionText",
    placeholder: "текст в решении",
  });
  detailsInput.value = v.detailsText || "";
  solutionInput.value = v.solutionText || "";

  const sortSelect = el("select", { class: "search-input", id: "repSort" });
  for (const [value, text] of Object.entries(REPORTS.SORTS)) {
    sortSelect.appendChild(el("option", { value }, text));
  }
  sortSelect.value = isKnownSort(v.sort) ? v.sort : REPORTS.SORT_DEFAULT;

  // --- отделы -------------------------------------------------------
  const selected = new Set(
    Array.isArray(v.departmentIds) && v.departmentIds.length > 0
      ? v.departmentIds.map(String)
      : departments.map((d) => String(d.id)),
  );
  const deptBox = el("div", { class: "rep-dept" });
  const deptCheckboxes = new Map();
  for (const dep of departments) {
    const c = check(dep.name, selected.has(String(dep.id)));
    c.input.value = String(dep.id);
    deptCheckboxes.set(String(dep.id), c.input);
    c.input.addEventListener("change", () => {
      const checked = c.input.checked === true;
      c.input.checked = checked;
      if (checked) {
        selected.add(String(dep.id));
      } else {
        // preventDefault на change не работает — возвращаем галочку явно.
        if (selected.size <= 1) {
          c.input.checked = true;
          notify.warning("Выберите хотя бы один отдел");
          return;
        }
        selected.delete(String(dep.id));
      }
      scheduleChange();
    });
    deptBox.appendChild(c.item);
  }

  // --- статус и ответственный ---------------------------------------
  const st = safeStatus(v.status);
  const statusAll = radio("repStatus", "all", "Все", st === "all");
  const statusOpen = radio("repStatus", "open", "Открытые", st === "open");
  const statusClose = radio("repStatus", "close", "Закрытые", st === "close");
  const statusBox = el("div", { class: "rep-chips" });
  statusBox.appendChild(statusAll.item);
  statusBox.appendChild(statusOpen.item);
  statusBox.appendChild(statusClose.item);

  const staffToggle = el("input", { type: "checkbox", id: "repStaffToggle" });
  staffToggle.checked = v.staffEnabled === true;
  const staffSelect = el("select", {
    class: "search-input",
    id: "repStaffSelect",
  });
  staffSelect.appendChild(el("option", { value: "" }, "— выберите —"));
  for (const s of staff) {
    staffSelect.appendChild(el("option", { value: String(s.id) }, s.name));
  }
  if (v.staffId != null) staffSelect.value = String(v.staffId);
  staffSelect.disabled = !staffToggle.checked;

  const staffLine = el("div", { class: "rep-chips" });
  const staffToggleLabel = el("label", { class: "rep-chip" });
  staffToggleLabel.appendChild(staffToggle);
  staffToggleLabel.appendChild(el("span", {}, "ответственный"));
  staffLine.appendChild(staffToggleLabel);
  staffLine.appendChild(staffSelect);
  const staffField = field(
    "Фильтр по ответственному",
    staffLine,
    "rep-f-staff",
  );
  if (!canStaffFilter) staffField.style.display = "none";

  // --- кнопки -------------------------------------------------------
  const searchBtn = el(
    "button",
    { type: "button", class: "menu-item rep-primary", id: "repSearchBtn" },
    "Найти",
  );
  const resetBtn = el(
    "button",
    { type: "button", class: "menu-item", id: "repResetBtn" },
    "Сбросить",
  );
  const btnBox = el("div", { class: "rep-f rep-f-btns" });
  btnBox.appendChild(searchBtn);
  btnBox.appendChild(resetBtn);

  const msgEl = el("div", { class: "rep-msg", style: "display:none;" });
  const periodEl = el("div", { class: "rep-period" });
  // REPORTS §17: подпись потолков light. Числа не зашиваем в текст словаря —
  // показываем сам факт ограничения, цифры видны в датах и в отказе сервера.
  const capEl = el("div", { class: "rep-period", style: "display:none;" });
  if (acc.objectOnly) {
    capEl.textContent = REPORTS.ACCESS.CAP_NOTE;
    capEl.style.display = "";
  }

  // --- сборка -------------------------------------------------------
  const row1 = el("div", { class: "rep-frow" });
  row1.appendChild(field("От", fromInput, "rep-f-date"));
  row1.appendChild(field("До", toInput, "rep-f-date"));
  row1.appendChild(field("Искать по дате", dateTypeBox));
  row1.appendChild(field("", cityOnly.item, "rep-f-inline"));
  row1.appendChild(addressBox);

  const row2 = el("div", { class: "rep-frow" });
  row2.appendChild(field("Поиск по описанию", detailsInput, "rep-f-grow"));
  row2.appendChild(field("Поиск по решению", solutionInput, "rep-f-grow"));
  row2.appendChild(field("Сортировка", sortSelect, "rep-f-sort"));

  const row3 = el("div", { class: "rep-frow" });
  row3.appendChild(field("Отделы", deptBox, "rep-f-dept"));
  row3.appendChild(field("Статус", statusBox));
  row3.appendChild(staffField);
  row3.appendChild(btnBox);

  root.appendChild(row1);
  root.appendChild(row2);
  root.appendChild(row3);
  root.appendChild(msgEl);
  root.appendChild(periodEl);
  root.appendChild(capEl);

  // --- логика -------------------------------------------------------
  let changeTimer = null;
  const scheduleChange = () => {
    if (changeTimer) clearTimeout(changeTimer);
    changeTimer = setTimeout(() => validate(), 120);
  };

  /**
   * REPORTS §17: замки групп приводим к дефолту в UI. Без этого radio «Открытые»
   * или снятые отделы показывали бы условие, которого в payload нет:
   * заблокированная группа всегда шлёт дефолт сервера.
   * Вызывается при создании и в setValues (восстановление snapshot
   * прошлой сессии могло принести значения уровня standard).
   */
  function applyLocks() {
    if (!g.department) {
      selected.clear();
      for (const [id, cb] of deptCheckboxes) {
        cb.checked = true;
        selected.add(id);
        lockControl(cb, LOCK_FILTER);
      }
    }
    if (!g.status) {
      statusAll.input.checked = true;
      for (const r of [statusAll, statusOpen, statusClose]) {
        lockControl(r.input, LOCK_FILTER);
      }
    }
    if (!g.addressMulti) {
      cityOnly.input.checked = false;
      lockControl(cityOnly.input, LOCK_FILTER);
    }
    if (!g.text) {
      lockControl(detailsInput, REPORTS.ACCESS.TEXT_LOCK_HINT);
      lockControl(solutionInput, REPORTS.ACCESS.TEXT_LOCK_HINT);
    }
  }

  function refreshTextEnabled() {
    const sel = picker.getValue();
    const ok =
      g.text &&
      !cityOnly.input.checked &&
      !!sel &&
      ((Number(sel.home_id) || 0) > 0 || (Number(sel.object_id) || 0) > 0);
    for (const inp of [detailsInput, solutionInput]) {
      // Замок уровня не снимается выбором адреса: сначала право, потом адрес.
      inp.disabled = !g.text || !ok;
      inp.title = !g.text ? REPORTS.ACCESS.TEXT_LOCK_HINT : ok ? "" : TEXT_HINT;
    }
  }

  function validate() {
    const from = mskDayStartTs(fromInput.value);
    const to = mskDayEndTs(toInput.value);
    let msg = "";
    if (from === null || to === null) msg = "Укажите даты периода";
    else if (from > to) msg = "Дата «от» не может быть больше даты «до»";
    else if (to > mskDayEndTs(mskTodayYmd()))
      msg = "Дата «до» не может быть больше сегодняшней";
    else if (to - from > acc.maxRangeDays * 86400)
      msg = `Период не может превышать ${acc.maxRangeDays} дней`;
    else if (acc.objectOnly) {
      // REPORTS §17 light: второй пояс к mode elevator — snapshot мог вернуть дом.
      const sel = picker.getValue();
      if (!sel || !(Number(sel.object_id) > 0))
        msg = REPORTS.ACCESS.OBJECT_HINT;
    }
    msgEl.textContent = msg;
    msgEl.style.display = msg ? "block" : "none";
    fromInput.classList.toggle("rep-invalid", !!msg);
    toInput.classList.toggle("rep-invalid", !!msg);
    periodEl.textContent =
      !msg && from !== null
        ? `Период МСК: ${formatTsMsk(from)} — ${formatTsMsk(to)}`
        : "";
    searchBtn.disabled = !!msg || busy;
    return !msg;
  }

  function getPayload() {
    const sel = picker.getValue();
    const useLower = !cityOnly.input.checked && !!sel;
    return {
      date_from: mskDayStartTs(fromInput.value),
      date_to: mskDayEndTs(toInput.value),
      date_type: closed.input.checked ? "closed" : "created",
      city_id: sel ? Number(sel.city_id) || null : null,
      street_id: useLower ? Number(sel.street_id) || null : null,
      home_id: useLower ? Number(sel.home_id) || null : null,
      object_id: useLower ? Number(sel.object_id) || null : null,
      city_only: cityOnly.input.checked,
      // REPORTS §17: заблокированная группа шлёт дефолт сервера, а не состояние
      // задизейбленных контролов. [] = «условия по отделу нет».
      department_ids: g.department ? [...selected] : [],
      status: !g.status
        ? "all"
        : statusOpen.input.checked
          ? "open"
          : statusClose.input.checked
            ? "close"
            : "all",
      staff_id:
        canStaffFilter && staffToggle.checked
          ? Number(staffSelect.value) || null
          : null,
      details_text: detailsInput.disabled ? "" : detailsInput.value.trim(),
      solution_text: solutionInput.disabled ? "" : solutionInput.value.trim(),
      sort: sortSelect.value,
    };
  }

  function snapshot() {
    return {
      fromYmd: fromInput.value,
      toYmd: toInput.value,
      dateType: closed.input.checked ? "closed" : "created",
      address: picker.getValue(),
      cityOnly: cityOnly.input.checked,
      departmentIds: [...selected],
      status: statusOpen.input.checked
        ? "open"
        : statusClose.input.checked
          ? "close"
          : "all",
      staffEnabled: staffToggle.checked,
      staffId: Number(staffSelect.value) || null,
      detailsText: detailsInput.value,
      solutionText: solutionInput.value,
      sort: sortSelect.value,
    };
  }

  function setValues(next) {
    fromInput.value = next.fromYmd || "";
    toInput.value = next.toYmd || "";
    (next.dateType === "closed" ? closed : created).input.checked = true;
    cityOnly.input.checked = next.cityOnly === true;
    if (next.address) picker.setValue(next.address);
    else picker.reset();

    // null/пусто = «все отделы»: ноль галочек ломает защиту последнего,
    // а payload [] на сервере молча означает «условия по отделу нет».
    const depIds =
      Array.isArray(next.departmentIds) && next.departmentIds.length > 0
        ? next.departmentIds.map(String)
        : departments.map((d) => String(d.id));
    for (const [id, cb] of deptCheckboxes) cb.checked = depIds.includes(id);
    selected.clear();
    for (const id of depIds) selected.add(id);

    const s = safeStatus(next.status);
    (s === "open"
      ? statusOpen
      : s === "close"
        ? statusClose
        : statusAll
    ).input.checked = true;
    staffToggle.checked = next.staffEnabled === true;
    staffSelect.disabled = !staffToggle.checked;
    if (next.staffId != null) staffSelect.value = String(next.staffId);
    detailsInput.value = next.detailsText || "";
    solutionInput.value = next.solutionText || "";
    sortSelect.value = isKnownSort(next.sort)
      ? next.sort
      : REPORTS.SORT_DEFAULT;

    // REPORTS §17: snapshot прошлой сессии мог прийти с уровня standard —
    // замки применяем ПОСЛЕ восстановления, иначе UI соврёт о payload.
    applyLocks();
    picker.setSearchCollapsed(cityOnly.input.checked === true);
    refreshTextEnabled();
    validate();
  }

  function setBusy(flag) {
    busy = flag === true;
    searchBtn.textContent = busy ? "Открываю..." : "Найти";
    validate();
  }

  fromInput.addEventListener("change", validate);
  toInput.addEventListener("change", validate);
  cityOnly.input.addEventListener("change", () => {
    // R1: «только город» сворачивает поле поиска адреса и сбрасывает
    // выбор ниже города. Иначе диспетчер выбирал бы лифт, который
    // getPayload молча отбросит (useLower = !cityOnly).
    picker.setSearchCollapsed(cityOnly.input.checked === true);
    refreshTextEnabled();
    scheduleChange();
  });
  sortSelect.addEventListener("change", scheduleChange);
  staffToggle.addEventListener("change", () => {
    staffSelect.disabled = !staffToggle.checked;
    scheduleChange();
  });
  searchBtn.addEventListener("click", () => {
    // Синхронно: контроллер открывает вкладку браузера внутри этого
    // же жеста. Никаких await до window.open.
    if (validate()) onSubmit(getPayload());
  });
  resetBtn.addEventListener("click", () => onReset());

  applyLocks();
  picker.setSearchCollapsed(cityOnly.input.checked === true);
  refreshTextEnabled();
  validate();

  return {
    element: root,
    getPayload,
    snapshot,
    setValues,
    setBusy,
    validate,
    /** Подложка пикера лежит в body и переживает display:none панели. */
    closeOverlays: () => picker.closeDropdown?.(),
    destroy: () => {
      if (changeTimer) clearTimeout(changeTimer);
      picker.destroy();
    },
  };
}
