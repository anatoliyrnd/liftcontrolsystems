import { tableSettings, setWidth } from "./settings.js";

/**
 * Изменение ширины колонки мышью с учётом minWidth.
 * 3.2/3.3: ширина хранится per-user/per-scope и только локально.
 * Глобальный ключ tableColumnWidths больше не используется.
 */
export function setupResizableColumn(th, resizer) {
  let startX, startWidth;
  let cachedCells = null;
  let cachedAddressCells = null;

  const colId = th.getAttribute("data-id");
  const colConfig = tableSettings.columns.find((c) => c.id === colId);
  const minAllowedWidth = colConfig ? colConfig.minWidth : 90;

  const table = th.closest("table");
  const scope =
    table?.getAttribute("data-scope") ||
    table?.getAttribute("data-mode") ||
    tableSettings.scope;

  function onMouseMove(e) {
    const width = startWidth + (e.clientX - startX);
    if (width >= minAllowedWidth) {
      const widthPx = `${width}px`;
      th.style.width = widthPx;
      th.style.maxWidth = widthPx;

      const cells =
        cachedCells ||
        th
          .closest("table")
          ?.querySelectorAll(`tbody td[data-col-id="${colId}"]`);
      if (cells) {
        cells.forEach((td) => {
          td.style.width = widthPx;
          td.style.maxWidth = widthPx;
        });
      }

      if (colId === "id") {
        const addrCells =
          cachedAddressCells ||
          th
            .closest("table")
            ?.querySelectorAll(
              `th[data-id="address"], td[data-col-id="address"]`,
            );
        if (addrCells) {
          addrCells.forEach((el) => {
            el.style.left = widthPx;
          });
        }
      }

      if (colConfig) colConfig.width = widthPx;
    }
  }

  function onMouseUp() {
    if (!resizer.classList.contains("resizing")) return;

    // 3.3: сохраняем ширину в per-user кэш своего scope.
    if (colConfig && colConfig.width) {
      setWidth(scope, colId, parseInt(colConfig.width, 10));
    }

    resizer.classList.remove("resizing");
    document.removeEventListener("mousemove", onMouseMove);
    document.removeEventListener("mouseup", onMouseUp);
    window.removeEventListener("blur", onMouseUp);
    document.removeEventListener("visibilitychange", onVisibilityChange);

    cachedCells = null;
    cachedAddressCells = null;
  }

  function onVisibilityChange() {
    if (document.visibilityState === "hidden") onMouseUp();
  }

  resizer.addEventListener("mousedown", (e) => {
    e.stopPropagation();
    e.preventDefault();
    resizer.classList.add("resizing");
    startX = e.clientX;
    startWidth = th.offsetWidth;

    const tbl = th.closest("table");
    if (tbl) {
      cachedCells = tbl.querySelectorAll(`tbody td[data-col-id="${colId}"]`);
      cachedAddressCells =
        colId === "id"
          ? tbl.querySelectorAll(
              `th[data-id="address"], td[data-col-id="address"]`,
            )
          : null;
    }

    document.addEventListener("mousemove", onMouseMove);
    document.addEventListener("mouseup", onMouseUp);
    window.addEventListener("blur", onMouseUp);
    document.addEventListener("visibilitychange", onVisibilityChange);
  });
}
