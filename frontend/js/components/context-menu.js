/**
 * Контекстное меню — сервис-механизм.
 *
 * Про заявки не знает ничего: состав пунктов отдаёт провайдер,
 * переданный в init(). Добавить пункт = дописать элемент в массив
 * провайдера, этот файл не трогается.
 *
 * Наблюдатель делегированный, на контейнере таблицы (не на document).
 * Нативное меню браузера на input / textarea / contenteditable / a
 * не глушится — копирование и вставка там должны работать.
 *
 * DOM строго через createElement + textContent (правило 1 архитектуры).
 * Один инстанс на приложение; повторный init перепривязывает контейнер.
 */

const MENU_CLASS = "context-menu";
const ITEM_CLASS = "context-menu-item";
const SEPARATOR_CLASS = "context-menu-separator";
const HEADER_CLASS = "context-menu-header";

/** Теги, где нативное меню остаётся нетронутым. */
const NATIVE_TAGS = new Set(["INPUT", "TEXTAREA", "SELECT", "A"]);

let container = null;
let provider = null;
let menuEl = null;
let items = [];
let focusIndex = -1;
let returnFocusTo = null;
let abortCtrl = null;
let isOpen = false;

function isNativeTarget(target) {
  if (!target) return false;
  if (NATIVE_TAGS.has(target.tagName)) return true;
  return target.isContentEditable === true;
}

function buildMenu(snapshot, contextItems, systemItems) {
  const root = document.createElement("div");
  root.className = MENU_CLASS;
  root.setAttribute("role", "menu");
  root.setAttribute("tabindex", "-1");

  // Снапшот вместо подсветки строки: tbody пересоздаётся поллером
  // и фильтрами, якорь-строка исчезла бы под открытым меню.
  if (snapshot) {
    const header = document.createElement("div");
    header.className = HEADER_CLASS;
    const title = document.createElement("div");
    title.className = "context-menu-title";
    title.textContent = snapshot.title || "";
    header.appendChild(title);
    if (snapshot.subtitle) {
      const sub = document.createElement("div");
      sub.className = "context-menu-subtitle";
      sub.textContent = snapshot.subtitle;
      sub.title = snapshot.subtitle;
      header.appendChild(sub);
    }
    root.appendChild(header);
  }

  const flat = [];

  const appendGroup = (group) => {
    for (const item of group) {
      const btn = document.createElement("button");
      btn.type = "button";
      btn.className = ITEM_CLASS;
      btn.setAttribute("role", "menuitem");
      btn.textContent = item.label;
      if (item.disabled === true) {
        btn.disabled = true;
        btn.setAttribute("aria-disabled", "true");
        if (item.hint) btn.title = item.hint;
      } else if (item.hint) {
        btn.title = item.hint;
      }
      btn.addEventListener("click", (e) => {
        e.stopPropagation();
        if (item.disabled === true) return;
        hide();
        try {
          item.onSelect?.();
        } catch (err) {
          console.error("[ContextMenu] onSelect failed:", err);
        }
      });
      root.appendChild(btn);
      flat.push(btn);
    }
  };

  appendGroup(contextItems);

  // Разделитель только если оба блока непусты — иначе лишняя черта
  // сверху при клике вне строк.
  if (contextItems.length > 0 && systemItems.length > 0) {
    const sep = document.createElement("div");
    sep.className = SEPARATOR_CLASS;
    sep.setAttribute("role", "separator");
    root.appendChild(sep);
  }

  appendGroup(systemItems);

  return { root, flat };
}

function place(x, y) {
  if (!menuEl) return;
  menuEl.style.visibility = "hidden";
  menuEl.style.left = "0px";
  menuEl.style.top = "0px";
  document.body.appendChild(menuEl);

  const rect = menuEl.getBoundingClientRect();
  const pad = 8;
  const maxX = window.innerWidth - rect.width - pad;
  const maxY = window.innerHeight - rect.height - pad;

  menuEl.style.left = `${Math.max(pad, Math.min(x, maxX))}px`;
  menuEl.style.top = `${Math.max(pad, Math.min(y, maxY))}px`;
  menuEl.style.visibility = "visible";
}

function moveFocus(next) {
  if (items.length === 0) return;
  const enabled = items
    .map((el, i) => ({ el, i }))
    .filter(({ el }) => !el.disabled);
  if (enabled.length === 0) return;

  let pos = enabled.findIndex(({ i }) => i === focusIndex);
  if (pos === -1) pos = next > 0 ? -1 : 0;
  pos = (pos + next + enabled.length) % enabled.length;
  focusIndex = enabled[pos].i;
  items[focusIndex].focus();
}

function onKeydown(e) {
  if (!isOpen) return;
  switch (e.key) {
    case "Escape":
      e.preventDefault();
      e.stopPropagation();
      hide();
      break;
    case "ArrowDown":
      e.preventDefault();
      moveFocus(1);
      break;
    case "ArrowUp":
      e.preventDefault();
      moveFocus(-1);
      break;
    case "Home":
      e.preventDefault();
      focusIndex = -1;
      moveFocus(1);
      break;
    case "End":
      e.preventDefault();
      focusIndex = -1;
      moveFocus(-1);
      break;
    case "Tab":
      // Фокус-трап: из меню Tab не уходит.
      e.preventDefault();
      moveFocus(e.shiftKey ? -1 : 1);
      break;
    default:
      break;
  }
}

function bindGlobalListeners() {
  if (abortCtrl) abortCtrl.abort();
  abortCtrl = new AbortController();
  const signal = abortCtrl.signal;

  // capture: у .table-wrapper внутренний скролл, без capture не поймаем.
  window.addEventListener("scroll", () => hide(), { capture: true, signal });
  window.addEventListener("resize", () => hide(), { signal });
  window.addEventListener("blur", () => hide(), { signal });
  document.addEventListener(
    "pointerdown",
    (e) => {
      if (menuEl && !menuEl.contains(e.target)) hide();
    },
    { signal },
  );
  document.addEventListener("keydown", onKeydown, { capture: true, signal });
}

function unbindGlobalListeners() {
  if (abortCtrl) {
    abortCtrl.abort();
    abortCtrl = null;
  }
}

/** Закрыть меню и вернуть фокус на строку-источник. */
export function hide() {
  if (!isOpen) return;
  isOpen = false;
  unbindGlobalListeners();
  if (menuEl) {
    menuEl.remove();
    menuEl = null;
  }
  items = [];
  focusIndex = -1;
  if (returnFocusTo && returnFocusTo.isConnected) {
    try {
      returnFocusTo.focus({ preventScroll: true });
    } catch (e) {
      /* элемент мог быть удалён перерисовкой */
    }
  }
  returnFocusTo = null;
}

/**
 * @param {Object} options
 * @param {HTMLElement} options.container — таблица журнала
 * @param {Function} options.provider — (row) => {snapshot, items, systemItems} | null
 */
export function init({ container: el, provider: fn }) {
  destroy();
  container = el;
  provider = fn;
  if (!container || typeof provider !== "function") return;

  container.addEventListener("contextmenu", onContextMenu);
  container.addEventListener("keydown", onContainerKeydown);
}

function resolveContext(row) {
  let ctx = null;
  try {
    ctx = provider(row);
  } catch (e) {
    console.error("[ContextMenu] provider failed:", e);
    return null;
  }
  if (!ctx) return null;
  const contextItems = Array.isArray(ctx.items) ? ctx.items : [];
  const systemItems = Array.isArray(ctx.systemItems) ? ctx.systemItems : [];
  if (contextItems.length === 0 && systemItems.length === 0) return null;
  return { snapshot: ctx.snapshot || null, contextItems, systemItems };
}

function openAt(row, x, y) {
  const ctx = resolveContext(row);
  if (!ctx) return false;

  hide();
  returnFocusTo = row;

  const built = buildMenu(ctx.snapshot, ctx.contextItems, ctx.systemItems);
  menuEl = built.root;
  items = built.flat;
  isOpen = true;

  place(x, y);
  bindGlobalListeners();

  focusIndex = -1;
  moveFocus(1);
  return true;
}

function onContextMenu(e) {
  if (isNativeTarget(e.target)) return;
  const row = e.target.closest?.("tbody tr");
  if (!row || !container.contains(row)) return;

  // Пустой результат провайдера → нативное меню браузера.
  const opened = openAt(row, e.clientX, e.clientY);
  if (opened) {
    e.preventDefault();
    e.stopPropagation();
  }
}

/** Shift+F10 и клавиша ContextMenu открывают меню на строке с фокусом. */
function onContainerKeydown(e) {
  const isMenuKey = e.key === "ContextMenu" || (e.shiftKey && e.key === "F10");
  if (!isMenuKey) return;
  const row = e.target.closest?.("tbody tr");
  if (!row) return;
  const rect = row.getBoundingClientRect();
  const opened = openAt(
    row,
    rect.left + Math.min(40, rect.width / 2),
    rect.top + rect.height / 2,
  );
  if (opened) e.preventDefault();
}

/** Полная очистка: смена маршрута, teardown приложения. */
export function destroy() {
  hide();
  if (container) {
    container.removeEventListener("contextmenu", onContextMenu);
    container.removeEventListener("keydown", onContainerKeydown);
  }
  container = null;
  provider = null;
}

export const contextMenu = { init, hide, destroy };
