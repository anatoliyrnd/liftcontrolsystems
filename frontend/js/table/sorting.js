import { tableSettings } from "./settings.js";
import { parseAnyDate } from "../utils/date-utils.js";

/**
 * Один коллатор на модуль: создание Intl.Collator дорогое, а сравнений
 * при сортировке тысяч строк — десятки тысяч.
 *
 * numeric: true — «д. 2» раньше «д. 10», «п.2» раньше «п.10». Без него
 * лексикографика ставила 10 раньше 2, и порядок адресов в таблице не
 * совпадал с порядком на табличке лифта. Параметры совпадают с
 * ADDRESS_COLLATOR в offline-db.js: список адресов и таблица обязаны
 * упорядочиваться одинаково.
 */
const COLLATOR = new Intl.Collator("ru", {
  numeric: true,
  sensitivity: "base",
});

function readTsSec(el, textFallback) {
  if (el) {
    const raw = el.getAttribute("data-ts");
    if (raw != null) {
      const n = Number(raw);
      if (Number.isFinite(n) && n > 0) return n;
    }
  }
  if (textFallback) {
    const d = parseAnyDate(textFallback);
    if (d && !isNaN(d.getTime())) return Math.floor(d.getTime() / 1000);
  }
  return 0;
}

/** «—» и пустая ячейка — отсутствие значения, а не значение. */
function isBlank(s) {
  return s === "" || s === "—";
}

/**
 * Number, а не parseFloat: parseFloat("35 732") обрезал до 35, а
 * parseFloat("offline_1761…") давал NaN. Компаратор с NaN ломает не
 * одну пару, а весь массив — порядок рассыпался целиком.
 * Пробелы-разделители тысяч (включая NBSP и узкий пробел) снимаем.
 */
function toNumber(raw) {
  const s = String(raw)
    .replace(/[\s\u00A0\u202F]/g, "")
    .replace(",", ".");
  if (isBlank(s)) return null;
  const n = Number(s);
  return Number.isFinite(n) ? n : null;
}

export function sortRows(rows, columnId, isAscending) {
  const col = tableSettings.columns.find((c) => c.id === columnId);
  const type = col ? col.dataType : "string";
  const dir = isAscending ? 1 : -1;

  // DOM читается один раз на строку. querySelector внутри компаратора
  // давал O(n log n) обращений к дереву на каждую сортировку.
  const items = rows.map((row) => {
    const cell = row.querySelector(`td[data-col-id="${columnId}"]`);
    const text = cell ? cell.textContent.trim() : "";

    // data-sort-key — чистый ключ от рендерера (адрес: имена без «ул.»/«д.»).
    // Пустой атрибут игнорируем: он обнулил бы порядок хуже, чем текст.
    const attr = cell ? cell.getAttribute("data-sort-key") : null;
    const label = attr != null && attr !== "" ? attr : text;

    let value;
    if (type === "number") {
      value = toNumber(label);
    } else if (type === "date") {
      // data-ts важнее подписи: в ячейке отформатированная дата, а метка точна.
      value = readTsSec(cell, text) || null;
    } else {
      value = isBlank(label) ? null : label;
    }

    return { row, value };
  });

  items.sort((a, b) => {
    // Пустые и нечисловые — в конец при ЛЮБОМ направлении. Офлайн-строки
    // с id «offline_…» попадают сюда же: своя нумерация не сравнивается
    // с серверной, а NaN больше не отравляет компаратор.
    if (a.value === null) return b.value === null ? 0 : 1;
    if (b.value === null) return -1;

    const cmp =
      type === "string"
        ? COLLATOR.compare(a.value, b.value)
        : a.value - b.value;
    return cmp * dir;
  });

  // На месте: вызывающий код держит ссылку на тот же массив.
  for (let i = 0; i < items.length; i++) rows[i] = items[i].row;
}
