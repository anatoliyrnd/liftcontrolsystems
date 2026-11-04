import { applyPendingOverlay } from "./pending-overlay.js";

/**
 * Инкапсуляция состояния карточки заявки.
 * Заменяет разрозненные this.ticket, this.pendingChanges, this.mode в контроллере.
 */
export class DetailsState {
  constructor() {
    this.serverTicket = null; // Оригинальный тикет с сервера
    this.pendingCommands = []; // Команды из outbox
    this.draft = {}; // Несохраненные изменения пользователя (бывший pendingChanges)
    this.mode = "view"; // 'view' | 'edit' | 'close'
  }

  setServerTicket(ticket, pendingCommands = []) {
    this.serverTicket = ticket;
    this.pendingCommands = pendingCommands;
    this.draft = {};
    this.mode = "view";
  }

  setPendingCommands(commands) {
    this.pendingCommands = commands;
  }

  setMode(mode) {
    this.mode = mode;
  }

  updateDraft(key, value) {
    this.draft[key] = value;
  }

  deleteDraft(key) {
    delete this.draft[key];
  }

  clearDraft() {
    this.draft = {};
  }

  hasDraftChanges() {
    return Object.keys(this.draft).length > 0;
  }

  /**
   * Селектор: собирает финальный тикет для рендера.
   * 1. Берет серверный тикет.
   * 2. Накладывает офлайн-оверлей.
   * 3. Накладывает черновик (draft) сверху.
   */
  getDisplayTicket(staffList) {
    if (!this.serverTicket) return null;

    // 1. Накладываем outbox
    let display = applyPendingOverlay(
      this.serverTicket,
      this.pendingCommands,
      staffList,
    );

    // 2. Накладываем незаконченный draft (если мы в режиме редактирования)
    if (this.hasDraftChanges()) {
      display = { ...display, ...this.draft };
    }

    return display;
  }
}
