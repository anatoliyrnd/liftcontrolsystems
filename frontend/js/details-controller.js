import { staffStore } from "./staff-store.js";
import { userStore } from "./user-store.js";
import { createDictSelect } from "./components/dict-select.js";
import { createStaffSelect } from "./components/staff-select.js";
import { logHistoryAction } from "./history-logger.js";
import { createValidatedTextarea } from "./components/validated-textarea.js";
import { createRepairTimePicker } from "./components/repair-time-picker.js";
import {
  initVoiceTextarea,
  destroyVoiceInput,
} from "./components/voiceInput.js";
import { notify } from "./components/notify.js";
import { VALIDATION, UI, BUSINESS } from "./config.js";
import { appState } from "./app-state.js";
import { escapeHtml } from "./utils/escape-html.js";
import { offlineDB } from "./offline-db.js";
import { nowTs, formatTs } from "./utils/date-utils.js";
import { authStore } from "./auth-store.js";
import { outboxQueue } from "./outbox-queue.js";
import { compressPhoto } from "./utils/photo-compressor.js";
import { normalizeTicketFields } from "./details/ticket-normalizer.js";
import { formatFullHistory } from "./details/history-view.js";
import { getStatusWord } from "./details/status-word.js";
import { render404, renderNetworkError } from "./details/error-views.js";
import { ticketRepository } from "./details/ticket-repository.js";
import { DetailsState } from "./details/details-state.js";

const CAPS_REGEX = VALIDATION.CAPS_REGEX;
const MIN_SOLUTION_LEN = VALIDATION.MIN_SOLUTION_LEN;
const AUTO_RETURN_MS = UI.AUTO_RETURN_MS;
const ERROR_UNLOCK_MS = UI.ERROR_UNLOCK_MS;
const NOTIFY_CHANNELS = BUSINESS.NOTIFY_CHANNELS;
const ACCEPT_CHANNEL = BUSINESS.ACCEPT_CHANNEL;

/**
 * Нормализация числовых полей тикета. Вызывается в mount и в
 * _refreshTicketAfterSave (без неё сервер возвращает "0" строками,
 * и проверки !staff_id / !notify_status дают ложные результаты).
 */
/* function normalizeTicketFields(ticket) {
  if (!ticket) return ticket;

  if (ticket.staff_id != null && ticket.staff_id !== "")
    ticket.staff_id = Number(ticket.staff_id) || null;
  else ticket.staff_id = null;
  if (ticket.staff_id2 != null && ticket.staff_id2 !== "")
    ticket.staff_id2 = Number(ticket.staff_id2) || null;
  else ticket.staff_id2 = null;
  if (ticket.staff_id3 != null && ticket.staff_id3 !== "")
    ticket.staff_id3 = Number(ticket.staff_id3) || null;
  else ticket.staff_id3 = null;

  ticket.notify_status = Number(ticket.notify_status) || 0;
  ticket.notify_status2 = Number(ticket.notify_status2) || 0;
  ticket.notify_status3 = Number(ticket.notify_status3) || 0;

  ticket.repair_time =
    ticket.repair_time != null && ticket.repair_time !== ""
      ? Number(ticket.repair_time) || null
      : null;

  return ticket;
} */
export class DetailsController {
  constructor(apiInstance, routerInstance) {
    this.api = apiInstance;
    this.router = routerInstance;
    this.currentTicketId = null;
    // this.ticket = null;
    this.deptSelect = null;
    this.reqSelect = null;
    this.groupSelect = null;
    //this.state.clearDraft();
    // this.mode = "view";
    this.autoReturnTimer = null;
    this.state = new DetailsState();
    this._staffChangedInSession = false;
    this._autoOpenPending = false;

    // this._pendingCommands = [];
    // Счётчик монтирований — см. комментарий в tickets-controller.
    // Инкремент в unmount() инвалидирует активные mount-потоки.
    this._mountId = 0;
    // Дедуп pending-команд в рамках одного mount. Ключ — command_uuid.
    // Сбрасывается в mount(). Нужен, потому что _applyPendingToTicket
    // может быть вызван несколько раз (mount + _saveEditOffline), и без
    // дедупа details/note дублируются.
    // this._appliedPendingUuids = new Set();
    // Ссылка на массив, из которого взят этот тикет (combinedTicketsArray
    // в main.js). После save/close синхронизируем элемент, чтобы журнал
    // не показывал устаревшие данные до следующего polling.
    this._sourceArray = null;
    this._sourceIdx = -1;
    // Компоненты — объявлены для читаемости и статического анализа.
    this.currentStaffSelect = null;
    this.repairPicker = null;
    this.noteField = null;
    this.noteSubmitBtn = null;
  }

  async mount(ticketId, combinedTicketsArray = []) {
    const myMountId = ++this._mountId;
    const isStale = () => this._mountId !== myMountId;

    this.currentTicketId = ticketId;
    this.state.clearDraft(); // Вместо this.state.clearDraft();
    this.state.setMode("view"); // Вместо this.mode = "view"

    const container = document.getElementById("ticketDetailsDynamicContainer");
    if (!container) return;

    if (String(ticketId).startsWith("offline_")) {
      const outbox = await offlineDB.getAllPending();
      if (isStale()) return;

      // getAllPending возвращает все записи. Фильтруем только нужный
      // CreateTicket со статусом 'pending'. Поле uuid теперь — command_uuid.
      const found = outbox.find(
        (o) =>
          o.command_type === "CreateTicket" &&
          o.status === "pending" &&
          (o.offline_uuid === ticketId || o.command_uuid === ticketId),
      );
      // ... (блок offline_ заявок) ...
      if (found) {
        const offlineTicket = {
          ...found.payload,
          id: found.offline_uuid || found.command_uuid,
          isOffline: true,
          date: found.created_at,
        };
        this.state.setServerTicket(offlineTicket, []); // Сохраняем в стейт
        this._renderCard(container);
        return;
      }
    }

    let ticket = combinedTicketsArray.find(
      (t) => String(t.id) === String(ticketId),
    );
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
    this._serverTicket = normalizeTicketFields({
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
    this.state.setServerTicket(this._serverTicket, cmds);

    this._renderCard(container);
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
    destroyVoiceInput();
    // Полная перерисовка: все DOM-узлы внутри container уничтожаются
    // через innerHTML. Но созданные компоненты (noteField, select'ы,
    // voiceInput на textarea, слушатели на document) продолжают жить
    // на detached-узлах. Dispose до замены DOM.
    [
      this.noteField,
      this.deptSelect,
      this.reqSelect,
      this.groupSelect,
      this.repairPicker,
      this.currentStaffSelect,
    ].forEach((comp) => {
      if (comp && typeof comp.destroy === "function") comp.destroy();
    });
    this.noteField = null;
    this.noteSubmitBtn = null;
    this.deptSelect = null;
    this.reqSelect = null;
    this.groupSelect = null;
    this.repairPicker = null;
    this.currentStaffSelect = null;

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

    container.innerHTML = `
            <div class="ticket-card-layout-grid">
                <div class="ticket-info-panel" style="background: var(--bg-secondary); border: 2px solid var(--border-color); border-radius: 12px; padding: 1.25rem 1rem 0.75rem; display: flex; flex-direction: column; gap: 0.75rem; overflow: visible; height: 100%; min-height: 0; position: relative;">
                    <div style="position: absolute; top: 0; left: 0; right: 0; transform: translateY(-50%); display: flex; justify-content: space-between; align-items: center; padding: 0 1.25rem; gap: 8px; z-index: 5;">
                        <h2 style="font-size: 1.1rem; font-weight: 700; background: var(--bg-primary); padding: 0 0.5rem; line-height: 1; margin: 0;">Заявка №${escapeHtml(t.id)}</h2>
                        <span style="font-size: 11px; font-weight: 700; padding: 2px 10px; border-radius: 20px; background: ${statusBg}; color: ${statusColor}; border: 2px solid var(--bg-primary);">${statusLabel}</span>
                    </div>

                    <div class="info-group" style="flex-shrink: 0;">
                        <label style="font-size: 11px; font-weight: 700; color: var(--text-secondary); text-transform: uppercase;">📍 Адрес объекта</label>
                        <div style="font-size: 15px; font-weight: 600; margin-top: 2px; white-space: normal;">${escapeHtml(t.fullAddress || t.address || "—")}</div>
                    </div>

                    ${
                      isOffline
                        ? `
                    <div style="background: rgba(245, 158, 11, 0.15); border: 1px solid #f59e0b; border-radius: 8px; padding: 10px; color: #d97706; font-size: 13px; font-weight: 600; text-align: center; margin-top: 5px;">
                        ⏳ Заявка ожидает синхронизации с сервером. Редактирование недоступно.
                    </div>`
                        : ""
                    }
                    ${
                      pendingClose && !isOffline
                        ? `
                    <div style="background: rgba(245, 158, 11, 0.15); border: 1px solid #f59e0b; border-radius: 8px; padding: 10px; color: #d97706; font-size: 13px; font-weight: 600; text-align: center; margin-top: 5px;">
                        ⏳ Закрыта локально. Ожидает синхронизации с сервером.
                    </div>`
                        : ""
                    }
                    ${
                      hasPendingEdit && !pendingClose && !isOffline
                        ? `
                    <div style="background: rgba(99, 102, 241, 0.1); border: 1px solid var(--accent); border-radius: 8px; padding: 8px 10px; color: var(--accent); font-size: 12px; font-weight: 600; text-align: center; margin-top: 5px;">
                        ⏳ Есть неотправленные изменения. Синхронизируются при восстановлении сети.
                    </div>`
                        : ""
                    }
                    ${
                      hasPendingComment &&
                      !hasPendingEdit &&
                      !pendingClose &&
                      !isOffline
                        ? `
                    <div style="background: rgba(99, 102, 241, 0.08); border-radius: 6px; padding: 6px 8px; color: var(--text-secondary); font-size: 11px; text-align: center; margin-top: 5px;">
                        ⏳ Есть неотправленный комментарий.
                    </div>`
                        : ""
                    }
                        
                    <div id="ticketScrollArea" style="flex: 1 1 auto; min-height: 0; overflow-y: auto; display: flex; flex-direction: column; gap: 1rem; padding-right: 6px;">
                        <div id="ticketBodyBlock" style="display: flex; flex-direction: column; gap: 1rem;">
                            <div class="info-group">
                                <label style="font-size: 11px; font-weight: 700; color: var(--text-secondary); text-transform: uppercase;">🚨 Описание проблемы</label>
                                <div id="detailsDisplay" style="font-size: 14px; margin-top: 2px; background: var(--bg-primary); padding: 10px; border-radius: 8px; border: 1px solid var(--border-color); white-space: pre-wrap;">${escapeHtml(t.details || "Описание отсутствует.")}</div>
                                <div id="detailsAddBlock" style="display: none; margin-top: 8px;">
                                    <textarea id="newDetailsInput" class="search-input editable-field" rows="3" placeholder="Введите дополнение к описанию..." style="width: 100%; resize: vertical; font-family: inherit;"></textarea>
                                    <div id="capsWarnDetails" style="display: none; color: #ef4444; font-size: 12px; margin-top: 4px;">⚠️ Слишком много заглавных букв подряд (максимум 4)</div>
                                    <button id="addDetailsBtn" class="menu-item" style="margin-top: 6px; padding: 6px 12px; border-radius: 6px; border: 1px solid var(--border-color); background: var(--bg-primary); color: var(--text-primary); cursor: pointer;">+ Добавить описание заявки</button>
                                </div>
                            </div>

                            <div class="info-group" id="staffAssignmentsBlock">
                                <label style="font-size: 11px; font-weight: 700; color: var(--text-secondary); text-transform: uppercase;">👷 Ответственные</label>
                                <div id="staffSlotsContainer" style="display: flex; flex-direction: column; gap: 8px; margin-top: 6px;"></div>
                            </div>

                            <div style="display: grid; grid-template-columns: 1fr 1fr; gap: 1rem;">
                                <div class="info-group">
                                    <label style="font-size: 11px; font-weight: 700; color: var(--text-secondary); text-transform: uppercase;">📅 Дата регистрации</label>
                                    <div style="font-size: 14px; margin-top: 2px;">${formatTs(t.date)}</div>
                                </div>
                                <div class="info-group">
                                    <label style="font-size: 11px; font-weight: 700; color: var(--text-secondary); text-transform: uppercase;">🛠 Дата ремонта</label>
                                    <div id="repairTimeDisplay" style="font-size: 14px; margin-top: 2px;">${formatTs(t.repair_time)}</div>
                                    <div id="repairTimeEditBlock" style="display: none; margin-top: 6px;"></div>
                                </div>
                            </div>

                            <div style="display: flex; flex-direction: column; gap: 1rem;">
                                <div class="info-group">
                                    <label style="font-size: 11px; font-weight: 700; color: var(--text-secondary); text-transform: uppercase;">🏢 Отдел</label>
                                    <div id="deptDisplay" style="font-size: 14px; margin-top: 2px;">${escapeHtml(t.department || "—")}</div>
                                    <div id="deptEditBlock" style="display: none; margin-top: 6px;"></div>
                                </div>
                                <div class="info-group">
                                    <label style="font-size: 11px; font-weight: 700; color: var(--text-secondary); text-transform: uppercase;">📋 Тип запроса</label>
                                    <div id="reqDisplay" style="font-size: 14px; margin-top: 2px;">${escapeHtml(t.request || "—")}</div>
                                    <div id="reqEditBlock" style="display: none; margin-top: 6px;"></div>
                                </div>
                                <div class="info-group">
                                    <label style="font-size: 11px; font-weight: 700; color: var(--text-secondary); text-transform: uppercase;">📦 Группа</label>
                                    <div id="groupDisplay" style="font-size: 14px; margin-top: 2px;">${escapeHtml(t.group || "—")}</div>
                                    <div id="groupEditBlock" style="display: none; margin-top: 6px;"></div>
                                </div>
                            </div>

                            ${
                              isClosed
                                ? `
                            <div class="info-group" style="border-top: 1px dashed var(--border-color); padding-top: 1rem;">
                                <label style="font-size: 11px; font-weight: 700; color: #22c55e; text-transform: uppercase;">
                                    ${pendingClose ? "⏳ Решение (ожидает синхронизации)" : "✅ Принятое решение"}
                                </label>
                                <div style="font-size: 14px; margin-top: 2px; font-weight: 500; white-space: pre-wrap;">${escapeHtml(solutionText || "—")}</div>
                                
                                <div style="font-size: 13px; color: var(--text-secondary); margin-top: 8px;">
                                    Закрыл: <b>${escapeHtml(closeName)}</b> · ${formatTs(closeDate)}
                                </div>

                                ${
                                  pendingClose
                                    ? `
                                <div style="margin-top: 8px; padding: 8px; border-radius: 6px; background: rgba(245,158,11,0.08); border: 1px solid #f59e0b; color: #d97706; font-size: 12px;">
                                    Действие будет синхронизировано при восстановлении сети.
                                </div>`
                                    : ""
                                }

                                ${
                                  !pendingClose &&
                                  userStore.isAdmin() &&
                                  t.full_history
                                    ? `
                                <details style="margin-top: 12px; border: 1px solid var(--border-color); border-radius: 6px; background: var(--bg-primary);">
                                    <summary style="cursor: pointer; font-size: 12px; font-weight: 600; padding: 8px 12px; user-select: none; outline: none;">📜 Показать полную историю</summary>
                                    <div style="font-size: 12px; padding: 0 12px 12px; white-space: pre-wrap; color: var(--text-secondary);">${formatFullHistory(t.full_history)}</div>
                                </details>
                                `
                                    : ""
                                }
                            </div>`
                                : ""
                            }
                        </div> <!-- ⬅️ КОНЕЦ ticketBodyBlock -->

                        <div id="closeBlock" style="display: none; border-top: 1px dashed var(--border-color); padding-top: 1rem;">
                            <label style="font-size: 11px; font-weight: 700; color: #22c55e; text-transform: uppercase;">🔒 Решение по заявке</label>
                            <textarea id="solutionInput" class="search-input" rows="3" placeholder="Опишите, что было сделано (минимум ${MIN_SOLUTION_LEN} символов)..." style="width: 100%; resize: vertical; margin-top: 4px; font-family: inherit;"></textarea>
                            <div id="capsWarnSolution" style="display: none; color: #ef4444; font-size: 12px; margin-top: 4px;">⚠️ Слишком много заглавных букв подряд (максимум 4)</div>

                            <label id="closeAndCreateWrap" class="editable-field editable-field--checkbox" style="display: inline-flex; align-items: center; gap: 8px; margin-top: 10px; cursor: pointer; font-size: 13px; width: fit-content;">
                                <input type="checkbox" id="closeAndCreateCheck" style="cursor: pointer;">
                                <span>Закрыть и создать новую для этого объекта</span>
                            </label>
                        </div>
                        <div id="editErrorBanner" style="display: none; padding: 8px 12px; background: rgba(239,68,68,0.1); border: 1px solid #ef4444; border-radius: 8px; color: #ef4444; font-size: 13px;"></div>
                    </div> <!-- ⬅️ КОНЕЦ ticketScrollArea -->

                    <div class="ticket-actions-footer">
                        <button class="menu-item" id="backBtn" style="border: 2px solid var(--border-color); background: var(--bg-primary); color: var(--text-primary); padding: 10px; border-radius: 8px; cursor: pointer; font-weight: 600;">← Вернуться в журнал</button>
                        ${!isOffline && isOpen && canEdit ? `<button class="menu-item" id="editBtn" style="border: 2px solid var(--border-color); background: var(--bg-primary); color: var(--text-primary); padding: 10px; border-radius: 8px; cursor: pointer; font-weight: 600;">✏️ Редактировать</button>` : ""}
                        ${!isOffline && canClose ? `<button class="menu-item" id="closeBtn" style="border: 2px solid var(--border-color); background: var(--bg-primary); color: var(--text-primary); padding: 10px; border-radius: 8px; cursor: pointer; font-weight: 600;">🔒 Закрыть заявку</button>` : ""}

                        <button class="menu-item " id="saveBtn" hidden disabled style="border: none; background: var(--accent); color: var(--mark-text); padding: 10px; border-radius: 8px; cursor: pointer; font-weight: 700;">Сохранить</button>
                        <button class="menu-item hide-action-btn" id="cancelEditBtn" style="border: 2px solid var(--border-color); background: var(--bg-primary); color: var(--text-primary); padding: 10px; border-radius: 8px; cursor: pointer; font-weight: 600;">Отмена</button>
                    </div>
                </div>

                <div class="ticket-notes-panel" style="background: var(--bg-secondary); border: 2px solid var(--border-color); border-radius: 12px; padding: 1.5rem; display: flex; flex-direction: column; min-height: 0; height: 100%; overflow: visible;">
                    <h3 style="font-size: 1.25rem; border-bottom: 2px solid var(--border-color); padding-bottom: 0.75rem; margin-bottom: 1rem; display: flex; align-items: center; justify-content: space-between; flex-shrink: 0;">
                        <span>📝 Комментарии к заявке</span>
                        <span id="notesCountBadge" style="font-size: 12px; background: var(--border-color); padding: 2px 8px; border-radius: 10px; font-weight: 600;">0</span>
                    </h3>
                    <div id="notesContainerDOM" style="flex: 1; overflow-y: auto; display: flex; flex-direction: column; gap: 10px; padding-right: 5px; margin-bottom: 8px; min-height: 0;"></div>

                                       <!-- Поле ввода показываем только для открытых заявок -->
                    ${
                      !isClosed
                        ? `
                    <div id="noteComposer" style="border-top: 1px dashed var(--border-color); padding-top: 10px; flex-shrink: 0; display: flex; flex-direction: column;"></div>
                    `
                        : ""
                    }
                </div>
            </div>
        `;

    this._renderStaffSlots();
    this._renderNotesList(t.note || []);
    this._renderNoteComposer();
    this._bindEvents();
  }

  _getStaffSlots() {
    const t = this.ticket;
    return [
      {
        slot: 1,
        id: t.staff_id,
        name: t.staff_name,
        notifyStatus: t.notify_status,
        notifyDate: t.notify_date,
      },
      {
        slot: 2,
        id: t.staff_id2,
        name: t.staff_name2,
        notifyStatus: t.notify_status2,
        notifyDate: t.notify_date2,
      },
      {
        slot: 3,
        id: t.staff_id3,
        name: t.staff_name3,
        notifyStatus: t.notify_status3,
        notifyDate: t.notify_date3,
      },
    ];
  }

  _slotLabel(slotNumber) {
    if (slotNumber === 1) return "Ответственный 1";
    return "Доп. ответственный " + slotNumber;
  }

  _renderStaffSlots() {
    const container = document.getElementById("staffSlotsContainer");
    if (!container) return;

    if (this.ticket.type === "close") {
      const slots = this._getStaffSlots().filter((s) => s.id);
      if (slots.length === 0) {
        container.innerHTML =
          '<div style="font-size: 13px; color: var(--text-secondary); font-style: italic;">Нет данных об ответственных</div>';
        return;
      }
      const list = document.createElement("div");
      list.style.cssText =
        "font-size: 14px; line-height: 1.6; font-weight: 500; color: var(--text-primary);";
      slots.forEach((slot) => {
        const status = getStatusWord(slot.notifyStatus);
        const div = document.createElement("div");
        div.textContent = `• ${slot.name} (${status})`;
        list.appendChild(div);
      });
      container.innerHTML = "";
      container.appendChild(list);
      return;
    }

    if (
      this.currentStaffSelect &&
      typeof this.currentStaffSelect.destroy === "function"
    ) {
      this.currentStaffSelect.destroy();
      this.currentStaffSelect = null;
    }

    container.innerHTML = "";

    const slots = this._getStaffSlots();
    const isOpen = this.ticket.type !== "close";
    const isEdit = this.state.mode === "edit";
    const isAdmin = userStore.isAdmin();
    const canAssign = isOpen && userStore.can("assign_staff");
    const isSessionLocked = this._staffChangedInSession;
    const isGridLocked = !!document.querySelector(
      ".ticket-card-layout-grid.card-locked",
    );

    const filled = slots.map((slot, idx) => {
      const keyId = "staff_id" + (idx === 0 ? "" : idx + 1);
      if (keyId in this.state.draft) {
        return !!this.state.draft[keyId];
      }
      return !!slot.id;
    });

    const visible = slots.map((_, idx) => {
      if (filled[idx]) return true;
      for (let i = 0; i < idx; i++) {
        if (!filled[i]) return false;
      }
      return true;
    });

    let firstEmptyIdx = -1;
    for (let i = 0; i < slots.length; i++) {
      if (visible[i] && !filled[i]) {
        firstEmptyIdx = i;
        break;
      }
    }

    slots.forEach((slot, idx) => {
      if (!visible[idx]) return;
      const slotNumber = idx + 1;

      if (filled[idx]) {
        this._renderFilledSlot(container, slot, slotNumber, {
          isOpen,
          isEdit,
          isAdmin,
          canAssign,
          isGridLocked,
        });
      } else {
        this._renderEmptySlot(container, slotNumber, idx, {
          isEdit,
          canAssign,
          isSessionLocked,
          isGridLocked,
          firstEmptyIdx,
        });
      }
    });

    if (
      this._autoOpenPending &&
      isEdit &&
      firstEmptyIdx === 0 &&
      canAssign &&
      !isGridLocked
    ) {
      this._autoOpenPending = false;
      setTimeout(() => this._openAssignForm(1), 0);
    }
  }

  _renderFilledSlot(container, slot, slotNumber, ctx) {
    const { isOpen, isEdit, isAdmin, canAssign, isGridLocked } = ctx;
    const suffix = slotNumber === 1 ? "" : slotNumber;

    const row = document.createElement("div");
    row.style.cssText =
      "display: flex; flex-direction: column; gap: 4px; padding: 8px 10px; border-radius: 8px; border: 1px solid var(--border-color); background: var(--bg-primary);";

    const head = document.createElement("div");
    head.style.cssText =
      "display: flex; justify-content: space-between; align-items: center; gap: 8px;";

    const phoneFromTicket = this.ticket["staff_phone" + suffix];
    const phone = phoneFromTicket || staffStore.getPhone(slot.id);

    const nameEl = document.createElement("span");
    nameEl.style.cssText = "font-weight: 600; font-size: 14px;";
    nameEl.textContent = (slotNumber === 1 ? "★ " : "· ") + (slot.name || "—");
    if (phone) {
      nameEl.title = "📞 " + phone;
      nameEl.style.cursor = "help";
    }
    head.appendChild(nameEl);

    const labelEl = document.createElement("span");
    labelEl.style.cssText = "font-size: 11px; color: var(--text-secondary);";
    labelEl.textContent = this._slotLabel(slotNumber);
    head.appendChild(labelEl);

    row.appendChild(head);

    const status = document.createElement("div");
    status.style.cssText = "font-size: 12px; color: var(--text-secondary);";
    const channel = NOTIFY_CHANNELS[slot.notifyStatus] || "— Не уведомлён —";

    if (!slot.notifyStatus) {
      status.textContent = "— Не уведомлён —";
    } else if (slot.notifyDate) {
      status.textContent = `${channel} · ${formatTs(slot.notifyDate)}`;
    } else {
      status.textContent = `${channel} · будет зафиксировано при сохранении`;
      status.style.fontStyle = "italic";
      status.style.color = "var(--accent)";
    }
    row.appendChild(status);

    const keyStaffId = "staff_id" + suffix;
    const isNewlyAssigned = keyStaffId in this.state.draft;

    // ИСПРАВЛЕНО: Синтаксическая ошибка (добавлено продолжение условия)
    // Два состояния:
    //   1. Уже уведомлён (notify_status = 1) — индикатор «✅ Уведомлён (дата)».
    //      Снять нельзя: факт уведомления исторический.
    //   2. Не уведомлён — чекбокс для установки. Снять (обратно в 0)
    //      нельзя — сервер воспринимает 1 как факт, откат некорректен.
    // notify_status === 1 уже показан выше блоком `status`
    // («📞 По телефону · 02.11.2026 14:30»). Дополнительный индикатор
    // «✅ Уведомлён» был бы дублированием. Показываем чекбокс только
    // когда ответственный ещё не уведомлён.
    if (!slot.notifyStatus) {
      const notifyEditable =
        isEdit && (isAdmin || (isNewlyAssigned && canAssign));

      if (notifyEditable) {
        const notifyWrap = document.createElement("label");
        notifyWrap.className = "editable-field editable-field--checkbox";
        notifyWrap.style.cssText =
          "display: inline-flex; align-items: center; gap: 8px; margin-top: 6px; cursor: pointer; font-size: 12px; width: fit-content;";

        const cb = document.createElement("input");
        cb.type = "checkbox";
        cb.style.cursor = "pointer";
        cb.checked = false;

        const txt = document.createElement("span");
        txt.textContent = "Уведомлён по телефону";

        cb.onchange = () => {
          // Только установка в 1. Снятие не предусмотрено —
          // сервер воспринимает 1 как факт, откат некорректен.
          if (!cb.checked) return;
          const keyNotify = "notify_status" + suffix;
          const keyNotifyDate = "notify_date" + suffix;
          this.state.updateDraft(keyNotify, 1);
          this.state.updateDraft(keyNotifyDate, nowTs());
          this._renderStaffSlots();
          this._updateSaveButtonState();
        };

        notifyWrap.appendChild(cb);
        notifyWrap.appendChild(txt);
        row.appendChild(notifyWrap);
      }
    }
    const canReplace =
      isEdit && !isGridLocked && (isAdmin || (isNewlyAssigned && canAssign));
    const canUnassign = isEdit && !isGridLocked && isAdmin;

    if (canReplace || canUnassign) {
      const actionsRow = document.createElement("div");
      actionsRow.style.cssText = "display: flex; gap: 6px; margin-top: 6px;";

      if (canReplace) {
        const replaceBtn = document.createElement("button");
        replaceBtn.textContent = "✏️ Заменить";
        replaceBtn.style.cssText =
          "padding: 4px 10px; border-radius: 6px; border: 1px solid var(--border-color); background: var(--bg-secondary); color: var(--text-primary); cursor: pointer; font-size: 11px;";
        replaceBtn.onclick = () => this._openReplaceForm(slotNumber);
        actionsRow.appendChild(replaceBtn);
      }

      if (canUnassign) {
        const unassignBtn = document.createElement("button");
        unassignBtn.textContent = "× Снять";
        unassignBtn.style.cssText =
          "padding: 4px 10px; border-radius: 6px; border: 1px solid #ef4444; background: transparent; color: #ef4444; cursor: pointer; font-size: 11px;";
        unassignBtn.onclick = () => this._onUnassignStaff(slotNumber);
        actionsRow.appendChild(unassignBtn);
      }

      row.appendChild(actionsRow);
    }

    container.appendChild(row);
  }

  _renderEmptySlot(container, slotNumber, idx, ctx) {
    const { isEdit, canAssign, isSessionLocked, isGridLocked, firstEmptyIdx } =
      ctx;

    const row = document.createElement("div");
    row.classList.add("staff-slot-empty");
    row.style.cssText =
      "display: flex; flex-direction: column; gap: 4px; padding: 8px 10px; border-radius: 8px; border: 1px solid var(--border-color); background: var(--bg-primary);";

    const head = document.createElement("div");
    head.style.cssText =
      "display: flex; justify-content: space-between; align-items: center; gap: 8px;";
    head.innerHTML = `
            <span style="font-size: 13px; font-weight: 600; color: var(--text-secondary);">${this._slotLabel(slotNumber)}</span>
            <span class="staff-slot-empty-label" style="font-size: 11px; font-style: italic;">не назначен</span>
        `;
    row.appendChild(head);

    const canAddHere =
      isEdit &&
      canAssign &&
      !isSessionLocked &&
      !isGridLocked &&
      idx === firstEmptyIdx;

    if (canAddHere) {
      const addBtn = document.createElement("button");
      addBtn.textContent = "+ Добавить";
      addBtn.style.cssText =
        "margin-top: 4px; padding: 6px 10px; border-radius: 6px; border: 1px solid var(--border-color); background: var(--bg-secondary); color: var(--text-primary); cursor: pointer; font-size: 12px;";
      addBtn.onclick = () => this._openAssignForm(slotNumber);
      row.appendChild(addBtn);
    }

    container.appendChild(row);
  }

  _onUnassignStaff(slotNumber) {
    const suffix = slotNumber === 1 ? "" : slotNumber;
    const keyId = "staff_id" + suffix;
    const keyName = "staff_name" + suffix;
    const keyPhone = "staff_phone" + suffix;
    const keyNotify = "notify_status" + suffix;
    const keyNotifyDate = "notify_date" + suffix;

    this.state.updateDraft(keyId, null);
    this.state.updateDraft(keyName, null);
    this.state.updateDraft(keyPhone, null);
    this.state.updateDraft(keyNotify, 0);
    this.state.updateDraft(keyNotifyDate, null);
    this._staffChangedInSession = true;

    this._renderStaffSlots();
    this._updateSaveButtonState();
  }

  _openReplaceForm(slotNumber) {
    this._openAssignForm(slotNumber);
  }

  _openAssignForm(slotNumber) {
    const container = document.getElementById("staffSlotsContainer");
    // Guard: setTimeout(() => this._openAssignForm(1), 0) может
    // сработать после unmount (контейнера нет).
    if (!container) return;

    const slots = this._getStaffSlots();
    const busyIds = slots
      .filter((s) => s.slot !== slotNumber && s.id)
      .map((s) => s.id);

    const rowIdx = slotNumber - 1;
    const row = container.children[rowIdx];
    if (!row) return;

    if (
      this.currentStaffSelect &&
      typeof this.currentStaffSelect.destroy === "function"
    ) {
      this.currentStaffSelect.destroy();
    }

    row.innerHTML = "";

    const notifyWrap = document.createElement("label");
    notifyWrap.className = "editable-field editable-field--checkbox";
    notifyWrap.style.cssText =
      "display: none; align-items: center; gap: 8px; margin-top: 6px; cursor: pointer; font-size: 13px;";

    const notifyCheck = document.createElement("input");
    notifyCheck.type = "checkbox";
    notifyCheck.style.cursor = "pointer";

    const notifyText = document.createElement("span");
    notifyText.textContent = "Уведомлён по телефону";

    notifyWrap.appendChild(notifyCheck);
    notifyWrap.appendChild(notifyText);

    const staffSelect = createStaffSelect({
      list: staffStore.list,
      excludeIds: busyIds,
      placeholder: "Начните вводить имя...",
      onSelect: (staff) => {
        const suffix = slotNumber === 1 ? "" : slotNumber;
        const keyId = "staff_id" + suffix;
        const isNewOrReassign =
          !this.ticket[keyId] || keyId in this.state.draft;
        if (staff && isNewOrReassign) {
          notifyWrap.style.display = "inline-flex";
        } else {
          notifyWrap.style.display = "none";
          notifyCheck.checked = false;
        }
      },
    });
    this.currentStaffSelect = staffSelect;

    const confirmBtn = document.createElement("button");
    confirmBtn.textContent = "Подтвердить";
    confirmBtn.style.cssText =
      "margin-top: 6px; padding: 6px 10px; border-radius: 6px; border: none; background: var(--accent); color: var(--mark-text); cursor: pointer; font-size: 12px; font-weight: 600;";

    confirmBtn.onclick = () => {
      const selectedId = staffSelect.getValue();
      if (!selectedId) return;

      const suffix = slotNumber === 1 ? "" : slotNumber;
      const keyId = "staff_id" + suffix;
      const keyNotify = "notify_status" + suffix;
      const keyNotifyDate = "notify_date" + suffix;
      const keyName = "staff_name" + suffix;

      const finalId = isNaN(selectedId) ? selectedId : Number(selectedId);
      this.state.updateDraft(keyId, finalId);
      this.state.updateDraft(
        keyName,
        staffStore.getById(selectedId)?.name || null,
      );

      if (notifyCheck.checked) {
        this.state.updateDraft(keyNotify, 1);
        this.state.updateDraft(keyNotifyDate, nowTs());
      }
      this._staffChangedInSession = true;
      this._autoOpenPending = false;

      staffSelect.destroy();
      this.currentStaffSelect = null;

      this._renderStaffSlots();
      this._updateSaveButtonState();
    };

    const cancelBtn = document.createElement("button");
    cancelBtn.textContent = "Отмена";
    cancelBtn.style.cssText =
      "margin-top: 6px; margin-left: 6px; padding: 6px 10px; border-radius: 6px; border: 1px solid var(--border-color); background: var(--bg-secondary); color: var(--text-primary); cursor: pointer; font-size: 12px;";
    cancelBtn.onclick = () => {
      staffSelect.destroy();
      this.currentStaffSelect = null;
      this._renderStaffSlots();
    };

    row.appendChild(staffSelect.element);
    row.appendChild(notifyWrap);
    row.appendChild(confirmBtn);
    row.appendChild(cancelBtn);

    setTimeout(() => {
      // Guard: после unmount this.currentStaffSelect уже не наш.
      if (staffSelect && this.currentStaffSelect === staffSelect) {
        staffSelect.focus();
      }
    }, 30);
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

    const addDetailsBtn = $("addDetailsBtn");
    if (addDetailsBtn) addDetailsBtn.onclick = () => this._onAddDescription();

    const newDetailsInput = $("newDetailsInput");
    if (newDetailsInput) {
      newDetailsInput.oninput = () =>
        this._checkCaps(newDetailsInput.value, $("capsWarnDetails"));
    }

    const solutionInput = $("solutionInput");
    if (solutionInput) {
      solutionInput.oninput = () => {
        this._checkCaps(solutionInput.value, $("capsWarnSolution"));
        this._updateSaveButtonState();
      };
    }

    $("saveBtn").onclick = () => this._onSave();
  }

  _enterEditMode() {
    this.state.setMode("edit");
    this.state.clearDraft(); // Начинаем с чистого листа

    this._staffChangedInSession = false;
    this._autoOpenPending = this.ticket.staff_id == null;

    document.getElementById("detailsAddBlock").style.display = "block";
    const editBtnRef = document.getElementById("editBtn");
    if (editBtnRef) editBtnRef.style.display = "none";
    const newDetailsInput = document.getElementById("newDetailsInput");
    if (newDetailsInput) initVoiceTextarea(newDetailsInput);
    const closeBtn = document.getElementById("closeBtn");
    if (closeBtn) closeBtn.style.display = "none";
    document.getElementById("saveBtn").hidden = false;
    document.getElementById("cancelEditBtn").style.display = "block";
    this._renderStaffSlots();

    const dictRules = [
      {
        key: "department",
        action: "change_department",
        idField: "department_id",
        ref: "deptSelect",
        blockId: "deptEditBlock",
        currentValue: this.ticket.department_id,
      },
      {
        key: "request",
        action: "change_request",
        idField: "request_id",
        ref: "reqSelect",
        blockId: "reqEditBlock",
        currentValue: this.ticket.request_id,
      },
      {
        key: "group",
        action: "change_group",
        idField: "group_id",
        ref: "groupSelect",
        blockId: "groupEditBlock",
        currentValue: this.ticket.group_id,
      },
    ];

    if (!navigator.onLine) {
      ["deptDisplay", "reqDisplay", "groupDisplay"].forEach((id) => {
        const el = document.getElementById(id);
        if (el) el.title = "🔒 Редактирование доступно только онлайн";
      });
    } else {
      dictRules.forEach((rule) => {
        if (!userStore.can(rule.action, { currentValue: rule.currentValue }))
          return;

        const block = document.getElementById(rule.blockId);
        if (!block) return;
        block.style.display = "block";

        if (!this[rule.ref]) {
          const comp = createDictSelect({
            key: rule.key,
            initialValue: rule.currentValue || null,
            placeholder: "— выберите —",
            required: true,
            onChange: (value) => {
              if (value) {
                this.state.updateDraft(rule.idField, String(value));
              } else {
                this.state.deleteDraft(rule.idField);
              }
              this._updateSaveButtonState();
            },
          });
          block.innerHTML = "";
          block.appendChild(comp.element);
          this[rule.ref] = comp;
        }
      });
    }

    const isAssigned = userStore.isAssignedTo(this.ticket, userStore.userId);
    if (userStore.can("set_repair_time", { isAssigned })) {
      const block = document.getElementById("repairTimeEditBlock");
      if (block) {
        block.style.display = "block";
        if (!this.repairPicker) {
          this.repairPicker = createRepairTimePicker({
            initialValue: this.ticket.repair_time,
            onChange: (value) => {
              this.state.updateDraft("repair_time", value);
              this._updateSaveButtonState();
            },
          });
          block.innerHTML = "";
          block.appendChild(this.repairPicker.element);
        }
      }
    }

    this._updateSaveButtonState();
  }

  _enterCloseMode() {
    this.state.setMode("close");

    const bodyBlock = document.getElementById("ticketBodyBlock");
    if (bodyBlock) bodyBlock.style.display = "none";

    document.getElementById("closeBlock").style.display = "block";
    const closeAndCreateCheck = document.getElementById("closeAndCreateCheck");
    if (closeAndCreateCheck) closeAndCreateCheck.checked = false;

    const solutionInput = document.getElementById("solutionInput");
    if (solutionInput) initVoiceTextarea(solutionInput);

    const editBtnRef = document.getElementById("editBtn");
    if (editBtnRef) editBtnRef.style.display = "none";
    const closeBtn = document.getElementById("closeBtn");
    if (closeBtn) closeBtn.style.display = "none";
    document.getElementById("saveBtn").hidden = false;
    document.getElementById("cancelEditBtn").style.display = "block";

    setTimeout(() => {
      const ta = document.getElementById("solutionInput");
      if (ta) ta.focus();
    }, 50);

    this._updateSaveButtonState();
  }

  _exitEditMode() {
    destroyVoiceInput();

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

    const newDetailsInput = document.getElementById("newDetailsInput");
    if (newDetailsInput) newDetailsInput.value = "";
    const solutionInput = document.getElementById("solutionInput");
    if (solutionInput) solutionInput.value = "";
    const capsWarnDetails = document.getElementById("capsWarnDetails");
    if (capsWarnDetails) capsWarnDetails.style.display = "none";
    const capsWarnSolution = document.getElementById("capsWarnSolution");
    if (capsWarnSolution) capsWarnSolution.style.display = "none";

    const display = document.getElementById("detailsDisplay");
    if (display)
      display.textContent = this.ticket.details || "Описание отсутствует.";

    const repairBlock = document.getElementById("repairTimeEditBlock");
    if (repairBlock) {
      repairBlock.style.display = "none";
      repairBlock.innerHTML = "";
    }
    if (this.repairPicker) {
      if (typeof this.repairPicker.destroy === "function")
        this.repairPicker.destroy();
      this.repairPicker = null;
    }

    [
      {
        blockId: "deptEditBlock",
        ref: "deptSelect",
        displayId: "deptDisplay",
        field: "department",
      },
      {
        blockId: "reqEditBlock",
        ref: "reqSelect",
        displayId: "reqDisplay",
        field: "request",
      },
      {
        blockId: "groupEditBlock",
        ref: "groupSelect",
        displayId: "groupDisplay",
        field: "group",
      },
    ].forEach((item) => {
      const block = document.getElementById(item.blockId);
      if (block) {
        block.style.display = "none";
        block.innerHTML = "";
      }
      if (this[item.ref]) {
        if (typeof this[item.ref].destroy === "function")
          this[item.ref].destroy();
        this[item.ref] = null;
      }
      const display = document.getElementById(item.displayId);
      if (display) display.textContent = this.ticket[item.field] || "—";
    });

    if (
      this.currentStaffSelect &&
      typeof this.currentStaffSelect.destroy === "function"
    ) {
      this.currentStaffSelect.destroy();
      this.currentStaffSelect = null;
    }

    const repairDisplay = document.getElementById("repairTimeDisplay");
    if (repairDisplay)
      repairDisplay.textContent = formatTs(this.ticket.repair_time);

    this._renderStaffSlots();
  }

  _onAddDescription() {
    const input = document.getElementById("newDetailsInput");
    const text = input.value.trim();
    if (!text || CAPS_REGEX.test(text)) return;

    // Сервер append-only: отправляем ТОЛЬКО новый текст, склеит сам
    const existing = this.state.draft.details || "";
    const separator = existing ? "\n\n" : "";
    const newDraftDetails = existing + separator + "📝 Дополнение: " + text;
    this.state.updateDraft("details", newDraftDetails);

    const display = document.getElementById("detailsDisplay");
    if (display) {
      const base = this.ticket.details || "";
      const sep = base ? "\n\n" : "";
      display.textContent = base + sep + newDraftDetails;
    }

    input.value = "";
    this._updateSaveButtonState();
  }

  _checkCaps(text, warnEl) {
    const hasCaps = CAPS_REGEX.test(text);
    if (warnEl) warnEl.style.display = hasCaps ? "block" : "none";
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

    const $ = (id) => document.getElementById(id);
    let enabled = false;

    if (this.state.mode === "edit") {
      const newDetails = $("newDetailsInput");
      const typed = newDetails ? newDetails.value.trim() : "";
      const hasUncommittedDetails = typed.length > 0 && !CAPS_REGEX.test(typed);

      // Кнопка «Сохранить» разблокирована, если в pendingChanges есть
      // изменения ИЛИ в newDetailsInput набран валидный текст без
      // нажатия «+ Добавить описание». _onSave подхватит его сам.
      enabled =
        Object.keys(this.state.draft).length > 0 || hasUncommittedDetails;
      if (newDetails && CAPS_REGEX.test(newDetails.value)) enabled = false;
      if (this.repairPicker && !this.repairPicker.isValid()) enabled = false;
      if (this.deptSelect && !this.deptSelect.isValid()) enabled = false;
      if (this.reqSelect && !this.reqSelect.isValid()) enabled = false;
      if (this.groupSelect && !this.groupSelect.isValid()) enabled = false;
    } else if (this.state.mode === "close") {
      const sol = $("solutionInput");
      const len = sol ? sol.value.trim().length : 0;
      enabled = len >= MIN_SOLUTION_LEN && !CAPS_REGEX.test(sol.value);
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

    if (this.noteSubmitBtn) this.noteSubmitBtn.disabled = true;

    if (this.noteField && this.noteField.element) {
      const ta = this.noteField.element.querySelector("textarea");
      if (ta) ta.disabled = true;
    }
  }

  _unlockCard() {
    const grid = document.querySelector(".ticket-card-layout-grid");
    if (grid) grid.classList.remove("card-locked");

    if (this.noteField && this.noteField.element) {
      const ta = this.noteField.element.querySelector("textarea");
      if (ta) ta.disabled = false;
    }

    if (this.noteField && this.noteSubmitBtn) {
      const val = this.noteField.getValue();
      const valid = this.noteField.isValid();
      this.noteSubmitBtn.disabled = !valid || !val;
    }
  }

  async _onSave() {
    if (this.state.mode === "edit" && !this.state.hasDraftChanges()) {
      // Не сохраняем пустые изменения, но проверяем несохранённый
      // текст в newDetailsInput — если он валиден, добавим в pending
      // и продолжим (иначе пользователь молча теряет ввод).
      const newDetailsEl = document.getElementById("newDetailsInput");
      const typed = newDetailsEl ? newDetailsEl.value.trim() : "";
      if (typed && !CAPS_REGEX.test(typed)) {
        this._onAddDescription();
      }
      if (!this.state.hasDraftChanges()) return;
    }

    // Перед сохранением забираем необработанный текст из newDetailsInput.
    // Раньше пользователь, набравший описание и не нажавший
    // «+ Добавить описание», терял его при «Сохранить».
    if (this.state.mode === "edit") {
      const newDetailsEl = document.getElementById("newDetailsInput");
      const typed = newDetailsEl ? newDetailsEl.value.trim() : "";
      if (typed && !CAPS_REGEX.test(typed)) {
        this._onAddDescription();
      }
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

    let payload;
    let response;
    this._lockCard();
    this._setSaveBtnState("loading");

    try {
      if (this.state.mode === "close") {
        const solutionText =
          document.getElementById("solutionInput")?.value.trim() || "";
        const user = userStore.userId || authStore.getUser()?.id || 0;
        response = await ticketRepository.saveClose(
          this.api,
          ticketId,
          solutionText,
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
          const closeAndCreateCheck = document.getElementById(
            "closeAndCreateCheck",
          );
          const shouldCreateNew =
            closeAndCreateCheck && closeAndCreateCheck.checked;

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

  _renderNotesList(notesData) {
    const containerDOM = document.getElementById("notesContainerDOM");
    const countBadge = document.getElementById("notesCountBadge");
    if (!containerDOM) return;

    const notesList = Array.isArray(notesData)
      ? notesData
      : notesData && typeof notesData === "object"
        ? Object.values(notesData)
        : [];

    if (countBadge) countBadge.textContent = notesList.length;

    if (notesList.length === 0) {
      containerDOM.innerHTML = `
                <div style="text-align: center; color: var(--text-secondary); margin: auto 0; padding: 2rem;">
                    <div style="font-size: 13px; font-weight: 500;">Комментарии к заявке отсутствуют</div>
                </div>`;
      return;
    }

    containerDOM.innerHTML = "";
    notesList.forEach((note) => {
      const noteItem = document.createElement("div");
      const isAccent = String(note.type) === "1";
      noteItem.style.cssText = `
                background: ${isAccent ? "rgba(138, 43, 226, 0.05)" : "var(--bg-primary)"};
                border: 1px solid ${isAccent ? "var(--accent)" : "var(--border-color)"};
                border-radius: 8px;
                padding: 10px 12px;
                display: flex;
                flex-direction: column;
                gap: 4px;
            `;

      const header = document.createElement("div");
      header.style.cssText =
        "display: flex; justify-content: space-between; align-items: center; border-bottom: 1px dashed var(--border-color); padding-bottom: 3px; margin-bottom: 2px;";

      const userSpan = document.createElement("span");
      userSpan.style.cssText = "font-size: 12px; font-weight: 700;";
      userSpan.textContent = "👤 " + (note.user || "Сотрудник не указан");

      const dateSpan = document.createElement("span");
      dateSpan.style.cssText =
        "font-size: 11px; color: var(--text-secondary); font-weight: 500;";
      dateSpan.textContent = "🕒 " + formatTs(note.date);

      header.appendChild(userSpan);
      header.appendChild(dateSpan);

      const body = document.createElement("div");
      body.style.cssText =
        "font-size: 13px; line-height: 1.4; white-space: pre-wrap; word-break: break-word;";
      body.textContent = note.body || "Пустая заметка.";

      noteItem.appendChild(header);
      noteItem.appendChild(body);
      containerDOM.appendChild(noteItem);
    });
  }

  _renderNoteComposer() {
    const container = document.getElementById("noteComposer");
    if (!container) return;

    container.innerHTML = "";

    // Сброс предыдущего blob URL при перерисовке композера
    this._revokePreviewBlob();

    this.noteField = createValidatedTextarea({
      placeholder: "Введите комментарий к заявке...",
      rows: 3,
      minLength: 1,
      voice: true,
      onChange: (value, isValid) => {
        if (this.noteSubmitBtn) {
          const enabled = isValid && !!value;
          this.noteSubmitBtn.disabled = !enabled;
          this.noteSubmitBtn.style.opacity = enabled ? "1" : "0.5";
          this.noteSubmitBtn.style.cursor = enabled ? "pointer" : "not-allowed";
        }
      },
    });

    const isOnline = navigator.onLine;

    const photoInput = document.createElement("input");
    photoInput.type = "file";
    photoInput.accept = "image/jpeg,image/png";
    photoInput.id = "notePhotoInput";
    photoInput.style.display = "none";
    if (!isOnline) photoInput.disabled = true;

    const photoPreview = document.createElement("div");
    photoPreview.id = "notePhotoPreview";
    photoPreview.style.cssText =
      "display: none; align-items: center; gap: 8px; margin-top: 8px; padding: 6px; background: var(--bg-primary); border: 1px solid var(--border-color); border-radius: 6px;";

    const photoPreviewImg = document.createElement("img");
    photoPreviewImg.alt = "Превью";
    photoPreviewImg.style.cssText =
      "max-height: 60px; max-width: 60px; object-fit: cover; border-radius: 4px;";

    const photoPreviewName = document.createElement("span");
    photoPreviewName.style.cssText =
      "font-size: 12px; color: var(--text-secondary); flex: 1; overflow: hidden; text-overflow: ellipsis; white-space: nowrap;";

    const photoClearBtn = document.createElement("button");
    photoClearBtn.type = "button";
    photoClearBtn.textContent = "×";
    photoClearBtn.title = "Убрать фото";
    photoClearBtn.style.cssText =
      "padding: 2px 8px; border-radius: 4px; border: 1px solid var(--border-color); background: transparent; color: var(--text-primary); cursor: pointer; font-size: 16px; line-height: 1;";
    photoClearBtn.onclick = () => {
      this._revokePreviewBlob();
      photoInput.value = "";
      photoPreview.style.display = "none";
    };

    photoPreview.appendChild(photoPreviewImg);
    photoPreview.appendChild(photoPreviewName);
    photoPreview.appendChild(photoClearBtn);

    photoInput.onchange = () => {
      // Освобождаем предыдущий URL ДО создания нового
      this._revokePreviewBlob();

      const file = photoInput.files && photoInput.files[0];
      if (!file) {
        photoPreview.style.display = "none";
        return;
      }

      photoPreviewName.textContent =
        file.name + " (" + Math.round(file.size / 1024) + " КБ)";

      const url = URL.createObjectURL(file);
      this._previewBlobUrl = url;

      photoPreviewImg.onload = () => {
        // Превью загружено — URL больше не нужен для декодирования,
        // но оставляем живым пока превью отображается.
        // Очистка произойдёт при замене/unmount/ошибке.
      };

      photoPreviewImg.onerror = () => {
        // Ошибка загрузки — освобождаем немедленно
        this._revokePreviewBlob();
        photoPreview.style.display = "none";
      };

      photoPreviewImg.src = url;
      photoPreview.style.display = "flex";
    };

    const attachBtn = document.createElement("button");
    attachBtn.type = "button";
    attachBtn.textContent = "📎 Прикрепить фото";
    attachBtn.style.cssText =
      "margin-top: 8px; align-self: flex-start; padding: 6px 12px; border-radius: 6px; border: 1px solid var(--border-color); background: var(--bg-secondary); color: var(--text-primary); cursor: pointer; font-size: 12px;";
    if (!isOnline) {
      attachBtn.disabled = true;
      attachBtn.style.opacity = "0.5";
      attachBtn.style.cursor = "not-allowed";
      attachBtn.title = "Фото доступно только онлайн";
    } else {
      attachBtn.onclick = () => photoInput.click();
    }

    const submitBtn = document.createElement("button");
    submitBtn.textContent = "Добавить комментарий";
    submitBtn.disabled = true;
    submitBtn.style.cssText =
      "align-self: flex-end; margin-top: 8px; padding: 8px 16px; border-radius: 6px; border: none; background: var(--accent); color: var(--mark-text); cursor: not-allowed; font-size: 13px; font-weight: 600; opacity: 0.5; transition: all 0.2s ease;";
    submitBtn.onclick = () => this._onAddNote();

    this.noteSubmitBtn = submitBtn;

    container.appendChild(this.noteField.element);
    container.appendChild(photoInput);
    container.appendChild(attachBtn);
    container.appendChild(photoPreview);
    container.appendChild(submitBtn);
  }

  /**
   * Безопасное освобождение blob URL превью фото.
   * Вызывается при: замене файла, ошибке загрузки, очистке, unmount.
   */
  _revokePreviewBlob() {
    if (this._previewBlobUrl) {
      URL.revokeObjectURL(this._previewBlobUrl);
      this._previewBlobUrl = null;
    }
  }
  async _onAddNote() {
    const text = this.noteField ? this.noteField.getValue() : "";
    if (!text) return;
    if (this.noteField && !this.noteField.isValid()) return;

    // Офлайн — сразу в outbox (как было).
    if (!navigator.onLine) {
      const fileInput = document.getElementById("notePhotoInput");
      const file = fileInput && fileInput.files && fileInput.files[0];
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

    const btn = this.noteSubmitBtn;
    const fileInput = document.getElementById("notePhotoInput");
    const file = fileInput && fileInput.files && fileInput.files[0];

    let photoBase64 = null;
    if (file) {
      if (btn) {
        btn.disabled = true;
        btn.textContent = "Сжатие фото...";
        btn.style.opacity = "0.7";
      }
      try {
        const compressed = await compressPhoto(file);
        photoBase64 = compressed.base64;
      } catch (err) {
        console.error("[DetailsController] Photo compress error:", err);
        if (!this.ticket) return;
        notify.error("Фото не прикреплено: " + err.message);
        if (btn) {
          btn.disabled = false;
          btn.textContent = "Добавить комментарий";
          btn.style.opacity = "1";
        }
        return;
      }
    }

    // ...
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
        // Fallback в outbox мог бы продублировать комментарий, если
        // онлайн-запрос уже прошёл, а ответ потерялся. Показываем
        // ошибку — текст остаётся в композере (this.noteField не сброшен),
        // пользователь может повторить вручную. См. TD-SYNC-01.
        notify.error(
          "Не удалось отправить: нет связи с сервером. Проверьте соединение и повторите.",
        );
        if (btn) {
          btn.textContent = "Добавить комментарий";
          btn.disabled = false;
          btn.style.opacity = "1";
        }
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

        if (Array.isArray(this.ticket.note)) {
          this.ticket.note.push(note);
        } else if (this.ticket.note && typeof this.ticket.note === "object") {
          this.ticket.note[Object.keys(this.ticket.note).length + 1] = note;
        } else {
          this.ticket.note = [note];
        }

        this._renderNotesList(this.ticket.note);
        this.noteField.reset();
        if (fileInput) fileInput.value = "";
        const preview = document.getElementById("notePhotoPreview");
        if (preview) preview.style.display = "none";
        if (btn) {
          btn.textContent = "Добавить комментарий";
          btn.disabled = true;
          btn.style.opacity = "0.5";
        }
      } else {
        const msg =
          (response && response.message) || "Не удалось добавить комментарий.";
        logHistoryAction(msg);
        notify.error(msg);
        if (btn) {
          btn.textContent = "Добавить комментарий";
          btn.disabled = false;
          btn.style.opacity = "1";
        }
      }
    } catch (err) {
      console.error("[DetailsController] AddNote error:", err);
      if (!this.ticket || this.ticket.id !== ticketId) return;
      logHistoryAction("Сбой сети при добавлении комментария.");
      notify.error("Не удалось добавить комментарий. Проверьте соединение.");
      if (btn) {
        btn.textContent = "Добавить комментарий";
        btn.disabled = false;
        btn.style.opacity = "1";
      }
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
      const cmds = await outboxQueue.getPendingByTicket(ticketId);
      this.state.setPendingCommands(cmds);
      if (!this.ticket || this.ticket.id !== ticketId) return;

      // Не _renderCard: при mode='edit'/'close' полная перерисовка
      // сбросит открытую форму, оставив mode/pendingChanges.
      // Достаточно обновить список заметок.
      this._renderNotesList(this.ticket.note || []);
      if (this.noteSubmitBtn) {
        this.noteSubmitBtn.textContent = "Добавить комментарий";
        this.noteSubmitBtn.disabled = true;
        this.noteSubmitBtn.style.opacity = "0.5";
      }
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
      const cmds = await outboxQueue.getPendingByTicket(ticketId);
      this.state.setPendingCommands(cmds);
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

    const sol = document.getElementById("solutionInput");
    const solutionText = sol ? sol.value.trim() : "";

    // Читаем галочку ДО мутации состояния
    const closeAndCreateCheck = document.getElementById("closeAndCreateCheck");
    const shouldCreateNew = closeAndCreateCheck && closeAndCreateCheck.checked;

    try {
      await outboxQueue.enqueueClose(ticketId, solutionText);
      logHistoryAction("Заявка закрыта локально.");
      notify.offline(
        "Заявка закрыта. Будет синхронизирована при восстановлении сети.",
      );

      this.state.clearDraft();
      this.state.setMode("view");

      if (!this.ticket || this.ticket.id !== ticketId) return true;
      const cmds = await outboxQueue.getPendingByTicket(ticketId);
      this.state.setPendingCommands(cmds);
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

    [
      "currentStaffSelect",
      "repairPicker",
      "deptSelect",
      "reqSelect",
      "groupSelect",
    ].forEach((name) => {
      const comp = this[name];
      if (comp && typeof comp.destroy === "function") comp.destroy();
      this[name] = null;
    });
    if (this.autoReturnTimer) {
      clearTimeout(this.autoReturnTimer);
      this.autoReturnTimer = null;
    }
    if (this.noteField && typeof this.noteField.destroy === "function") {
      this.noteField.destroy();
    }
    this._revokePreviewBlob();
    this.noteField = null;
    this.noteSubmitBtn = null;

    this.currentTicketId = null;
    this._sourceArray = null;
    this._sourceIdx = -1;
  }
}
