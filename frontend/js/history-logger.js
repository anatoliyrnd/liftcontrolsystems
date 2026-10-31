import { UI } from './config.js';

/**
 * Единый системный логгер блока «История».
 * Ограничение количества строк задается в config.js (UI.HISTORY_MAX_LINES).
 */
export function logHistoryAction(text) {
    const container = document.querySelector('.history-list-container');
    if (!container) return;

    const item = document.createElement('div');
    item.className = 'history-item';
    item.textContent = '[' + new Date().toLocaleTimeString() + '] ' + text;
    container.appendChild(item);

    // Удаляем старые записи, если превышен лимит
    while (container.children.length > UI.HISTORY_MAX_LINES) {
        container.removeChild(container.firstChild);
    }
    container.scrollTop = container.scrollHeight;
}