import { UI } from "./config.js";

/**
 * Единый системный логгер блока «История».
 * Ограничение количества строк задается в config.js (UI.HISTORY_MAX_LINES).
 *
 * scrollTop обновляется через requestAnimationFrame — если за один кадр
 * произошло несколько logHistoryAction (массовая синхронизация), скролл
 * сработает один раз, а не N. Раньше при 10 событиях за пачку было 10
 * синхронных reflow подряд — заметный jank на слабых машинах.
 */

let _scrollScheduled = false;

export function logHistoryAction(text) {
  const container = document.querySelector(".history-list-container");
  if (!container) return;

  const item = document.createElement("div");
  item.className = "history-item";
  item.textContent = "[" + new Date().toLocaleTimeString() + "] " + text;
  container.appendChild(item);

  // Удаляем старые записи, если превышен лимит
  while (container.children.length > UI.HISTORY_MAX_LINES) {
    container.removeChild(container.firstChild);
  }

  // Скролл — один раз на кадр, а не N раз синхронно.
  // Сами DOM-узлы создаются сразу (без задержки визуально).
  if (!_scrollScheduled) {
    _scrollScheduled = true;
    requestAnimationFrame(() => {
      _scrollScheduled = false;
      // container мог исчезнуть из DOM между rAF и выполнением
      if (container.isConnected) {
        container.scrollTop = container.scrollHeight;
      }
    });
  }
}
