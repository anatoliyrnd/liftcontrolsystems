import { escapeHtml } from "../../utils/escape-html.js";
import { formatTs } from "../../utils/date-utils.js";
import { formatFullHistory } from "../history-view.js";
import { VALIDATION } from "../../config.js";

const MIN_SOLUTION_LEN = VALIDATION.MIN_SOLUTION_LEN;

/**
 * Возвращает HTML-каркас карточки заявки.
 */
export function renderCardLayout({
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
  isAdmin,
}) {
  return `
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
                            <div style="font-size: 12px; color: var(--text-secondary); margin-top: 4px;">
                                👤 ${escapeHtml(t.creator_name || t.offline_author_name || "Неизвестно")}
                            </div>
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
                          !pendingClose && isAdmin && t.full_history
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
                </div> <!-- КОНЕЦ ticketBodyBlock -->

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
            </div> <!-- КОНЕЦ ticketScrollArea -->

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
}
