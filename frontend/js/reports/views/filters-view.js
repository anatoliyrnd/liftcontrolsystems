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
const label = (text) =>
    el("label", {
        class: "rep-label",
        style:
            "font-size:11px;font-weight:700;color:var(--text-secondary);text-transform:uppercase;display:block;margin-bottom:4px;",
    }, text);

/**
 * Панель фильтров отчёта. Вся разметка — createElement + textContent
 * (правило 1): значения справочников приходят с сервера и не должны
 * иметь пути в innerHTML.
 *
 * Бизнес-защиты из ТЗ:
 *  — нельзя снять галочку с последнего отдела (notify.warning);
 *  — полнотекст заблокирован без дома/лифта и при city_only;
 *  — даты: «до» не больше сегодня, «от» не больше «до», дельта ≤ 90
 *    календарных дней; нарушение — красная обводка и блокировка кнопок.
 */
export function createFiltersView(opts) {
    const {
        departments = [],
        staff = [],
        canStaffFilter = false,
        initial = null,
        onSubmit,
        onExport,
        onReset,
    } = opts;

    const v = initial || {};
    const root = el("div", { class: "rep-filters" });
    let busy = false;

    // --- период -------------------------------------------------------
    const fromInput = el("input", { type: "date", class: "search-input rep-date", id: "repDateFrom" });
    const toInput = el("input", { type: "date", class: "search-input rep-date", id: "repDateTo" });
    toInput.max = mskTodayYmd();
    fromInput.value = v.fromYmd || "";
    toInput.value = v.toYmd || "";
    const createdRadio = el("input", { type: "radio", name: "repDateType", value: "created" });
    const closedRadio = el("input", { type: "radio", name: "repDateType", value: "closed" });
    (v.dateType === "closed" ? closedRadio : createdRadio).checked = true;
    const periodEl = el("div", {
        class: "rep-period",
        style: "font-size:11px;color:var(--text-secondary);margin-top:4px;",
    });
    const msgEl = el("div", {
        class: "rep-msg",
        style: "display:none;font-size:12px;color:#ef4444;margin-top:4px;",
    });

    // --- адрес --------------------------------------------------------
    const cityOnlyCb = el("input", { type: "checkbox", id: "repCityOnly" });
    cityOnlyCb.checked = v.cityOnly === true;
    const picker = createAddressPicker({
        mode: "any",
        autoOpen: false,
        onChange: () => {
            refreshTextEnabled();
            scheduleChange();
        },
    });
    const addressWrap = el("div", { class: "rep-address", style: "min-width:260px;flex:1;" });
    addressWrap.appendChild(picker.element);
    if (v.address) picker.setValue(v.address);

    // --- полнотекст ---------------------------------------------------
    const detailsInput = el("input", { type: "text", class: "search-input", id: "repDetailsText", placeholder: "Поиск по описанию" });
    const solutionInput = el("input", { type: "text", class: "search-input", id: "repSolutionText", placeholder: "Поиск по решению" });
    detailsInput.value = v.detailsText || "";
    solutionInput.value = v.solutionText || "";

    // --- отделы -------------------------------------------------------
    const selected = new Set(
        Array.isArray(v.departmentIds) && v.departmentIds.length > 0
            ? v.departmentIds.map(String)
            : departments.map((d) => String(d.id)),
    );
    const deptBox = el("div", {
        class: "rep-dept",
        style: "display:flex;flex-wrap:wrap;gap:4px 14px;max-height:88px;overflow-y:auto;",
    });
    for (const dep of departments) {
        const cb = el("input", { type: "checkbox", value: String(dep.id) });
        cb.checked = selected.has(String(dep.id));
        cb.addEventListener("change", () => {
            const checked = cb.checked === true;
            cb.checked = checked;
            if (checked) {
                selected.add(String(dep.id));
            } else {
                // Защита последнего отдела: preventDefault на change не
                // работает, состояние задаём явно и возвращаем галочку.
                if (selected.size <= 1) {
                    cb.checked = true;
                    notify.warning("Выберите хотя бы один отдел");
                    return;
                }
                selected.delete(String(dep.id));
            }
            scheduleChange();
        });
        const item = el("label", { class: "city-checkbox-item" });
        item.appendChild(cb);
        item.appendChild(el("span", {}, dep.name));
        deptBox.appendChild(item);
    }

    // --- статус, сортировка, ответственный ----------------------------
    const statusBox = el("div", { style: "display:flex;gap:12px;" });
    const statusRadios = {};
    for (const [value, text] of [["all", "Все"], ["open", "Открытые"], ["close", "Закрытые"]]) {
        const r = el("input", { type: "radio", name: "repStatus", value });
        r.checked = (v.status || "all") === value;
        statusRadios[value] = r;
        const item = el("label", { class: "city-checkbox-item" });
        item.appendChild(r);
        item.appendChild(el("span", {}, text));
        statusBox.appendChild(item);
    }
    const sortSelect = el("select", { class: "search-input", id: "repSort", style: "width:auto;min-width:160px;" });
    for (const [value, text] of Object.entries(REPORTS.SORTS)) {
        sortSelect.appendChild(el("option", { value }, text));
    }
    sortSelect.value = REPORTS.SORTS[v.sort] ? v.sort : REPORTS.SORT_DEFAULT;

    const staffToggle = el("input", { type: "checkbox", id: "repStaffToggle" });
    staffToggle.checked = v.staffEnabled === true;
    const staffSelect = el("select", { class: "search-input", id: "repStaffSelect", style: "width:auto;min-width:200px;" });
    staffSelect.appendChild(el("option", { value: "" }, "— выберите —"));
    for (const s of staff) {
        staffSelect.appendChild(el("option", { value: String(s.id) }, s.name));
    }
    if (v.staffId != null) staffSelect.value = String(v.staffId);
    const staffRow = el("div", { style: canStaffFilter ? "" : "display:none;" });

    // --- кнопки -------------------------------------------------------
    const searchBtn = el("button", { type: "button", class: "menu-item", id: "repSearchBtn" }, "Найти");
    const exportBtn = el("button", { type: "button", class: "menu-item", id: "repExportBtn" }, "Выгрузить CSV");
    const resetBtn = el("button", { type: "button", class: "menu-item", id: "repResetBtn" }, "Сбросить");

    // --- сборка -------------------------------------------------------
    const row1 = el("div", { class: "rep-row", style: "display:flex;gap:14px;flex-wrap:wrap;align-items:flex-end;" });
    const periodCol = el("div", { style: "display:flex;gap:8px;align-items:flex-end;" });
    const fromCol = el("div");
    fromCol.appendChild(label("От"));
    fromCol.appendChild(fromInput);
    const toCol = el("div");
    toCol.appendChild(label("До"));
    toCol.appendChild(toInput);
    periodCol.appendChild(fromCol);
    periodCol.appendChild(toCol);
    const dateTypeCol = el("div", { style: "display:flex;gap:10px;padding-bottom:6px;" });
    for (const [r, text] of [[createdRadio, "по созданию"], [closedRadio, "по закрытию"]]) {
        const item = el("label", { class: "city-checkbox-item" });
        item.appendChild(r);
        item.appendChild(el("span", {}, text));
        dateTypeCol.appendChild(item);
    }
    row1.appendChild(periodCol);
    row1.appendChild(dateTypeCol);
    const cityOnlyCol = el("div", { style: "padding-bottom:6px;" });
    const cityOnlyLabel = el("label", { class: "city-checkbox-item" });
    cityOnlyLabel.appendChild(cityOnlyCb);
    cityOnlyLabel.appendChild(el("span", {}, "Искать только по городу"));
    cityOnlyCol.appendChild(cityOnlyLabel);
    row1.appendChild(cityOnlyCol);
    row1.appendChild(addressWrap);

    const row2 = el("div", { class: "rep-row", style: "display:flex;gap:14px;flex-wrap:wrap;margin-top:10px;" });
    const detailsCol = el("div", { style: "flex:1;min-width:220px;" });
    detailsCol.appendChild(label("Поиск по описанию"));
    detailsCol.appendChild(detailsInput);
    const solutionCol = el("div", { style: "flex:1;min-width:220px;" });
    solutionCol.appendChild(label("Поиск по решению"));
    solutionCol.appendChild(solutionInput);
    row2.appendChild(detailsCol);
    row2.appendChild(solutionCol);

    const row3 = el("div", { class: "rep-row", style: "display:flex;gap:18px;flex-wrap:wrap;margin-top:10px;" });
    const deptCol = el("div", { style: "flex:2;min-width:260px;" });
    deptCol.appendChild(label("Отделы"));
    deptCol.appendChild(deptBox);
    const statusCol = el("div");
    statusCol.appendChild(label("Статус"));
    statusCol.appendChild(statusBox);
    const sortCol = el("div");
    sortCol.appendChild(label("Сортировка"));
    sortCol.appendChild(sortSelect);
    row3.appendChild(deptCol);
    row3.appendChild(statusCol);
    row3.appendChild(sortCol);
    staffRow.appendChild(label("Фильтр по ответственному"));
    const staffLine = el("div", { style: "display:flex;gap:10px;align-items:center;" });
    const staffToggleLabel = el("label", { class: "city-checkbox-item" });
    staffToggleLabel.appendChild(staffToggle);
    staffToggleLabel.appendChild(el("span", {}, "включить"));
    staffLine.appendChild(staffToggleLabel);
    staffLine.appendChild(staffSelect);
    staffRow.appendChild(staffLine);
    row3.appendChild(staffRow);

    const row4 = el("div", {
        class: "rep-row",
        style: "display:flex;gap:10px;flex-wrap:wrap;margin-top:12px;align-items:center;",
    });
    row4.appendChild(searchBtn);
    row4.appendChild(exportBtn);
    row4.appendChild(resetBtn);

    root.appendChild(row1);
    root.appendChild(msgEl);
    root.appendChild(periodEl);
    root.appendChild(row2);
    root.appendChild(row3);
    root.appendChild(row4);

    // --- логика -------------------------------------------------------
    let changeTimer = null;
    const scheduleChange = () => {
        if (changeTimer) clearTimeout(changeTimer);
        changeTimer = setTimeout(() => validate(), 120);
    };

    function refreshTextEnabled() {
        const sel = picker.getValue();
        const ok =
            !cityOnlyCb.checked &&
            !!sel &&
            ((Number(sel.home_id) || 0) > 0 || (Number(sel.object_id) || 0) > 0);
        for (const inp of [detailsInput, solutionInput]) {
            inp.disabled = !ok;
            inp.title = ok ? "" : TEXT_HINT;
        }
    }

    function validate() {
        const from = mskDayStartTs(fromInput.value);
        const to = mskDayEndTs(toInput.value);
        let msg = "";
        if (from === null || to === null) msg = "Укажите даты периода";
        else if (from > to) msg = "Дата «от» не может быть больше даты «до»";
        else if (to > mskDayEndTs(mskTodayYmd())) msg = "Дата «до» не может быть больше сегодняшней";
        else if (to - from > REPORTS.MAX_RANGE_DAYS * 86400)
            msg = `Период не может превышать ${REPORTS.MAX_RANGE_DAYS} дней`;
        msgEl.textContent = msg;
        msgEl.style.display = msg ? "block" : "none";
        fromInput.classList.toggle("rep-invalid", !!msg);
        toInput.classList.toggle("rep-invalid", !!msg);
        periodEl.textContent =
            !msg && from !== null
                ? `Период МСК: ${formatTsMsk(from)} — ${formatTsMsk(to)}`
                : "";
        searchBtn.disabled = !!msg || busy;
        exportBtn.disabled = !!msg || busy;
        return !msg;
    }

    function getPayload() {
        const sel = picker.getValue();
        const useLower = !cityOnlyCb.checked && !!sel;
        return {
            date_from: mskDayStartTs(fromInput.value),
            date_to: mskDayEndTs(toInput.value),
            date_type: closedRadio.checked ? "closed" : "created",
            city_id: sel ? Number(sel.city_id) || null : null,
            street_id: useLower ? Number(sel.street_id) || null : null,
            home_id: useLower ? Number(sel.home_id) || null : null,
            object_id: useLower ? Number(sel.object_id) || null : null,
            city_only: cityOnlyCb.checked,
            department_ids: [...selected],
            status: statusRadios.open.checked ? "open" : statusRadios.close.checked ? "close" : "all",
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
        const sel = picker.getValue();
        return {
            fromYmd: fromInput.value,
            toYmd: toInput.value,
            dateType: closedRadio.checked ? "closed" : "created",
            address: sel,
            cityOnly: cityOnlyCb.checked,
            departmentIds: [...selected],
            status: statusRadios.open.checked ? "open" : statusRadios.close.checked ? "close" : "all",
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
        (next.dateType === "closed" ? closedRadio : createdRadio).checked = true;
        cityOnlyCb.checked = next.cityOnly === true;
        if (next.address) picker.setValue(next.address);
        else picker.reset();
        // null или пустой список = «все отделы»: ноль галочек —
        // невалидное состояние UI (защита последнего отдела), а payload
        // [] на сервере молча означает «условия по отделу нет».
        const depIds =
            Array.isArray(next.departmentIds) && next.departmentIds.length > 0
                ? next.departmentIds.map(String)
                : departments.map((d) => String(d.id));
        for (const dep of departments) {
            const cb = deptBox.querySelector(`input[value="${String(dep.id)}"]`);
            if (cb) cb.checked = depIds.includes(String(dep.id));
        }
        selected.clear();
        for (const id of depIds) selected.add(id);
        (statusRadios[next.status] || statusRadios.all).checked = true;
        staffToggle.checked = next.staffEnabled === true;
        if (next.staffId != null) staffSelect.value = String(next.staffId);
        detailsInput.value = next.detailsText || "";
        solutionInput.value = next.solutionText || "";
        sortSelect.value = REPORTS.SORTS[next.sort] ? next.sort : REPORTS.SORT_DEFAULT;
        refreshTextEnabled();
        validate();
    }

    function setBusy(flag) {
        busy = flag === true;
        exportBtn.textContent = busy ? "Генерация..." : "Выгрузить CSV";
        validate();
    }

    fromInput.addEventListener("change", validate);
    toInput.addEventListener("change", validate);
    cityOnlyCb.addEventListener("change", () => {
        refreshTextEnabled();
        scheduleChange();
    });
    sortSelect.addEventListener("change", scheduleChange);
    searchBtn.addEventListener("click", () => {
        if (validate()) onSubmit(getPayload());
    });
    exportBtn.addEventListener("click", () => {
        if (validate()) onExport(getPayload());
    });
    resetBtn.addEventListener("click", () => onReset());

    refreshTextEnabled();
    validate();

    return {
        element: root,
        getPayload,
        snapshot,
        setValues,
        setBusy,
        validate,
        destroy: () => {
            if (changeTimer) clearTimeout(changeTimer);
            picker.destroy();
        },
    };
}