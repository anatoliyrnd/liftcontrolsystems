import { REPORTS } from "../../config.js";
import { formatTsMsk } from "../../utils/date-utils.js";

/**
 * Вкладка «Сводка»: пресет периода + города + KPI + SVG-графики.
 * Без таблицы и без полнотекста — всё это в расширенном поиске.
 *
 * Графики — SVG руками, без библиотеки: 6–8 категорий не оправдывают
 * +70 КБ в precache. Цвета через CSS-переменные, поэтому смена темы
 * не требует перерисовки.
 *
 * Скелетон — только первая загрузка и смена пресета. Клик по городу
 * сохраняет прошлые данные и гасит их мягким индикатором (§16.5).
 *
 * Города — журнальная семантика: ноль = «Все», последнюю снять можно.
 * Отделы в расширенном поиске живут по другому правилу (минимум один).
 */
const SVG_NS = "http://www.w3.org/2000/svg";

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
function svgEl(tag, attrs = {}) {
    const node = document.createElementNS(SVG_NS, tag);
    for (const [k, v] of Object.entries(attrs)) node.setAttribute(k, String(v));
    return node;
}
const isKnownPeriod = (p) =>
    Object.prototype.hasOwnProperty.call(REPORTS.SUMMARY_PERIODS, p);

function fmtDuration(sec) {
    if (sec == null || !Number.isFinite(Number(sec))) return "—";
    const total = Math.round(Number(sec));
    const h = Math.floor(total / 3600);
    const m = Math.floor((total % 3600) / 60);
    return h > 0 ? `${h} ч ${m} мин` : `${m} мин`;
}

export function createSummaryView(opts) {
    const {
        cities = [],
        initialPeriod = REPORTS.SUMMARY_PERIOD_DEFAULT,
        initialCities = null,
        onPeriodChange,
        onCitiesChange,
        onRefresh,
    } = opts;

    const root = el("div", { class: "rep-summary" });
    let period = isKnownPeriod(initialPeriod)
        ? initialPeriod
        : REPORTS.SUMMARY_PERIOD_DEFAULT;
    // null = ключ не сохранён → все города; [] = «Все» (журнальная семантика).
    let selected = new Set(
        Array.isArray(initialCities)
            ? initialCities.map(Number)
            : cities.map((c) => Number(c.id)),
    );
    let lastData = null;

    // --- контролы -----------------------------------------------------
    const controls = el("div", { class: "rep-summary-controls" });
    const periodCol = el("div");
    periodCol.appendChild(el("label", { class: "rep-label" }, "Период"));
    const periodSelect = el("select", {
        class: "search-input",
        id: "repSummaryPeriod",
        style: "width:auto;min-width:190px;",
    });
    for (const [value, text] of Object.entries(REPORTS.SUMMARY_PERIODS)) {
        periodSelect.appendChild(el("option", { value }, text));
    }
    periodSelect.value = period;
    periodCol.appendChild(periodSelect);

    const cityCol = el("div");
    cityCol.appendChild(el("label", { class: "rep-label" }, "Города"));
    const cityWrap = el("div", { class: "rep-city-wrap" });
    const cityBtn = el("button", {
        type: "button",
        class: "theme-toggle-btn rep-city-btn",
        id: "repSummaryCityBtn",
    });
    const cityBtnText = el("span", { id: "repSummaryCityText" }, "Города: Все");
    cityBtn.appendChild(cityBtnText);
    const cityDropdown = el("div", {
        class: "rep-city-dropdown",
        id: "repSummaryCityDropdown",
    });
    const selectAllLabel = el("label", { class: "city-checkbox-item" });
    const selectAllCb = el("input", { type: "checkbox", id: "repSummaryCityAll" });
    selectAllLabel.appendChild(selectAllCb);
    selectAllLabel.appendChild(el("span", {}, "Выбрать все"));
    cityDropdown.appendChild(selectAllLabel);
    cityDropdown.appendChild(el("div", { class: "rep-city-divider" }));
    const cityList = el("div", { id: "repSummaryCityList" });
    cityDropdown.appendChild(cityList);
    cityWrap.appendChild(cityBtn);
    cityWrap.appendChild(cityDropdown);
    cityCol.appendChild(cityWrap);

    const refreshBtn = el("button", {
        type: "button",
        class: "theme-toggle-btn rep-refresh-btn",
        id: "repSummaryRefresh",
        title: "Обновить сводку",
    }, "⟳");

    controls.appendChild(periodCol);
    controls.appendChild(cityCol);
    controls.appendChild(refreshBtn);

    const periodLine = el("div", { class: "rep-summary-period", id: "repSummaryPeriodLine" });
    const updating = el("div", { class: "rep-updating" }, "Обновление…");
    const content = el("div", { class: "rep-summary-content" });
    const skeleton = el("div", { class: "rep-skeleton" });
    for (let i = 0; i < 4; i++) {
        skeleton.appendChild(el("div", { class: "rep-skel rep-skel-kpi" }));
    }
    skeleton.appendChild(el("div", { class: "rep-skel rep-skel-chart" }));
    skeleton.appendChild(el("div", { class: "rep-skel rep-skel-chart" }));

    root.appendChild(controls);
    root.appendChild(periodLine);
    root.appendChild(updating);
    root.appendChild(skeleton);
    root.appendChild(content);

    // --- подложка дропдауна -------------------------------------------
    const backdrop = el("div", { class: "filter-backdrop", id: "repSummaryBackdrop" });
    document.body.appendChild(backdrop);
    const closeDropdown = () => {
        cityDropdown.style.display = "none";
        backdrop.style.display = "none";
    };
    backdrop.addEventListener("click", closeDropdown);
    const abort = new AbortController();
    document.addEventListener(
        "click",
        (e) => {
            if (!cityWrap.contains(e.target)) closeDropdown();
        },
        { signal: abort.signal },
    );
    document.addEventListener(
        "keydown",
        (e) => {
            if (e.key === "Escape") closeDropdown();
        },
        { signal: abort.signal },
    );
    cityBtn.addEventListener("click", (e) => {
        e.stopPropagation();
        const hidden = cityDropdown.style.display !== "block";
        cityDropdown.style.display = hidden ? "block" : "none";
        backdrop.style.display = hidden ? "block" : "none";
    });

    // --- города -------------------------------------------------------
    const cityCheckboxes = new Map();
    for (const city of cities) {
        const label = el("label", { class: "city-checkbox-item" });
        const cb = el("input", { type: "checkbox", value: String(city.id) });
        cb.checked = selected.has(Number(city.id));
        cityCheckboxes.set(Number(city.id), cb);
        cb.addEventListener("change", () => {
            if (cb.checked) selected.add(Number(city.id));
            else selected.delete(Number(city.id));
            syncCityUi();
            onCitiesChange();
        });
        label.appendChild(cb);
        label.appendChild(el("span", {}, city.display || city.name));
        cityList.appendChild(label);
    }
    selectAllCb.addEventListener("change", () => {
        selected = selectAllCb.checked
            ? new Set(cities.map((c) => Number(c.id)))
            : new Set();
        for (const [id, cb] of cityCheckboxes) cb.checked = selected.has(id);
        syncCityUi();
        onCitiesChange();
    });

    function syncCityUi() {
        const total = cities.length;
        const n = selected.size;
        if (total === 0) {
            cityBtnText.textContent = "Города: нет данных";
            cityBtn.classList.remove("filter-active");
            selectAllCb.checked = false;
            selectAllCb.indeterminate = false;
            selectAllCb.disabled = true;
            cityBtn.disabled = true;
            return;
        }
        selectAllCb.disabled = false;
        cityBtn.disabled = false;
        if (n === 0 || n === total) {
            cityBtnText.textContent = "Города: Все";
            cityBtn.classList.remove("filter-active");
            selectAllCb.checked = n === total;
            selectAllCb.indeterminate = false;
        } else {
            cityBtnText.textContent = `Города: ${n} из ${total}`;
            cityBtn.classList.add("filter-active");
            selectAllCb.checked = false;
            selectAllCb.indeterminate = true;
        }
    }

    periodSelect.addEventListener("change", () => {
        period = isKnownPeriod(periodSelect.value)
            ? periodSelect.value
            : REPORTS.SUMMARY_PERIOD_DEFAULT;
        onPeriodChange();
    });
    refreshBtn.addEventListener("click", () => onRefresh());

    // --- графики ------------------------------------------------------
    function chartBox(title) {
        const box = el("div", { class: "rep-chart" });
        box.appendChild(el("div", { class: "rep-chart-title" }, title));
        return box;
    }
    function emptyChart(title) {
        const box = chartBox(title);
        box.appendChild(el("div", { class: "rep-chart-empty" }, "Нет открытых заявок"));
        return box;
    }

    function donut(title, rows) {
        const total = rows.reduce((s, r) => s + (Number(r.count) || 0), 0);
        if (!total) return emptyChart(title);
        const box = chartBox(title);
        const body = el("div", { class: "rep-donut-body" });
        const R = 42;
        const C = 2 * Math.PI * R;
        const svg = svgEl("svg", { viewBox: "0 0 120 120", class: "rep-donut", width: 132, height: 132 });
        svg.appendChild(svgEl("circle", { cx: 60, cy: 60, r: R, class: "rep-donut-track" }));
        let acc = 0;
        for (const row of rows) {
            const count = Number(row.count) || 0;
            if (!count) continue;
            const len = (count / total) * C;
            const seg = svgEl("circle", {
                cx: 60, cy: 60, r: R,
                class: `rep-donut-seg rep-level-${row.level}`,
                "stroke-dasharray": `${len}