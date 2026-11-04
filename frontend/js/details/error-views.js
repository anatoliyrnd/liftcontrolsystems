/**
 * Экраны ошибок карточки заявки (404 и Network Error).
 *
 * Views не знают про router и api — получают колбэки.
 * Это позволяет переиспользовать их в других контроллерах и упрощает тесты.
 */
import { escapeHtml } from "../utils/escape-html.js";

/**
 * Экран 404 — заявка не существует.
 * @param {HTMLElement} container
 * @param {string|number} ticketId
 * @param {Object} handlers
 * @param {Function} handlers.onBack
 */
export function render404(container, ticketId, { onBack }) {
  container.innerHTML = `
    <div class="error-card" style="padding: 2rem; text-align: center; background: var(--bg-secondary); border: 2px solid var(--border-color); border-radius: 12px; max-width: 500px; margin: 2rem auto;">
      <h2 style="color: #ef4444;">Инцидент №${escapeHtml(ticketId)} не найден</h2>
      <p style="color: var(--text-secondary); margin: 1rem 0;">Возможно, заявка удалена или введён неверный номер.</p>
      <button class="menu-item active" id="backToTableBtn" style="border: none; padding: 8px 16px; border-radius: 8px; cursor: pointer;">Вернуться в журнал</button>
    </div>`;

  const btn = document.getElementById("backToTableBtn");
  if (btn) btn.onclick = onBack;
}

/**
 * Экран «сбой сети» — отличается от 404 (заявка не существует).
 * Показывает кнопки «Повторить» и «Вернуться в журнал».
 * @param {HTMLElement} container
 * @param {string|number} ticketId
 * @param {Object} handlers
 * @param {Function} handlers.onRetry
 * @param {Function} handlers.onBack
 */
export function renderNetworkError(container, ticketId, { onRetry, onBack }) {
  container.innerHTML = `
    <div class="error-card" style="padding: 2rem; text-align: center; background: var(--bg-secondary); border: 2px solid #f59e0b; border-radius: 12px; max-width: 500px; margin: 2rem auto;">
      <h2 style="color: #d97706;">Не удалось загрузить заявку №${escapeHtml(ticketId)}</h2>
      <p style="color: var(--text-secondary); margin: 1rem 0;">Сбой сети или сервер недоступен. Проверьте соединение и попробуйте снова.</p>
      <div style="display: flex; gap: 8px; justify-content: center;">
        <button class="menu-item active" id="retryTicketBtn" style="border: none; padding: 8px 16px; border-radius: 8px; cursor: pointer;">Повторить</button>
        <button class="menu-item" id="backToTableBtnNetErr" style="border: 1px solid var(--border-color); background: var(--bg-primary); color: var(--text-primary); padding: 8px 16px; border-radius: 8px; cursor: pointer;">Вернуться в журнал</button>
      </div>
    </div>`;

  const retryBtn = document.getElementById("retryTicketBtn");
  if (retryBtn) retryBtn.onclick = onRetry;

  const backBtn = document.getElementById("backToTableBtnNetErr");
  if (backBtn) backBtn.onclick = onBack;
}
