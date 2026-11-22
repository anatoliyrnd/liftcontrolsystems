import { REPORTS } from "../config.js";
import { formatTsMsk } from "../utils/date-utils.js";

/**
 * Печатный документ — третье окно, без бандла приложения.
 * DOM только createElement + textContent (правило 1).
 * CSS — статический текст, ноль каскада style.css.
 * Ширины — colgroup + table-layout: fixed, сумма 100%.
 * Даты — МСК, как CSV; экранные formatTs не используются.
 */

const DASH = "—";

function el(doc, tag, attrs = {}, text = null) {
  const node = doc.createElement(tag);
  for (const [k, v] of Object.entries(attrs)) {
    if (k === "class") node.className = v;
    else node.setAttribute(k, v);
  }
  if (text != null) node.textContent = text;
  return node;
}

function orDash(v) {
  const s = v == null ? "" : String(v).trim();
  return s === "" ? DASH : s;
}

function tsMsk(v) {
  const n = Number(v);
  return Number.isFinite(n) && n > 0 ? formatTsMsk(n) : DASH;
}

function isOverdue(item, nowSec) {
  return (
    item.type === "open" &&
    Number(item.repair_time) > 0 &&
    Number(item.repair_time) < nowSec
  );
}

function channelText(status) {
  const n = Number(status);
  if (!(n > 0)) return "не уведомлен";
  return REPORTS.NOTIFY_SUFFIXES[n] ?? `канал ${n}`;
}

/** Одна строка слота: маркер, имя, канал, дата. Пустой слот — ничего. */
function respLine(doc, item, slot) {
  const suffix = slot === 1 ? "" : String(slot);
  const id = Number(item[`staff_id${suffix}`] ?? 0);
  const name = String(item[`staff_name${suffix}`] ?? "").trim();
  if (!(id > 0) || name === "") return null;
  const date = Number(item[`notify_date${suffix}`] ?? 0);
  const tail =
    date > 0
      ? `${channelText(item[`notify_status${suffix}`])}, ${formatTsMsk(date)}`
      : channelText(item[`notify_status${suffix}`]);
  return el(doc, "div", { class: "rep-print-resp" }, `• ${name} — ${tail}`);
}

function headCell(doc, item, nowSec) {
  const td = el(doc, "td");
  td.appendChild(
    el(doc, "div", {}, `№ ${item.call_number ?? item.id ?? DASH}`),
  );
  td.appendChild(el(doc, "div", {}, tsMsk(item.date)));
  td.appendChild(el(doc, "div", {}, orDash(item.created_by)));
  const repair =
    Number(item.repair_time) > 0 ? tsMsk(item.repair_time) : "не задан";
  const line = el(doc, "div", {}, `Срок: ${repair}`);
  if (isOverdue(item, nowSec)) {
    const strong = el(doc, "strong", {}, line.textContent);
    line.textContent = "";
    line.appendChild(strong);
  }
  td.appendChild(line);
  return td;
}

function respCell(doc, item) {
  const td = el(doc, "td");
  for (const slot of [1, 2, 3]) {
    const line = respLine(doc, item, slot);
    if (line) td.appendChild(line);
  }
  if (!td.childNodes.length) td.textContent = DASH;
  return td;
}

function classCell(doc, item) {
  const td = el(doc, "td");
  td.appendChild(el(doc, "div", {}, `Отдел: ${orDash(item.department)}`));
  td.appendChild(el(doc, "div", {}, `Группа: ${orDash(item.group)}`));
  td.appendChild(el(doc, "div", {}, `Тип: ${orDash(item.request)}`));
  return td;
}

function closeCell(doc, item) {
  const td = el(doc, "td");
  if (item.type !== "close") {
    td.textContent = DASH;
    return td;
  }
  td.appendChild(el(doc, "div", {}, tsMsk(item.close_date)));
  td.appendChild(el(doc, "div", {}, orDash(item.close_name)));
  return td;
}

function printCss(sheet, marginMm, scale) {
  const cols = REPORTS.PRINT_COLUMNS.map((c) => `  ${c.mm * scale}mm`).join(
    ",\n",
  );
  return `
@page { size: ${sheet.widthMm}mm ${sheet.heightMm}mm; margin: ${marginMm}mm; }
* { box-sizing: border-box; }
body { margin: 0; font: 8pt/1.25 Arial, sans-serif; color: #000; background: #fff; }
.rep-print-toolbar { position: sticky; top: 0; display: flex; gap: 8px; align-items: center; padding: 8px; background: #eee; border-bottom: 1px solid #999; }
.rep-print-toolbar button { font: 10pt Arial; padding: 4px 12px; }
.rep-print-warn { padding: 8px; background: #fff3cd; border-bottom: 1px solid #999; font: 10pt Arial; }
.rep-print-meta { padding: 6px 0; font: 9pt Arial; }
.rep-print-meta div { margin: 2px 0; }
table { width: 100%; table-layout: fixed; border-collapse: collapse; }
colgroup col { width: auto; }
thead { display: table-header-group; }
th, td { border: 0.3pt solid #000; padding: 1mm; vertical-align: top; overflow-wrap: anywhere; }
th { font-weight: bold; text-align: left; background: #fff; }
tr { break-inside: avoid; }
td div { margin: 0; }
.rep-print-resp { margin: 0 0 1mm; }
@media print {
  .rep-print-toolbar, .rep-print-warn { display: none !important; }
}
`;
}

/**
 * Заполняет уже открытое окно. Вызывается после fetch.
 * win.open делает контроллер синхронно в клике.
 */
export function renderPrintDocument(win, { rows, meta = {}, sheetId }) {
  const doc = win.document;
  const sheet =
    REPORTS.PRINT_SHEETS[sheetId] ??
    REPORTS.PRINT_SHEETS[REPORTS.PRINT_SHEET_DEFAULT];
  const margin = REPORTS.PRINT_MARGIN_MM;
  const totalMm = REPORTS.PRINT_COLUMNS.reduce((s, c) => s + c.mm, 0);
  const usable = sheet.widthMm - margin * 2;
  const scale = usable / totalMm;
  const nowSec = Math.floor(Date.now() / 1000);

  doc.open();
  doc.write(
    "<!doctype html><html lang='ru'><head><meta charset='utf-8'><title>Отчёт</title></head><body></body></html>",
  );
  doc.close();

  const style = el(doc, "style");
  style.textContent = printCss(sheet, margin, scale);
  doc.head.appendChild(style);

  const toolbar = el(doc, "div", { class: "rep-print-toolbar" });
  const printBtn = el(
    doc,
    "button",
    { type: "button" },
    "Печать / Сохранить как PDF",
  );
  toolbar.appendChild(printBtn);
  toolbar.appendChild(
    el(doc, "span", {}, `${sheet.label} · строк: ${rows.length}`),
  );
  doc.body.appendChild(toolbar);

  if (rows.length > REPORTS.PRINT_WARN_ROWS) {
    doc.body.appendChild(
      el(
        doc,
        "div",
        { class: "rep-print-warn" },
        `В отчёте ${rows.length} строк — это примерно ${Math.ceil(rows.length / 10)} страниц. Нажмите «Печать», когда будете готовы.`,
      ),
    );
  }

  const metaBox = el(doc, "div", { class: "rep-print-meta" });
  for (const key of ["tenant", "period", "filters", "generated"]) {
    if (meta[key]) metaBox.appendChild(el(doc, "div", {}, String(meta[key])));
  }
  doc.body.appendChild(metaBox);

  const table = el(doc, "table");
  const colgroup = el(doc, "colgroup");
  for (const c of REPORTS.PRINT_COLUMNS) {
    colgroup.appendChild(
      el(doc, "col", { style: `width:${(c.mm * scale).toFixed(2)}mm` }),
    );
  }
  table.appendChild(colgroup);

  const thead = el(doc, "thead");
  const hr = el(doc, "tr");
  for (const c of REPORTS.PRINT_COLUMNS)
    hr.appendChild(el(doc, "th", {}, c.title));
  thead.appendChild(hr);
  table.appendChild(thead);

  const tbody = el(doc, "tbody");
  for (const item of rows) {
    const tr = el(doc, "tr");
    tr.appendChild(headCell(doc, item, nowSec));
    tr.appendChild(el(doc, "td", {}, orDash(item.fullAddress)));
    tr.appendChild(el(doc, "td", {}, orDash(item.details)));
    tr.appendChild(respCell(doc, item));
    tr.appendChild(closeCell(doc, item));
    tr.appendChild(el(doc, "td", {}, orDash(item.solution)));
    tr.appendChild(classCell(doc, item));
    tbody.appendChild(tr);
  }
  table.appendChild(tbody);
  doc.body.appendChild(table);

  const doPrint = () => {
    if (!win.closed) win.print();
  };
  printBtn.addEventListener("click", doPrint);

  // Не сразу после document.close(): Chrome печатает до layout.
  const ready = doc.fonts?.ready ?? Promise.resolve();
  ready.then(() => {
    win.requestAnimationFrame(() => {
      win.requestAnimationFrame(() => {
        if (rows.length <= REPORTS.PRINT_WARN_ROWS) doPrint();
      });
    });
  });
}
