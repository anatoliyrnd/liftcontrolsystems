import { REPORTS } from "../../config.js";
import { formatTsMsk } from "../../utils/date-utils.js";
import { createHoverTip } from "./hover-tip.js";
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
  const hoverTip = createHoverTip({
    minWidth: REPORTS.TOOLTIP_MIN_WIDTH,
    hideDelay: REPORTS.TOOLTIP_HIDE_DELAY_MS,
  });

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
  const selectAllCb = el("input", {
    type: "checkbox",
    id: "repSummaryCityAll",
  });
  selectAllLabel.appendChild(selectAllCb);
  selectAllLabel.appendChild(el("span", {}, "Выбрать все"));
  cityDropdown.appendChild(selectAllLabel);
  cityDropdown.appendChild(el("div", { class: "rep-city-divider" }));
  const cityList = el("div", { id: "repSummaryCityList" });
  cityDropdown.appendChild(cityList);
  cityWrap.appendChild(cityBtn);
  cityWrap.appendChild(cityDropdown);
  cityCol.appendChild(cityWrap);

  const refreshBtn = el(
    "button",
    {
      type: "button",
      class: "theme-toggle-btn rep-refresh-btn",
      id: "repSummaryRefresh",
      title: "Обновить сводку",
    },
    "⟳",
  );

  controls.appendChild(periodCol);
  controls.appendChild(cityCol);
  controls.appendChild(refreshBtn);

  const periodLine = el("div", {
    class: "rep-summary-period",
    id: "repSummaryPeriodLine",
  });
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
  const backdrop = el("div", {
    class: "filter-backdrop",
    id: "repSummaryBackdrop",
  });
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
    box.appendChild(
      el("div", { class: "rep-chart-empty" }, "Нет открытых заявок"),
    );
    return box;
  }

  function donut(title, rows) {
    const total = rows.reduce((s, r) => s + (Number(r.count) || 0), 0);
    if (!total) return emptyChart(title);
    const box = chartBox(title);
    const body = el("div", { class: "rep-donut-body" });
    const R = 42;
    const C = 2 * Math.PI * R;
    const svg = svgEl("svg", {
      viewBox: "0 0 120 120",
      class: "rep-donut",
      width: 132,
      height: 132,
    });
    svg.appendChild(
      svgEl("circle", { cx: 60, cy: 60, r: R, class: "rep-donut-track" }),
    );
    let acc = 0;
    for (const row of rows) {
      const count = Number(row.count) || 0;
      if (!count) continue;
      const len = (count / total) * C;
      const seg = svgEl("circle", {
        cx: 60,
        cy: 60,
        r: R,
        class: `rep-donut-seg rep-level-${row.level}`,
        "stroke-dasharray": `${len} ${C - len}`,
        "stroke-dashoffset": -acc,
        transform: "rotate(-90 60 60)",
      });
      const t = svgEl("title");
      t.textContent = `${row.name}: ${count}`;
      seg.appendChild(t);
      svg.appendChild(seg);
      acc += len;
    }
    const num = svgEl("text", {
      x: 60,
      y: 58,
      class: "rep-donut-num",
      "text-anchor": "middle",
    });
    num.textContent = String(total);
    const cap = svgEl("text", {
      x: 60,
      y: 74,
      class: "rep-donut-cap",
      "text-anchor": "middle",
    });
    cap.textContent = "открыто";
    svg.appendChild(num);
    svg.appendChild(cap);
    body.appendChild(svg);
    const legend = el("div", { class: "rep-legend" });
    for (const row of rows) {
      const item = el("div", { class: "rep-legend-item" });
      item.appendChild(
        el("span", { class: `rep-legend-swatch rep-level-${row.level}` }),
      );
      item.appendChild(el("span", { class: "rep-legend-name" }, row.name));
      item.appendChild(
        el("span", { class: "rep-legend-count" }, String(row.count ?? 0)),
      );
      legend.appendChild(item);
    }
    body.appendChild(legend);
    box.appendChild(body);
    return box;
  }

  function bars(title, rows) {
    if (!Array.isArray(rows) || rows.length === 0) return emptyChart(title);
    const max = Math.max(1, ...rows.map((r) => Number(r.count) || 0));
    const box = chartBox(title);
    for (const row of rows) {
      const line = el("div", { class: "rep-bar-row" });
      const label = el(
        "span",
        { class: "rep-bar-label" },
        String(row.name ?? "—"),
      );
      label.title = String(row.name ?? "—");
      const track = el("div", { class: "rep-bar-track" });
      const fill = el("div", { class: "rep-bar-fill" });
      fill.style.width = `${Math.max(2, ((Number(row.count) || 0) / max) * 100)}%`;
      track.appendChild(fill);
      line.appendChild(label);
      line.appendChild(track);
      line.appendChild(
        el("span", { class: "rep-bar-count" }, String(row.count ?? 0)),
      );
      box.appendChild(line);
    }
    return box;
  }

  /** Содержимое подсказки «Просрочено»: корзины длительности. */
  function overdueTip(data) {
    return () => {
      const wrap = el("div", { class: "rep-tip-body" });
      wrap.appendChild(
        el(
          "div",
          { class: "rep-tip-title" },
          `Просрочено сейчас: ${data.overdue_now ?? 0}`,
        ),
      );
      const buckets = data.overdue_buckets || {};
      for (const { key, label } of REPORTS.OVERDUE_BUCKETS) {
        const row = el("div", { class: "rep-tip-row" });
        row.appendChild(el("span", { class: "rep-tip-name" }, label));
        row.appendChild(
          el("span", { class: "rep-tip-num" }, String(buckets[key] ?? 0)),
        );
        wrap.appendChild(row);
      }
      wrap.appendChild(
        el(
          "div",
          { class: "rep-tip-note" },
          "Открытые заявки со сроком ремонта в прошлом.",
        ),
      );
      return wrap;
    };
  }

  /** Содержимое подсказки по медленным застреваниям: компактный список. */
  function slowTip(data) {
    return () => {
      const s = data.slow_entrapment || {};
      const wrap = el("div", { class: "rep-tip-body" });
      wrap.appendChild(
        el(
          "div",
          { class: "rep-tip-title" },
          `Застревания, закрытые дольше ${s.threshold_minutes ?? 50} мин: ${s.count ?? 0}`,
        ),
      );
      const names = Array.isArray(s.group_names)
        ? s.group_names.join(", ")
        : "";
      if (names) {
        wrap.appendChild(
          el("div", { class: "rep-tip-note" }, `Группы: ${names}`),
        );
      }
      const items = Array.isArray(s.items) ? s.items : [];
      if (items.length === 0) {
        wrap.appendChild(
          el(
            "div",
            { class: "rep-tip-empty" },
            "За выбранный период таких заявок нет.",
          ),
        );
        return wrap;
      }
      const table = el("div", { class: "rep-tip-table" });
      const head = el("div", { class: "rep-tip-tr rep-tip-th" });
      for (const t of ["№", "Адрес", "Создана", "Закрыта", "Мин"]) {
        head.appendChild(el("span", {}, t));
      }
      table.appendChild(head);
      for (const it of items) {
        const row = el("div", { class: "rep-tip-tr" });
        row.appendChild(
          el("span", { class: "rep-tip-id" }, String(it.id ?? "—")),
        );
        const addr = el(
          "span",
          { class: "rep-tip-addr" },
          String(it.address ?? "—"),
        );
        addr.title = String(it.address ?? "—");
        row.appendChild(addr);
        row.appendChild(el("span", {}, formatTsMsk(it.date)));
        row.appendChild(el("span", {}, formatTsMsk(it.close_date)));
        row.appendChild(
          el("span", { class: "rep-tip-num" }, String(it.minutes ?? 0)),
        );
        table.appendChild(row);
      }
      wrap.appendChild(table);
      if (s.truncated) {
        wrap.appendChild(
          el(
            "div",
            { class: "rep-tip-note" },
            `Показаны первые ${items.length} из ${s.count ?? items.length}. Полный список — в расширенном поиске.`,
          ),
        );
      }
      return wrap;
    };
  }

  function kpi(label, value, mod = "", tipBuild = null) {
    const box = el("div", { class: `rep-kpi${mod ? " " + mod : ""}` });
    box.appendChild(el("div", { class: "rep-kpi-value" }, String(value)));
    box.appendChild(el("div", { class: "rep-kpi-label" }, label));
    if (tipBuild) {
      box.classList.add("rep-kpi-has-tip");
      // Клавиатурный доступ: подсказка открывается и по focus.
      box.setAttribute("tabindex", "0");
      box.appendChild(
        el("span", { class: "rep-kpi-info", "aria-hidden": "true" }, "i"),
      );
      hoverTip.attach(box, tipBuild);
    }
    return box;
  }

  // --- рендер -------------------------------------------------------
  function render(data) {
    lastData = data;
    skeleton.style.display = "none";
    updating.style.display = "none";
    content.classList.remove("is-updating");
    // Плитки сейчас будут удалены: снимаем их слушатели и прячем
    // подсказку. Без reset() обработчики копятся на attachAbort до
    // unmount, а окно висит над пустым местом с aria-describedby
    // на detached-узле.
    hoverTip.reset();
    content.innerHTML = "";
    if (!data) {
      periodLine.textContent = "";
      content.appendChild(
        el(
          "div",
          { class: "rep-chart-empty" },
          "Нет данных за выбранный период.",
        ),
      );
      return;
    }
    const p = data.period || {};
    const presetLabel = REPORTS.SUMMARY_PERIODS[p.preset] || "Период";
    // Границы показываем явно: «неделя» = понедельник→сегодня, а не 7 дней.
    periodLine.textContent = p.date_from
      ? `${presetLabel}: ${formatTsMsk(p.date_from)} — ${formatTsMsk(p.date_to)} (МСК)`
      : "";
    const closedLabel =
      p.preset === "today"
        ? "Закрыто сегодня"
        : `Закрыто · ${presetLabel.toLowerCase()}`;
    const createdLabel =
      p.preset === "today"
        ? "Создано сегодня"
        : `Создано · ${presetLabel.toLowerCase()}`;

    const slow = data.slow_entrapment || {};
    const slowMin = slow.threshold_minutes ?? 50;
    const slowLabel =
      p.preset === "today"
        ? `Застревания > ${slowMin} мин сегодня`
        : `Застревания > ${slowMin} мин · ${presetLabel.toLowerCase()}`;

    const kpis = el("div", { class: "rep-kpis" });
    kpis.appendChild(kpi("Открыто сейчас", data.open_now ?? 0));
    kpis.appendChild(
      kpi(
        "Просрочено",
        data.overdue_now ?? 0,
        (data.overdue_now ?? 0) > 0 ? "rep-kpi-danger" : "",
        overdueTip(data),
      ),
    );
    kpis.appendChild(
      kpi(closedLabel, data.closed_period ?? 0, "rep-kpi-success"),
    );
    kpis.appendChild(kpi(createdLabel, data.created_period ?? 0));
    // Периодная метрика: закрытые за период, а не срез «на сейчас».
    kpis.appendChild(
      kpi(
        slowLabel,
        slow.count ?? 0,
        (slow.count ?? 0) > 0 ? "rep-kpi-warning" : "",
        slowTip(data),
      ),
    );
    kpis.appendChild(
      kpi("Среднее закрытие", fmtDuration(data.avg_close_time_seconds)),
    );
    content.appendChild(kpis);

    const charts = el("div", { class: "rep-charts" });
    const levels = Array.isArray(data.open_by_alert_level)
      ? data.open_by_alert_level.map((r) => ({
          level: r.level,
          name: `Уровень ${r.level}`,
          count: r.count,
        }))
      : [];
    charts.appendChild(donut("Открытые по уровням тревоги", levels));
    charts.appendChild(bars("Открытые по отделам", data.open_by_department));
    charts.appendChild(bars("Открытые по городам", data.open_by_city));
    content.appendChild(charts);
  }

  function showSkeleton() {
    skeleton.style.display = "";
    updating.style.display = "none";
    content.classList.remove("is-updating");
    // Скелетон тоже удаляет плитки: подсказку гасим сразу, не дожидаясь
    // render(). Иначе на время запроса она висит над shimmer-блоками.
    hoverTip.reset();
    content.innerHTML = "";
  }
  function setUpdating(flag) {
    if (flag && lastData) {
      updating.style.display = "";
      content.classList.add("is-updating");
    } else {
      updating.style.display = "none";
      content.classList.remove("is-updating");
    }
  }
  function setControlsEnabled(flag) {
    periodSelect.disabled = !flag;
    refreshBtn.disabled = !flag;
    cityBtn.disabled = !flag || cities.length === 0;
    if (!flag) closeDropdown();
  }
  function snapshot() {
    return { summaryPeriod: period, summaryCities: [...selected] };
  }
  /**
   * Уход с вкладки без уничтожения вьюхи. Дропдаун городов и
   * подсказка лежат в document.body и пережили бы display:none
   * родителя — экран остался бы затемнённым.
   */
  function closeOverlays() {
    closeDropdown();
    hoverTip.hide();
  }

  function destroy() {
    abort.abort();
    hoverTip.destroy();
    backdrop.remove();
  }

  syncCityUi();
  showSkeleton();

  return {
    element: root,
    render,
    showSkeleton,
    setUpdating,
    setControlsEnabled,
    closeOverlays,
    snapshot,
    getPeriod: () => period,
    getCityIds: () => [...selected],
    destroy,
  };
}
