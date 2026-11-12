import { tableSettings } from "./settings.js";
import { parseAnyDate } from "../utils/date-utils.js";

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

export function sortRows(rows, columnId, isAscending) {
  const col = tableSettings.columns.find((c) => c.id === columnId);
  const type = col ? col.dataType : "string";

  rows.sort((rowA, rowB) => {
    const a = rowA.querySelector(`td[data-col-id="${columnId}"]`);
    const b = rowB.querySelector(`td[data-col-id="${columnId}"]`);
    const va = a ? a.textContent.trim() : "";
    const vb = b ? b.textContent.trim() : "";

    if (type === "number") {
      const na = parseFloat(va || 0),
        nb = parseFloat(vb || 0);
      return isAscending ? na - nb : nb - na;
    }
    if (type === "date") {
      const da = readTsSec(a, va);
      const db = readTsSec(b, vb);
      return isAscending ? da - db : db - da;
    }
    return isAscending
      ? va.localeCompare(vb, "ru")
      : vb.localeCompare(va, "ru");
  });
}
