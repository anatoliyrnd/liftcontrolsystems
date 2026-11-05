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
    this.notesComposer = null;
    this.api = apiInstance;
    this.router = routerInstance;
    this.currentTicketId = null;
    this.autoReturnTimer = null;
    this.state = new DetailsState();
    this._staffChangedInSession = false;
    this._autoOpenPending = false;
    this.closeForm = null;
    this._mountId = 0;
    this._sourceArray = null;
    this._sourceIdx = -1;
    this.staffSlotsView = null;
    this.editForm = null;
  }

  async mount(ticketId, combinedTicketsArray = []) {
    const myMountId = ++this._mountId;
    const isStale = () => this._mountId !== myMountId;

    this.currentTicketId = ticketId;
    this.state.clearDraft(); // Вместо this.state.clearDraft();
    this.state.setMode("view"); // Вместо this.mode = "view"

    const container = document.getElementById("ticketDetailsDynamicContainer");
    if (!container) return;

    const isOfflineId = String(ticketId).startsWith("offline_");

    let ticket = isOfflineId
      ? null
      : combinedTicketsArray.find((t) => String(t.id) === String(ticketId));

    if (!ticket) {
      const result = await ticketRepository.fetchById(this.api, ticketId);

      // Если пока ждали — ушли на другую страницу, abort.
      if (isStale()) return;
      if (this.currentTicketId !== ticketId) return;

      if (!result.ok) {
        if (result.errorType === "not_found") {
          render404(container, ticketId, {
            onBack: () => this.router.navigate("#/"),
          });
        } else if (result.errorType === "network") {
          renderNetworkError(container, ticketId, {
            onRetry: () => this.mount(ticketId, combinedTicketsArray),
            onBack: () => this.router.navigate("#/"),
          });
        }
        // Если aborted — просто ничего не делаем
        return;
      }

      ticket = result.data;
    }

    // Shallow-копия + копия note-массива. Без этого _applyPendingToTicket
    // мутирует объект внутри combinedTicketsArray (общий), и при повторном
    // открытии карточки details/note дублируются.
    const normalizedTicket = normalizeTicketFields({
      ...ticket,
      note: Array.isArray(ticket.note)
        ? [...ticket.note]
        : ticket.note && typeof ticket.note === "object"
          ? { ...ticket.note }
          : ticket.note,
    });

    // Ссылка на источник для синхронизации после save/close.
    if (combinedTicketsArray && combinedTicketsArray.length > 0) {
      this._sourceArray = combinedTicketsArray;
      this._sourceIdx = combinedTicketsArray.findIndex(
        (t) => String(t.id) === String(ticketId),
      );
    } else {
      this._sourceArray = null;
      this._sourceIdx = -1;
    }

    const cmds = await outboxQueue.getPendingByTicket(ticketId);
    if (isStale()) return;
    this.state.setServerTicket(normalizedTicket, cmds);

    this._renderCard(container);
  }
  /**
   * После офлайн-операции (edit / comment / close) обновить state.
   *
   * Для offline_ заявки: правки/комментарии/закрытие свёрнуты в
   * CreateTicket.payload (см. outbox-queue #3–#5), а
   * getPendingByTicket(offline_) всегда пуст. Поэтому перечитываем
   * свежий payload через ticketRepository.fetchById — для offline_
   * он читает из offlineDB, без сети (правка #6).
   *
   * Для серверной заявки (fallback при network_error): создан
   * отдельный EditTicket/AddComment/CloseTicket — обновляем только
   * pendingCommands, overlay применит их в getDisplayTicket.
   * fetchById здесь НЕ вызываем: сети нет, будет 30s таймаут.
   *
   * Guard по this.ticket.id — если пользователь ушёл на другой роут
   * во время await — тихо выходим. Рендер — на стороне вызывающего
   * (_renderCard у edit/close, renderNotesList у comment).
   */
  async _refreshOfflineState(ticketId) {
    if (!this.ticket || this.ticket.id !== ticketId) return;

    const isOffline =
      typeof ticketId === "string" && ticketId.startsWith("offline_");
    const cmds = await outboxQueue.getPendingByTicket(ticketId);
    if (!this.ticket || this.ticket.id !== ticketId) return;

    if (isOffline) {
      const fresh = await ticketRepository.fetchById(this.api, ticketId);
      if (!this.ticket || this.ticket.id !== ticketId) return;
      if (fresh.ok) {
        normalizeTicketFields(fresh.data);
        this.state.setServerTicket(fresh.data, cmds);
      } else {
        // CreateTicket уже синхронизирован и удалён из outbox
        // (редкий race с момента старта операции). Оставляем как есть —
        // следующий mount по journal-id откроет серверную заявку.
        this.state.setPendingCommands(cmds);
      }
    } else {
      this.state.setPendingCommands(cmds);
    }
  }
  /**
   * После успешного сохранения (calledit / callClose) — перезапрашиваем
   * заявку через get_ticket и делаем полный merge.
   *
   * Раньше обновлялись только staff-поля (12 штук). Но сервер мог
   * пересчитать и другие поля:
   *   - alert_level (зависит от call_department, call_request, сроков);
   *   - is_emergency (по call_department_id);
   *   - expected_repair_time (если сервер нормализует);
   *   - call_details (append-only — сервер вернёт «склеенное»);
   *   - can_edit / can_close / can_comment (если сменились права).
   *
   * Защищённые ключи (не перезаписываем):
   *   type, isOffline      — клиентская маркировка
   *   note                 — комментарии рендерятся отдельно, могут
   *                          содержать pending с optimistic UI
   *   _pendingStaff, _pendingNotify, _pendingRepair,
   *   _pendingDetails, _pendingClose — локальные оверлеи optimistic UI
   *
   * После merge — полная перерисовка карточки (не только staff),
   * потому что измениться могло любое поле. Это проще и надёжнее
   * точечного patch.
   *
   * Guard _mountId: если пользователь ушёл на другой роут, пока шёл
   * fetch, — не трогаем DOM.
   */
  async _refreshTicketAfterSave() {
    if (!this.ticket) return;

    const myMountId = this._mountId;
    const isStale = () => this._mountId !== myMountId;

    try {
      const result = await ticketRepository.fetchById(this.api, this.ticket.id);
      if (isStale() || !this.ticket) return;
      if (!result.ok) return;
      const fresh = result.data;

      if (this.state.mode !== "view") return;

      normalizeTicketFields(fresh);

      this.state.setServerTicket(fresh, this.state.pendingCommands);

      if (isStale() || !this.ticket || this.state.mode !== "view") return;
      const container = document.getElementById(
        "ticketDetailsDynamicContainer",
      );
      if (container) {
        this._renderCard(container);
      }
      this._syncSourceArray();
    } catch (err) {
      console.error("[DetailsController] Refresh after save error:", err);
    }
  }

  /**
   * Точечная загрузка заявки по call_id через { data: 'ticket', call_id }.
   *
   * Контракт (API_PROTOCOL.md v4.3):
   *   { status: 'ok', data: { ...полный объект заявки... } } — найдено
   *   { status: 'ok', data: null }                             — not_found
   *   { status: 'error', code, message }                       — сеть / сервер
   *
   * Заменяет двойной запрос (open + close period=7), который:
   *   - не находил заявки старше 7 дней;
   *   - не находил закрытые заявки в других периодах;
   *   - каждый раз дёргал полный список (тяжело при 5000+ заявок).
   *
   * При ошибке (сеть/сервер) сохраняет this._lastFetchError = 'network'
   * (не 'not_found'), чтобы mount мог отличить 404 от сбоя.
   */
  get ticket() {
    return this.state.getDisplayTicket(staffStore.list);
  }

  /**
   * Обновить элемент в combinedTicketsArray, чтобы журнал при возврате
   * показал актуальные данные без ожидания polling.
   */
  _syncSourceArray() {
    if (!this._sourceArray || this._sourceIdx < 0) return;
    if (!this.ticket) return;
    this._sourceArray[this._sourceIdx] = { ...this.ticket };
  }

  /**
   * Экран «сбой сети» — отличается от 404 (заявка не существует).
   * Показывает кнопки «Повторить» и «Вернуться в журнал».
   * Вызывается, когда _fetchTicketFromServer вернул null с
   * _lastFetchError === 'network' (таймаут, сервер 5xx,
   * invalid_response).
   */

  _renderCard(container) {
    if (this.staffSlotsView && this.staffSlotsView.destroy) {
      this.staffSlotsView.destroy();
      this.staffSlotsView = null;
    }
    if (this.closeForm) {
      this.closeForm.destroy();
      this.closeForm = null;
    }
    destroyVoiceInput();

    if (this.notesComposer) {
      this.notesComposer.destroy();
      this.notesComposer = null;
    }
    if (this.editForm) {
      this.editForm.destroy();
      this.editForm = null;
    }

    const t = this.ticket;
    const isOffline = t.isOffline === true;
    const pendingClose = t._pendingClose || null;
    const isClosed = t.type === "close" || !!pendingClose;
    const isOpen = !isClosed;

    const isAssigned = userStore.isAssignedTo(t, userStore.userId);
    const canEdit =
      isOpen &&
      !isOffline &&
      !pendingClose &&
      userStore.can("add_details", { isAssigned });
    const canClose =
      isOpen &&
      !isOffline &&
      !pendingClose &&
      (userStore.can("close_ticket", { isAssigned }) ||
        Number(t.closureallowed) === 1);

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
    const statusBg = isClosed ? "rgba(34,197,94,0.15)" : "rgba(239,68,68,0.15)";
    const statusColor = isClosed ? "#22c55e" : "#ef4444";

    const solutionText = pendingClose
      ? pendingClose.solution
      : t.solution || "";
    const closeDate = pendingClose ? pendingClose.close_date : t.close_date;
    const closeName = pendingClose
      ? pendingClose.close_name
      : t.close_name || "—";

    // Вызов нового View
    container.innerHTML = renderCardLayout({
      ticket: t,
      isOffline,
      pendingClose,
      isClosed,
      isOpen,
      canEdit,
      canClose,
      hasPendingEdit,
      hasPendingComment,
      statusLabel,
      statusBg,
      statusColor,
      solutionText,
      closeDate,
      closeName,
      isAdmin: userStore.isAdmin(),
    });

    // Инициализация вложенных компонентов
    this._renderStaffSlots();
    renderNotesList(
      document.getElementById("notesContainerDOM"),
      document.getElementById("notesCountBadge"),
      t.note || [],
    );
    this.notesComposer = createNotesComposer(
      document.getElementById("noteComposer"),
      { onSubmit: () => this._onAddNote() },
    );
    this._bindEvents();
  }
  _renderStaffSlots() {
    const container = document.getElementById("staffSlotsContainer");
    if (!container) return;

    if (this.staffSlotsView && this.staffSlotsView.destroy) {
      this.staffSlotsView.destroy();
    }

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
          const keyId = "staff_id" + suffix;
          const keyName = "staff_name" + suffix;

          this.state.updateDraft(keyId, staffId);
          this.state.updateDraft(keyName, staffName);

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
            // Хак для перерисовки (Отмена в селекте)
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

    $("backBtn").onclick = () =>
      this.router.navigate(this.ticket.type === "close" ? "#/closed" : "#/");

    const editBtn = $("editBtn");
    if (editBtn) editBtn.onclick = () => this._enterEditMode();

    const closeBtn = $("closeBtn");
    if (closeBtn) closeBtn.onclick = () => this._enterCloseMode();

    $("cancelEditBtn").onclick = () => this._exitEditMode();

    $("saveBtn").onclick = () => this._onSave();
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
    document.getElementById("saveBtn").hidden = false;
    document.getElementById("cancelEditBtn").style.display = "block";

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
    if (this.editForm) {
      this.editForm.destroy();
      this.editForm = null;
    }
    if (this.closeForm) {
      this.closeForm.destroy();
      this.closeForm = null;
    }
    this.state.clearDraft();
    this.state.setMode("view");
    this._staffChangedInSession = false;
    this._autoOpenPending = false;

    const bodyBlock = document.getElementById("ticketBodyBlock");
    if (bodyBlock) bodyBlock.style.display = "flex";
    document.getElementById("detailsAddBlock").style.display = "none";
    document.getElementById("closeBlock").style.display = "none";
    document.getElementById("saveBtn").hidden = true;
    document.getElementById("cancelEditBtn").style.display = "none";
    const editBtn = document.getElementById("editBtn");
    if (editBtn) editBtn.style.display = "block";
    const closeBtn = document.getElementById("closeBtn");
    if (closeBtn) closeBtn.style.display = "block";

    const display = document.getElementById("detailsDisplay");
    if (display)
      display.textContent = this.ticket.details || "Описание отсутствует.";

    ["deptDisplay", "reqDisplay", "groupDisplay"].forEach((id) => {
      const el = document.getElementById(id);
      if (el) el.title = "";
    });

    this._renderStaffSlots();
  }

  _enterCloseMode() {
    this.state.setMode("close");

    const bodyBlock = document.getElementById("ticketBodyBlock");
    if (bodyBlock) bodyBlock.style.display = "none";

    document.getElementById("closeBlock").style.display = "block";

    this.closeForm = createCloseForm({
      onChange: () => this._updateSaveButtonState(),
    });

    setTimeout(() => {
      if (this.closeForm) this.closeForm.focus();
    }, 50);
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

    if (state === "loading") {
      btn.disabled = true;
      btn.classList.add("btn-loading");
      btn.textContent = "";
    } else if (state === "success") {
      btn.disabled = true;
      btn.classList.add("btn-success");
      btn.textContent = "";
    } else if (state === "error") {
      btn.disabled = true;
      btn.classList.add("btn-error");
      btn.textContent = "";
    } else {
      btn.textContent = "Сохранить";
      this._updateSaveButtonState();
    }
  }

  _lockCard() {
    const grid = document.querySelector(".ticket-card-layout-grid");
    if (grid) grid.classList.add("card-locked");
    if (this.notesComposer) this.notesComposer.lock();
  }

  _unlockCard() {
    const grid = document.querySelector(".ticket-card-layout-grid");
    if (grid) grid.classList.remove("card-locked");
    if (this.notesComposer) this.notesComposer.unlock();
  }

  async _onSave() {
    if (this.state.mode === "edit" && !this.state.hasDraftChanges()) {
      if (this.editForm && this.editForm.hasUncommittedDetails()) {
        // Нажимаем на кнопку "Добавить" программно
        const addBtn = document.getElementById("addDetailsBtn");
        if (addBtn) addBtn.click();
      }
      if (!this.state.hasDraftChanges()) return;
    }

    if (!navigator.onLine) {
      if (this.state.mode === "edit") {
        await this._saveEditOffline();
        return;
      }
      if (this.state.mode === "close") {
        await this._saveCloseOffline();
        return;
      }
    }

    // Захватываем ticketId до await — unmount обнулит this.ticket.
    const ticketId = this.ticket ? this.ticket.id : null;
    if (ticketId == null) return;
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
      // ... далее идет существующая проверка if (!this.ticket || this.ticket.id !== ticketId) return; ...
      // Если unmount уже отработал — this.ticket === null.
      // Тихо выходим, ничего не уведомляем: сервер уже мог сохранить.
      if (!this.ticket || this.ticket.id !== ticketId) return;

      if (
        response &&
        (response.code === "network_error" || response.offline === true)
      ) {
        if (this.state.mode === "close") {
          const ok = await this._saveCloseOffline();
          if (!ok && this.ticket && this.ticket.id === ticketId) {
            this._unlockCard();
            this._setSaveBtnState("error");
          }
          return;
        }
        // edit — fallthrough → else-ветка ниже (notify.error).
      }
      if (response && response.status === "ok") {
        this._setSaveBtnState("success");
        const msg = response.message || "Изменения сохранены.";
        logHistoryAction(msg);
        notify.success(msg);

        this._staffChangedInSession = false;
        this._autoOpenPending = false;

        if (this.state.mode === "close") {
          const { shouldCreateNew } = this.closeForm.getValue();
          this._syncSourceArray();
          if (this.autoReturnTimer) clearTimeout(this.autoReturnTimer);

          if (shouldCreateNew) {
            const backBtn = document.getElementById("backBtn");
            if (backBtn) backBtn.style.display = "none";

            const fromTicketId = ticketId;
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
          } else {
            this.autoReturnTimer = setTimeout(() => {
              if (!this.ticket) return;
              if (this.state.mode !== "view") return;
              if (window.location.hash.startsWith("#/ticket/")) {
                this.router.navigate("#/closed");
              }
            }, AUTO_RETURN_MS);
          }
        } else {
          this._syncSourceArray();
          this._refreshTicketAfterSave();
          this._exitEditMode();

          this.autoReturnTimer = setTimeout(() => {
            if (!this.ticket) return;
            if (this.state.mode !== "view") return;
            if (window.location.hash.startsWith("#/ticket/")) {
              this.router.navigate(
                this.ticket.type === "close" ? "#/closed" : "#/",
              );
            }
          }, AUTO_RETURN_MS);
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
      const msg =
        "Сбой сети при сохранении: " + (err.message || "неизвестная ошибка");
      logHistoryAction(msg);
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
    if (!this.notesComposer) return;
    const { text, file } = this.notesComposer.getValue();
    if (!text) return;

    // Офлайн — сразу в outbox
    if (!navigator.onLine) {
      if (file) {
        notify.warning(
          "Фото не будет прикреплено: синхронизация фото доступна только онлайн.",
        );
      }
      await this._saveNoteOffline(text);
      return;
    }

    const ticketId = this.ticket ? this.ticket.id : null;
    if (ticketId == null) return;

    let photoBase64 = null;
    if (file) {
      this.notesComposer.setLoadingText("Сжатие фото...");
      try {
        const compressed = await compressPhoto(file);
        photoBase64 = compressed.base64;
      } catch (err) {
        console.error("[DetailsController] Photo compress error:", err);
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
      if (!this.ticket || this.ticket.id !== ticketId) return;

      if (
        response &&
        (response.code === "network_error" || response.offline === true)
      ) {
        notify.error(
          "Не удалось отправить: нет связи с сервером. Проверьте соединение и повторите.",
        );
        this.notesComposer.resetButton();
        return;
      }

      if (response && response.status === "ok") {
        const msg = response.message || "Комментарий добавлен.";
        logHistoryAction(msg);
        notify.success(msg);

        const note = {
          id: "local_" + Date.now(),
          user: "Вы",
          body: text,
          date: nowTs(),
          type: 0,
        };

        // Обновляем оригинальный тикет в стейте, а не временный геттер
        const serverTicket = this.state.serverTicket;
        if (serverTicket) {
          if (Array.isArray(serverTicket.note)) {
            serverTicket.note.push(note);
          } else if (
            serverTicket.note &&
            typeof serverTicket.note === "object"
          ) {
            serverTicket.note[Object.keys(serverTicket.note).length + 1] = note;
          } else {
            serverTicket.note = [note];
          }
        }

        this.notesComposer.reset();
        renderNotesList(
          document.getElementById("notesContainerDOM"),
          document.getElementById("notesCountBadge"),
          this.ticket.note,
        );
      } else {
        const msg =
          (response && response.message) || "Не удалось добавить комментарий.";
        logHistoryAction(msg);
        notify.error(msg);
        this.notesComposer.resetButton();
      }
    } catch (err) {
      console.error("[DetailsController] AddNote error:", err);
      if (!this.ticket || this.ticket.id !== ticketId) return;
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

      if (!this.ticket || this.ticket.id !== ticketId) return;
      // Было: setPendingCommands(cmds) — для offline_ давал пусто
      // (payload.comments не появлялся в state.serverTicket).
      await this._refreshOfflineState(ticketId);
      if (!this.ticket || this.ticket.id !== ticketId) return;

      // Не _renderCard: при mode='edit'/'close' полная перерисовка
      // сбросит открытую форму, оставив mode/pendingChanges.
      // Достаточно обновить список заметок.
      this.notesComposer.reset();
      renderNotesList(
        document.getElementById("notesContainerDOM"),
        document.getElementById("notesCountBadge"),
        this.ticket.note || [],
      );
    } catch (err) {
      console.error("[DetailsController] Offline note save error:", err);
      notify.error("Не удалось сохранить комментарий локально.");
    }
  }
  async _saveEditOffline() {
    const ticketId = this.ticket ? this.ticket.id : null;
    if (ticketId == null) return false;

    const patch = {};

    if (this.state.draft.details) {
      patch.details = this.state.draft.details;
    }
    if (this.state.draft.staff_id != null) {
      if (!this.ticket.staff_id) {
        patch.staff_id = this.state.draft.staff_id;
      } else {
        notify.warning(
          "Ответственный уже назначен — изменение не будет синхронизировано офлайн.",
        );
      }
    }
    if (this.state.draft.notify_status != null) {
      const currentStatus = this.ticket.notify_status;
      if (!currentStatus) {
        patch.notify_status = this.state.draft.notify_status;
      } else {
        notify.warning(
          "Статус уведомления уже установлен — изменение не будет синхронизировано офлайн.",
        );
      }
    }
    if (this.state.draft.repair_time != null) {
      if (!this.ticket.repair_time) {
        patch.repair_time = this.state.draft.repair_time;
      } else {
        notify.warning(
          "Время ремонта уже установлено — изменение не будет синхронизировано офлайн.",
        );
      }
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

      if (!this.ticket || this.ticket.id !== ticketId) return true;

      // Было: setPendingCommands(cmds) + _renderCard на stale serverTicket.
      await this._refreshOfflineState(ticketId);
      if (!this.ticket || this.ticket.id !== ticketId) return true;

      const container = document.getElementById(
        "ticketDetailsDynamicContainer",
      );
      if (container) this._renderCard(container);
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

      if (!this.ticket || this.ticket.id !== ticketId) return true;

      // Было: setPendingCommands(cmds) + _renderCard на stale serverTicket —
      // для offline_ _pendingClose не устанавливался, статус оставался «В РАБОТЕ».
      await this._refreshOfflineState(ticketId);
      if (!this.ticket || this.ticket.id !== ticketId) return true;

      const container = document.getElementById(
        "ticketDetailsDynamicContainer",
      );
      if (container) this._renderCard(container);
      this._syncSourceArray();

      // --- ЛОГИКА ПЕРЕХОДА НА СОЗДАНИЕ (ОФЛАЙН) ---
      if (shouldCreateNew) {
        if (this.autoReturnTimer) clearTimeout(this.autoReturnTimer);
        const backBtn = document.getElementById("backBtn");
        if (backBtn) backBtn.style.display = "none";

        this.autoReturnTimer = setTimeout(() => {
          if (!this.ticket) return;
          appState.pendingCreateAddress = {
            from_ticket_id: ticketId,
            address: this.ticket.fullAddress || this.ticket.address || "",
            city_id: this.ticket.city_id || null,
            street_id: this.ticket.street_id || null,
            home_id: this.ticket.home_id || null,
            object_id: this.ticket.object_id || null,
          };
          this.router.navigate("#/create");
        }, UI.CLOSE_AND_CREATE_REDIRECT_MS);
      }

      return true;
    } catch (err) {
      console.error("[DetailsController] Offline close save error:", err);
      notify.error("Не удалось закрыть заявку локально.");
      return false;
    }
  }
  unmount() {
    // Инвалидирует любой активный mount (guard isStale()).
    this._mountId++;
    this._staffChangedInSession = false;
    this._autoOpenPending = false;

    this.state.clearDraft();
    this.state.setMode("view");
    this.state.setServerTicket(null);

    destroyVoiceInput();
    this._unlockCard();
    // Отменяем только чтение. Записи (callClose/calledit/callnote)
    // не должны отменяться — сервер мог уже применить операцию.
    this.api.abortTag("details-read");
    if (this.editForm) {
      this.editForm.destroy();
      this.editForm = null;
    }
    if (this.closeForm) {
      this.closeForm.destroy();
      this.closeForm = null;
    }

    if (this.staffSlotsView && this.staffSlotsView.destroy) {
      this.staffSlotsView.destroy();
      this.staffSlotsView = null;
    }
    if (this.autoReturnTimer) {
      clearTimeout(this.autoReturnTimer);
      this.autoReturnTimer = null;
    }

    if (this.notesComposer) {
      this.notesComposer.destroy();
      this.notesComposer = null;
    }

    this.currentTicketId = null;
    this._sourceArray = null;
    this._sourceIdx = -1;
  }
}
