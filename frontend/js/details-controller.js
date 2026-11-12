import { staffStore } from "./staff-store.js";
import { userStore } from "./user-store.js";
import { logHistoryAction } from "./history-logger.js";
import { renderCardLayout } from "./details/views/card-layout.js";
import { destroyVoiceInput } from "./components/voiceInput.js";
import { notify } from "./components/notify.js";
import { UI } from "./config.js";
import { appState } from "./app-state.js";
import { authStore } from "./auth-store.js";
import { outboxQueue } from "./outbox-queue.js";
import { compressPhoto } from "./utils/photo-compressor.js";
import { normalizeTicketFields } from "./details/ticket-normalizer.js";
import { nowTs } from "./utils/date-utils.js";
import { render404, renderNetworkError } from "./details/error-views.js";
import { ticketRepository } from "./details/ticket-repository.js";
import { DetailsState } from "./details/details-state.js";
import { renderStaffSlots } from "./details/views/staff-slots-view.js";
import {
  renderNotesList,
  createNotesComposer,
} from "./details/views/notes-view.js";
import { createEditForm } from "./details/views/edit-form.js";
import { createCloseForm } from "./details/views/close-form.js";

const AUTO_RETURN_MS = UI.AUTO_RETURN_MS;
const ERROR_UNLOCK_MS = UI.ERROR_UNLOCK_MS;

export class DetailsController {
   constructor(apiInstance, routerInstance) {
    this.api = apiInstance;
    this.router = routerInstance;
    this.notesComposer = null;
    this.currentTicketId = null;
    this.autoReturnTimer = null;
    this.state = new DetailsState();
    this._staffChangedInSession = false;
    this._autoOpenPending = false;
    this.closeForm = null;
    this.editForm = null;
    this.staffSlotsView = null;
    this._mountId = 0;
    this._sourceArray = null;
    this._sourceIdx = -1;
    this._isRefreshing = false;

    // Один слушатель на время жизни приложения (контроллер — синглтон).
    // Проверка текущей заявки внутри делает его no-op вне карточки.
    this._onTicketCreated = this._onTicketCreated.bind(this);
    window.addEventListener("sync:ticket_created", this._onTicketCreated);
  }

  /**
   * Офлайн-заявка синхронизирована: offline_uuid больше не резолвится,
   * переводим открытую карточку на серверный номер.
   * В режиме правки не дёргаем — предложили открыть из журнала.
   */
  _onTicketCreated(e) {
    const { offline_uuid: offlineUuid, ticket_id: serverId } = e.detail || {};
    if (!offlineUuid || serverId == null) return;

    const t = this.ticket;
    if (!t || !t.isOffline) return;
    if (String(t.offline_uuid || t.id) !== String(offlineUuid)) return;

    if (this.state.mode !== "view") {
      notify.info(
        `Заявка синхронизирована: №${serverId}. Завершите редактирование и откройте её из журнала.`,
        { once: true },
      );
      return;
    }

    logHistoryAction(`Офлайн-заявка синхронизирована: №${serverId}.`);
    this.router.navigate("#/ticket/" + serverId);
  }

  /** Полный teardown — вызывается из main.js при выгрузке приложения. */
  destroy() {
    this.unmount();
    window.removeEventListener("sync:ticket_created", this._onTicketCreated);
  }

  get ticket() {
    return this.state.getDisplayTicket(staffStore.list);
  }

  async mount(ticketId, combinedTicketsArray = []) {
    const myMountId = ++this._mountId;
    const isStale = () => this._mountId !== myMountId;

    this.currentTicketId = ticketId;
    this.state.clearDraft();
    this.state.setMode("view");

    const container = document.getElementById("ticketDetailsDynamicContainer");
    if (!container) return;

    const isOfflineId = String(ticketId).startsWith("offline_");
    const listTicket = isOfflineId
      ? null
      : combinedTicketsArray.find((t) => String(t.id) === String(ticketId));

    // 1.9: закрытая заявка всегда через fetchById — в списке close нет
    // note / full_history, доверять ему нельзя.
    let ticket = listTicket && listTicket.type === "close" ? null : listTicket;

    if (!ticket) {
      const result = await ticketRepository.fetchById(this.api, ticketId);
      if (isStale() || this.currentTicketId !== ticketId) return;

      if (!result.ok) {
        // Офлайн / сбой сети, но объект из списка есть — показываем его,
        // а не экран ошибки. Данные лучше неполные, чем никаких.
        if (result.errorType === "network" && listTicket) {
          ticket = listTicket;
          notify.warning(
            "Нет связи с сервером. Показана сохранённая версия заявки.",
            { once: true },
          );
        } else if (result.errorType === "not_found") {
          render404(container, ticketId, {
            onBack: () => this.router.navigate("#/"),
          });
          return;
        } else if (result.errorType === "network") {
          renderNetworkError(container, ticketId, {
            onRetry: () => this.mount(ticketId, combinedTicketsArray),
            onBack: () => this.router.navigate("#/"),
          });
          return;
        }
        return; // aborted
      } else {
        ticket = result.data;
      }
    }

    const normalizedTicket = normalizeTicketFields({
      ...ticket,
      note: Array.isArray(ticket.note)
        ? [...ticket.note]
        : ticket.note && typeof ticket.note === "object"
          ? { ...ticket.note }
          : ticket.note,
    });

    this._sourceArray =
      combinedTicketsArray.length > 0 ? combinedTicketsArray : null;
    this._sourceIdx = this._sourceArray
      ? this._sourceArray.findIndex((t) => String(t.id) === String(ticketId))
      : -1;

    const cmds = await outboxQueue.getPendingByTicket(ticketId);
    if (isStale() || this.currentTicketId !== ticketId) return;

    this.state.setServerTicket(normalizedTicket, cmds);
    this._renderCard(container);
  }

  /**
   * Перечитывание состояния после офлайн-операции.
   * Для offline_ заявки правки свёрнуты в CreateTicket.payload —
   * getPendingByTicket пуст, поэтому читаем свежий payload из offlineDB.
   * Для серверной заявки обновляем только pendingCommands.
   */
  async _refreshOfflineState(ticketId) {
    if (!this.ticket || String(this.ticket.id) !== String(ticketId)) return;

    const isOffline = String(ticketId).startsWith("offline_");
    const cmds = await outboxQueue.getPendingByTicket(ticketId);
    if (!this.ticket || String(this.ticket.id) !== String(ticketId)) return;

    if (isOffline) {
      const fresh = await ticketRepository.fetchById(this.api, ticketId);
      if (!this.ticket || String(this.ticket.id) !== String(ticketId)) return;
      if (fresh.ok) {
        normalizeTicketFields(fresh.data);
        this.state.setServerTicket(fresh.data, cmds);
      } else {
        this.state.setPendingCommands(cmds);
      }
    } else {
      this.state.setPendingCommands(cmds);
    }
  }

  /**
   * Полное перечитывание карточки (кнопка «Обновить», после save/close).
   * Генерация _mountId отсекает результат, если пользователь ушёл.
   * Для офлайн-заявки чтение идёт из offlineDB, сети нет.
   */
  async _refreshTicketAfterSave(showSuccess = false) {
    if (!this.ticket || this._isRefreshing) return;

    const myMountId = this._mountId;
    const isStale = () => this._mountId !== myMountId || !this.ticket;
    const ticketId = this.ticket.id;

    this._isRefreshing = true;
    const refreshBtn = document.getElementById("refreshTicketBtn");
    const prevLabel = refreshBtn ? refreshBtn.textContent : null;
    if (refreshBtn) {
      refreshBtn.disabled = true;
      refreshBtn.textContent = "⏳ Обновление...";
    }

    try {
      const result = await ticketRepository.fetchById(this.api, ticketId);
      if (isStale()) return;

      if (!result.ok) {
        if (result.errorType === "network") {
          notify.warning("Нет связи с сервером. Карточка не обновлена.", {
            once: true,
          });
        } else if (result.errorType === "not_found") {
          notify.warning(
            "Заявка уже синхронизирована. Откройте её из журнала.",
            { once: true },
          );
        }
        return;
      }

      if (this.state.mode !== "view") return;

      const fresh = result.data;
      normalizeTicketFields(fresh);
      const cmds = await outboxQueue.getPendingByTicket(ticketId);
      if (isStale() || this.state.mode !== "view") return;

      this.state.setServerTicket(fresh, cmds);

      const container = document.getElementById(
        "ticketDetailsDynamicContainer",
      );
      if (container) {
        this._renderCard(container);
        if (showSuccess) this._applySuccessUI();
      }
      this._syncSourceArray();
      if (!showSuccess) logHistoryAction("Карточка заявки обновлена.");
    } catch (err) {
      console.error("[DetailsController] Refresh after save error:", err);
    } finally {
      this._isRefreshing = false;
      const btn = document.getElementById("refreshTicketBtn");
      if (btn && prevLabel != null && !showSuccess) {
        btn.disabled = false;
        btn.textContent = prevLabel;
      }
    }
  }

  _syncSourceArray() {
    if (!this._sourceArray || this._sourceIdx < 0 || !this.ticket) return;
    this._sourceArray[this._sourceIdx] = { ...this.ticket };
  }

  _renderCard(container) {
    this.staffSlotsView?.destroy?.();
    this.staffSlotsView = null;
    this.closeForm?.destroy();
    this.closeForm = null;
    destroyVoiceInput();
    this.notesComposer?.destroy();
    this.notesComposer = null;
    this.editForm?.destroy();
    this.editForm = null;

    const t = this.ticket;
    if (!t) return;

    const isOffline = t.isOffline === true;
    const pendingClose = t._pendingClose || null;
    const isClosed = t.type === "close" || !!pendingClose;
    const isOpen = !isClosed;
    const isAssigned = userStore.isAssignedTo(t, userStore.userId);

    const canEdit =
      isOpen &&
      !isOffline &&
      !pendingClose &&
      (t.can_edit !== undefined
        ? t.can_edit
        : userStore.can("add_details", { isAssigned }));

    const canClose =
      isOpen &&
      !isOffline &&
      !pendingClose &&
      (t.can_close !== undefined
        ? t.can_close
        : userStore.can("close_ticket", { isAssigned }) ||
          Number(t.closureallowed) === 1);

    const canComment = t.can_comment !== undefined ? t.can_comment : true;

    const pendingList = this.state.pendingCommands || [];
    const hasPendingEdit = pendingList.some(
      (c) => c.command_type === "EditTicket",
    );
    const hasPendingComment = pendingList.some(
      (c) => c.command_type === "AddComment",
    );

    const statusLabel = isClosed
      ? pendingClose
        ? "⏳ ЗАКРЫТА ЛОКАЛЬНО"
        : "ЗАКРЫТА"
      : hasPendingEdit
        ? "⏳ В РАБОТЕ (изменена)"
        : "В РАБОТЕ";

    container.innerHTML = renderCardLayout({
      ticket: t,
      isOffline,
      pendingClose,
      isClosed,
      isOpen,
      canEdit,
      canClose,
      canComment,
      hasPendingEdit,
      hasPendingComment,
      statusLabel,
      statusBg: isClosed ? "rgba(34,197,94,0.15)" : "rgba(239,68,68,0.15)",
      statusColor: isClosed ? "#22c55e" : "#ef4444",
      solutionText: pendingClose ? pendingClose.solution : t.solution || "",
      closeDate: pendingClose ? pendingClose.close_date : t.close_date,
      closeName: pendingClose ? pendingClose.close_name : t.close_name || "—",
      isAdmin: userStore.isAdmin(),
    });

    this._renderStaffSlots();

    const notesContainer = document.getElementById("notesContainerDOM");
    const notesBadge = document.getElementById("notesCountBadge");
    if (notesContainer && notesBadge) {
      renderNotesList(notesContainer, notesBadge, t.note || []);
    }

    const noteComposerEl = document.getElementById("noteComposer");
    if (noteComposerEl && canComment) {
      this.notesComposer = createNotesComposer(noteComposerEl, {
        onSubmit: () => this._onAddNote(),
      });
    }

    this._bindEvents();
  }

  _renderStaffSlots() {
    const container = document.getElementById("staffSlotsContainer");
    if (!container || !this.ticket) return;

    this.staffSlotsView?.destroy?.();

    const isOpen = this.ticket.type !== "close";

    this.staffSlotsView = renderStaffSlots(container, {
      ticket: this.ticket,
      draft: this.state.draft,
      mode: this.state.mode,
      staffList: staffStore.list,
      permissions: {
        isAdmin: userStore.isAdmin(),
        canAssign: isOpen && userStore.can("assign_staff"),
      },
      autoOpenPending: this._autoOpenPending,
      handlers: {
        onAssign: (slotNumber, staffId, staffName, notifyChecked) => {
          const suffix = slotNumber === 1 ? "" : slotNumber;
          this.state.updateDraft("staff_id" + suffix, staffId);
          this.state.updateDraft("staff_name" + suffix, staffName);
          if (notifyChecked) {
            this.state.updateDraft("notify_status" + suffix, 1);
            this.state.updateDraft("notify_date" + suffix, nowTs());
          }
          this._staffChangedInSession = true;
          this._autoOpenPending = false;
          this._renderStaffSlots();
          this._updateSaveButtonState();
        },
        onUnassign: (slotNumber) => {
          if (slotNumber === -1) {
            this._renderStaffSlots();
            return;
          }
          const suffix = slotNumber === 1 ? "" : slotNumber;
          this.state.updateDraft("staff_id" + suffix, null);
          this.state.updateDraft("staff_name" + suffix, null);
          this.state.updateDraft("staff_phone" + suffix, null);
          this.state.updateDraft("notify_status" + suffix, 0);
          this.state.updateDraft("notify_date" + suffix, null);
          this._staffChangedInSession = true;
          this._renderStaffSlots();
          this._updateSaveButtonState();
        },
        onNotify: (slotNumber) => {
          const suffix = slotNumber === 1 ? "" : slotNumber;
          this.state.updateDraft("notify_status" + suffix, 1);
          this.state.updateDraft("notify_date" + suffix, nowTs());
          this._renderStaffSlots();
          this._updateSaveButtonState();
        },
        onAutoOpenConsumed: () => {
          this._autoOpenPending = false;
        },
      },
    });
  }

  _bindEvents() {
    const $ = (id) => document.getElementById(id);

    const refreshBtn = $("refreshTicketBtn");
    if (refreshBtn)
      refreshBtn.onclick = () => this._refreshTicketAfterSave(false);

    const backBtn = $("backBtn");
    if (backBtn)
      backBtn.onclick = () =>
        this.router.navigate(this.ticket?.type === "close" ? "#/closed" : "#/");

    const editBtn = $("editBtn");
    if (editBtn) editBtn.onclick = () => this._enterEditMode();

    const closeBtn = $("closeBtn");
    if (closeBtn) closeBtn.onclick = () => this._enterCloseMode();

    const cancelBtn = $("cancelEditBtn");
    if (cancelBtn) cancelBtn.onclick = () => this._exitEditMode();

    const saveBtn = $("saveBtn");
    if (saveBtn) saveBtn.onclick = () => this._onSave();
  }

  _enterEditMode() {
    this.state.setMode("edit");
    this.state.clearDraft();
    this._staffChangedInSession = false;
    this._autoOpenPending = this.ticket.staff_id == null;

    const editBtn = document.getElementById("editBtn");
    if (editBtn) editBtn.style.display = "none";
    const closeBtn = document.getElementById("closeBtn");
    if (closeBtn) closeBtn.style.display = "none";

    const saveBtn = document.getElementById("saveBtn");
    if (saveBtn) saveBtn.hidden = false;
    const cancelBtn = document.getElementById("cancelEditBtn");
    if (cancelBtn) cancelBtn.style.display = "block";

    this._renderStaffSlots();

    const isAssigned = userStore.isAssignedTo(this.ticket, userStore.userId);

    this.editForm = createEditForm({
      ticket: this.ticket,
      draft: this.state.draft,
      permissions: {
        canChangeDept: userStore.can("change_department", {
          currentValue: this.ticket.department_id,
        }),
        canChangeReq: userStore.can("change_request", {
          currentValue: this.ticket.request_id,
        }),
        canChangeGroup: userStore.can("change_group", {
          currentValue: this.ticket.group_id,
        }),
        canSetRepair: userStore.can("set_repair_time", { isAssigned }),
      },
      onChange: () => this._updateSaveButtonState(),
    });

    this._updateSaveButtonState();
  }

  _exitEditMode() {
    this.editForm?.destroy();
    this.editForm = null;
    this.closeForm?.destroy();
    this.closeForm = null;

    this.state.clearDraft();
    this.state.setMode("view");
    this._staffChangedInSession = false;
    this._autoOpenPending = false;

    const bodyBlock = document.getElementById("ticketBodyBlock");
    if (bodyBlock) bodyBlock.style.display = "flex";
    const detailsAddBlock = document.getElementById("detailsAddBlock");
    if (detailsAddBlock) detailsAddBlock.style.display = "none";
    const closeBlock = document.getElementById("closeBlock");
    if (closeBlock) closeBlock.style.display = "none";
    const saveBtn = document.getElementById("saveBtn");
    if (saveBtn) saveBtn.hidden = true;
    const cancelBtn = document.getElementById("cancelEditBtn");
    if (cancelBtn) cancelBtn.style.display = "none";

    const editBtn = document.getElementById("editBtn");
    if (editBtn) editBtn.style.display = "block";
    const closeBtn = document.getElementById("closeBtn");
    if (closeBtn) closeBtn.style.display = "block";

    const display = document.getElementById("detailsDisplay");
    if (display)
      display.textContent = this.ticket?.details || "Описание отсутствует.";

    for (const id of [
      "deptDisplay",
      "reqDisplay",
      "groupDisplay",
      "repairTimeDisplay",
    ]) {
      const el = document.getElementById(id);
      if (el) el.title = "";
    }

    this._renderStaffSlots();
  }

  _enterCloseMode() {
    this.state.setMode("close");

    const bodyBlock = document.getElementById("ticketBodyBlock");
    if (bodyBlock) bodyBlock.style.display = "none";
    const closeBlock = document.getElementById("closeBlock");
    if (closeBlock) closeBlock.style.display = "block";

    const editBtn = document.getElementById("editBtn");
    if (editBtn) editBtn.style.display = "none";
    const closeBtn = document.getElementById("closeBtn");
    if (closeBtn) closeBtn.style.display = "none";
    const saveBtn = document.getElementById("saveBtn");
    if (saveBtn) saveBtn.hidden = false;
    const cancelBtn = document.getElementById("cancelEditBtn");
    if (cancelBtn) cancelBtn.style.display = "block";

    this.closeForm = createCloseForm({
      onChange: () => this._updateSaveButtonState(),
    });

    setTimeout(() => this.closeForm?.focus(), 50);
    this._updateSaveButtonState();
  }

  _updateSaveButtonState() {
    const saveBtn = document.getElementById("saveBtn");
    if (
      !saveBtn ||
      saveBtn.classList.contains("btn-loading") ||
      saveBtn.classList.contains("btn-success") ||
      saveBtn.classList.contains("btn-error")
    )
      return;

    let enabled = false;
    if (this.state.mode === "edit") {
      const hasDraft = Object.keys(this.state.draft).length > 0;
      const hasUncommitted = this.editForm
        ? this.editForm.hasUncommittedDetails()
        : false;
      enabled =
        (hasDraft || hasUncommitted) &&
        (this.editForm ? this.editForm.isValid() : false);
    } else if (this.state.mode === "close") {
      enabled = this.closeForm ? this.closeForm.isValid() : false;
    }

    saveBtn.disabled = !enabled;
    saveBtn.style.opacity = enabled ? "1" : "0.5";
    saveBtn.style.cursor = enabled ? "pointer" : "not-allowed";
  }

  _setSaveBtnState(state) {
    const btn = document.getElementById("saveBtn");
    if (!btn) return;
    btn.classList.remove("btn-loading", "btn-success", "btn-error");

    if (state === "loading" || state === "success" || state === "error") {
      btn.disabled = true;
      btn.classList.add("btn-" + state);
      btn.textContent = "";
    } else {
      btn.textContent = "Сохранить";
      this._updateSaveButtonState();
    }
  }

  _cleanupAfterAuthError() {
    this._unlockCard();
    this._setSaveBtnState("idle");
    this.editForm?.destroy();
    this.editForm = null;
    this.closeForm?.destroy();
    this.closeForm = null;
    this.state.clearDraft();
    this.state.setMode("view");
    if (this.autoReturnTimer) {
      clearTimeout(this.autoReturnTimer);
      this.autoReturnTimer = null;
    }
  }

  _applySuccessUI() {
    for (const id of ["editBtn", "closeBtn", "cancelEditBtn"]) {
      const el = document.getElementById(id);
      if (el) el.style.display = "none";
    }
    const saveBtn = document.getElementById("saveBtn");
    if (saveBtn) {
      saveBtn.hidden = false;
      saveBtn.style.display = "block";
      this._setSaveBtnState("success");
    }
  }

  _lockCard() {
    document
      .querySelector(".ticket-card-layout-grid")
      ?.classList.add("card-locked");
    this.notesComposer?.lock();
  }

  _unlockCard() {
    document
      .querySelector(".ticket-card-layout-grid")
      ?.classList.remove("card-locked");
    this.notesComposer?.unlock();
  }

  _scheduleReturnToList() {
    if (this.autoReturnTimer) clearTimeout(this.autoReturnTimer);
    this.autoReturnTimer = setTimeout(() => {
      if (!this.ticket || this.state.mode !== "view") return;
      if (!window.location.hash.startsWith("#/ticket/")) return;
      this.router.navigate(this.ticket.type === "close" ? "#/closed" : "#/");
    }, AUTO_RETURN_MS);
  }

  _scheduleCreateFromCurrent(fromTicketId) {
    if (this.autoReturnTimer) clearTimeout(this.autoReturnTimer);
    const backBtn = document.getElementById("backBtn");
    if (backBtn) backBtn.style.display = "none";

    this.autoReturnTimer = setTimeout(() => {
      if (!this.ticket) return;
      appState.pendingCreateAddress = {
        from_ticket_id: fromTicketId,
        address: this.ticket.fullAddress || this.ticket.address || "",
        city_id: this.ticket.city_id || null,
        street_id: this.ticket.street_id || null,
        home_id: this.ticket.home_id || null,
        object_id: this.ticket.object_id || null,
      };
      this.router.navigate("#/create");
    }, UI.CLOSE_AND_CREATE_REDIRECT_MS);
  }

  async _onSave() {
    if (this.state.mode === "edit" && !this.state.hasDraftChanges()) {
      if (this.editForm?.hasUncommittedDetails()) {
        document.getElementById("addDetailsBtn")?.click();
      }
      if (!this.state.hasDraftChanges()) return;
    }

    const ticketId = this.ticket ? this.ticket.id : null;
    if (ticketId == null) return;

    // --- Офлайн ---
    if (!navigator.onLine) {
      if (this.state.mode === "edit") {
        const ok = await this._saveEditOffline();
        if (ok && this.ticket) this._scheduleReturnToList();
      } else if (this.state.mode === "close") {
        await this._saveCloseOffline();
      }
      return;
    }

    let response;
    this._lockCard();
    this._setSaveBtnState("loading");

    try {
      if (this.state.mode === "close") {
        const { solution } = this.closeForm.getValue();
        const user = userStore.userId || authStore.getUser()?.id || 0;
        response = await ticketRepository.saveClose(
          this.api,
          ticketId,
          solution,
          user,
        );
      } else {
        response = await ticketRepository.saveEdit(
          this.api,
          ticketId,
          this.state.draft,
        );
      }

      if (!this.ticket || String(this.ticket.id) !== String(ticketId)) return;

      // --- Сеть отвалилась во время запроса → офлайн-путь ---
      if (
        response &&
        (response.code === "network_error" || response.offline === true)
      ) {
        const ok =
          this.state.mode === "close"
            ? await this._saveCloseOffline()
            : await this._saveEditOffline();
        if (!ok && this.ticket && String(this.ticket.id) === String(ticketId)) {
          this._unlockCard();
          this._setSaveBtnState("error");
          setTimeout(() => {
            if (!this.ticket) return;
            this._unlockCard();
            this._setSaveBtnState("idle");
          }, ERROR_UNLOCK_MS);
        }
        return;
      }

      if (response && response._authLost) {
        this._cleanupAfterAuthError();
        return;
      }

      if (response && response.status === "ok") {
        this._setSaveBtnState("success");
        logHistoryAction(response.message || "Изменения сохранены.");
        this._staffChangedInSession = false;
        this._autoOpenPending = false;

        if (this.state.mode === "close") {
          this._applySuccessUI();
          const { shouldCreateNew } = this.closeForm.getValue();
          this._syncSourceArray();
          if (shouldCreateNew) this._scheduleCreateFromCurrent(ticketId);
          else this._scheduleReturnToList();
        } else {
          this._syncSourceArray();
          this.editForm?.destroy();
          this.editForm = null;
          this.state.clearDraft();
          this.state.setMode("view");
          await this._refreshTicketAfterSave(true);
          this._applySuccessUI();
          this._scheduleReturnToList();
        }
      } else {
        const msg =
          (response && response.message) || "Не удалось сохранить изменения.";
        this._setSaveBtnState("error");
        logHistoryAction(msg);
        notify.error(msg);
        if (this.autoReturnTimer) clearTimeout(this.autoReturnTimer);
        this.autoReturnTimer = setTimeout(() => {
          if (!this.ticket) return;
          this._unlockCard();
          this._setSaveBtnState("idle");
        }, ERROR_UNLOCK_MS);
      }
    } catch (err) {
      console.error("[DetailsController] Save error:", err);
      if (!this.ticket) return;
      this._setSaveBtnState("error");
      logHistoryAction(
        "Сбой сети при сохранении: " + (err.message || "неизвестная ошибка"),
      );
      notify.error("Не удалось сохранить. Проверьте соединение.");
      if (this.autoReturnTimer) clearTimeout(this.autoReturnTimer);
      this.autoReturnTimer = setTimeout(() => {
        if (!this.ticket) return;
        this._unlockCard();
        this._setSaveBtnState("idle");
      }, ERROR_UNLOCK_MS);
    }
  }

  async _onAddNote() {
    if (!this.notesComposer || !this.ticket) return;
    const { text, file } = this.notesComposer.getValue();
    if (!text) return;

    if (!navigator.onLine) {
      if (file) {
        notify.warning(
          "Фото не будет прикреплено: синхронизация фото доступна только онлайн.",
        );
      }
      await this._saveNoteOffline(text);
      return;
    }

    const ticketId = this.ticket.id;
    if (ticketId == null) return;

    let photoBase64 = null;
    if (file) {
      this.notesComposer.setLoadingText("Сжатие фото...");
      try {
        photoBase64 = (await compressPhoto(file)).base64;
      } catch (err) {
        this.notesComposer.resetButton();
        notify.error("Фото не прикреплено: " + err.message);
        return;
      }
    }

    this.notesComposer.setLoadingText("Отправка...");

    try {
      const response = await ticketRepository.addNote(
        this.api,
        ticketId,
        text,
        photoBase64,
      );
      if (!this.ticket || String(this.ticket.id) !== String(ticketId)) return;

      if (
        response &&
        (response.code === "network_error" || response.offline === true)
      ) {
        await this._saveNoteOffline(text);
        return;
      }

      if (response && response._authLost) {
        this.notesComposer.resetButton();
        return;
      }

      if (response && response.status === "ok") {
        logHistoryAction(response.message || "Комментарий добавлен.");

        const note = {
          id: "local_" + Date.now(),
          user: "Вы",
          body: text,
          date: nowTs(),
          type: 0,
          is_offline: 0,
        };

        const serverTicket = this.state.serverTicket;
        if (serverTicket) {
          if (Array.isArray(serverTicket.note)) serverTicket.note.push(note);
          else if (serverTicket.note && typeof serverTicket.note === "object")
            serverTicket.note[Object.keys(serverTicket.note).length + 1] = note;
          else serverTicket.note = [note];
          serverTicket.note_num = (serverTicket.note_num || 0) + 1;
        }

        this.notesComposer.reset();
        renderNotesList(
          document.getElementById("notesContainerDOM"),
          document.getElementById("notesCountBadge"),
          this.ticket.note || [],
        );
        this._syncSourceArray();
      } else {
        const msg =
          (response && response.message) || "Не удалось добавить комментарий.";
        logHistoryAction(msg);
        notify.error(msg);
        this.notesComposer.resetButton();
      }
    } catch (err) {
      console.error("[DetailsController] AddNote error:", err);
      if (!this.ticket || String(this.ticket.id) !== String(ticketId)) return;
      logHistoryAction("Сбой сети при добавлении комментария.");
      notify.error("Не удалось добавить комментарий. Проверьте соединение.");
      this.notesComposer.resetButton();
    }
  }

  async _saveNoteOffline(text) {
    const ticketId = this.ticket ? this.ticket.id : null;
    if (ticketId == null) return;

    try {
      await outboxQueue.enqueueComment(ticketId, text);
      logHistoryAction("Комментарий сохранён локально.");
      notify.offline(
        "Комментарий сохранён. Будет синхронизирован при восстановлении сети.",
      );

      if (!this.ticket || String(this.ticket.id) !== String(ticketId)) return;
      await this._refreshOfflineState(ticketId);
      if (!this.ticket || String(this.ticket.id) !== String(ticketId)) return;

      this.notesComposer?.reset();
      renderNotesList(
        document.getElementById("notesContainerDOM"),
        document.getElementById("notesCountBadge"),
        this.ticket.note || [],
      );
      this._syncSourceArray();
    } catch (err) {
      console.error("[DetailsController] Offline note save error:", err);
      notify.error("Не удалось сохранить комментарий локально.");
      this.notesComposer?.resetButton();
    }
  }

  /**
   * Офлайн-правка серверной заявки. Срок ремонта не участвует (п. 1.5):
   * сервер игнорирует repair_time в EditTicket, клиент его не отправляет.
   * Ветки details / staff_id / notify_status с предупреждениями сохранены.
   */
  async _saveEditOffline() {
    const ticketId = this.ticket ? this.ticket.id : null;
    if (ticketId == null) return false;

    const patch = {};

    if (this.state.draft.details) patch.details = this.state.draft.details;

    if (this.state.draft.staff_id != null) {
      if (!this.ticket.staff_id) patch.staff_id = this.state.draft.staff_id;
      else
        notify.warning(
          "Ответственный уже назначен — изменение не будет синхронизировано офлайн.",
        );
    }

    if (this.state.draft.notify_status != null) {
      if (!this.ticket.notify_status)
        patch.notify_status = this.state.draft.notify_status;
      else
        notify.warning(
          "Статус уведомления уже установлен — изменение не будет синхронизировано офлайн.",
        );
    }

    if (Object.keys(patch).length === 0) {
      notify.warning(
        "Нет изменений для офлайн-синхронизации. Возможные изменения доступны только онлайн.",
      );
      return false;
    }

    try {
      await outboxQueue.enqueueEdit(ticketId, patch);
      logHistoryAction("Изменения сохранены локально.");
      notify.offline(
        "Изменения сохранены. Будут синхронизированы при восстановлении сети.",
      );

      this._staffChangedInSession = false;
      this._autoOpenPending = false;
      this.state.clearDraft();
      this.state.setMode("view");

      if (!this.ticket || String(this.ticket.id) !== String(ticketId))
        return true;

      await this._refreshOfflineState(ticketId);
      if (!this.ticket || String(this.ticket.id) !== String(ticketId))
        return true;

      const container = document.getElementById(
        "ticketDetailsDynamicContainer",
      );
      if (container) {
        this._renderCard(container);
        this._applySuccessUI();
      }
      this._syncSourceArray();
      return true;
    } catch (err) {
      console.error("[DetailsController] Offline edit save error:", err);
      notify.error("Не удалось сохранить изменения локально.");
      return false;
    }
  }

  async _saveCloseOffline() {
    const ticketId = this.ticket ? this.ticket.id : null;
    if (ticketId == null) return false;

    const { solution, shouldCreateNew } = this.closeForm.getValue();

    try {
      await outboxQueue.enqueueClose(ticketId, solution);
      logHistoryAction("Заявка закрыта локально.");
      notify.offline(
        "Заявка закрыта. Будет синхронизирована при восстановлении сети.",
      );

      this.state.clearDraft();
      this.state.setMode("view");

      if (!this.ticket || String(this.ticket.id) !== String(ticketId))
        return true;

      await this._refreshOfflineState(ticketId);
      if (!this.ticket || String(this.ticket.id) !== String(ticketId))
        return true;

      const container = document.getElementById(
        "ticketDetailsDynamicContainer",
      );
      if (container) {
        this._renderCard(container);
        this._applySuccessUI();
      }
      this._syncSourceArray();

      if (shouldCreateNew) this._scheduleCreateFromCurrent(ticketId);
      return true;
    } catch (err) {
      console.error("[DetailsController] Offline close save error:", err);
      notify.error("Не удалось закрыть заявку локально.");
      return false;
    }
  }

  unmount() {
    this._mountId++;
    this._staffChangedInSession = false;
    this._autoOpenPending = false;
    this._isRefreshing = false;

    this.state.clearDraft();
    this.state.setMode("view");
    this.state.setServerTicket(null);

    destroyVoiceInput();
    this._unlockCard();

    // Отменяем только чтение: запись сервер мог уже применить.
    this.api.abortTag("details-read");

    this.editForm?.destroy();
    this.editForm = null;
    this.closeForm?.destroy();
    this.closeForm = null;
    this.staffSlotsView?.destroy?.();
    this.staffSlotsView = null;
    this.notesComposer?.destroy();
    this.notesComposer = null;

    if (this.autoReturnTimer) {
      clearTimeout(this.autoReturnTimer);
      this.autoReturnTimer = null;
    }

    this.currentTicketId = null;
    this._sourceArray = null;
    this._sourceIdx = -1;
  }
}
