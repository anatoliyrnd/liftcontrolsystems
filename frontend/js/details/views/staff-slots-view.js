import { createStaffSelect } from "../../components/staff-select.js";
import { getStatusWord } from "../status-word.js";
import { formatTs } from "../../utils/date-utils.js";
import { BUSINESS } from "../../config.js";

const NOTIFY_CHANNELS = BUSINESS.NOTIFY_CHANNELS;

/**
 * Рендер блока «Ответственные».
 * @param {HTMLElement} container
 * @param {Object} options
 * @param {Object} options.ticket - отображаемая заявка (getDisplayTicket)
 * @param {Object} options.draft - черновик изменений
 * @param {String} options.mode - 'view' | 'edit' | 'close'
 * @param {Array} options.staffList - справочник механиков
 * @param {Object} options.permissions - { isAdmin, canAssign }
 * @param {Boolean} options.autoOpenPending - нужно ли автооткрыть форму
 * @param {Object} options.handlers
 * @param {Function} options.handlers.onAssign - (slotNumber, staffId, staffName, notifyChecked)
 * @param {Function} options.handlers.onUnassign - (slotNumber)
 * @param {Function} options.handlers.onNotify - (slotNumber)
 * @param {Function} options.handlers.onAutoOpenConsumed - () => {}
 * @returns {Object} { destroy: () => void }
 */
export function renderStaffSlots(container, options) {
  const {
    ticket,
    draft,
    mode,
    staffList,
    permissions,
    autoOpenPending,
    handlers,
  } = options;
  let activeSelect = null;

  function _getStaffSlots() {
    return [
      {
        slot: 1,
        id: ticket.staff_id,
        name: ticket.staff_name,
        notifyStatus: ticket.notify_status,
        notifyDate: ticket.notify_date,
      },
      {
        slot: 2,
        id: ticket.staff_id2,
        name: ticket.staff_name2,
        notifyStatus: ticket.notify_status2,
        notifyDate: ticket.notify_date2,
      },
      {
        slot: 3,
        id: ticket.staff_id3,
        name: ticket.staff_name3,
        notifyStatus: ticket.notify_status3,
        notifyDate: ticket.notify_date3,
      },
    ];
  }

  function _slotLabel(slotNumber) {
    return slotNumber === 1
      ? "Ответственный 1"
      : "Доп. ответственный " + slotNumber;
  }

  function _openAssignForm(slotNumber) {
    if (!container) return;
    const slots = _getStaffSlots();
    const busyIds = slots
      .filter((s) => s.slot !== slotNumber && s.id)
      .map((s) => s.id);

    const rowIdx = slotNumber - 1;
    const row = container.children[rowIdx];
    if (!row) return;

    if (activeSelect) {
      activeSelect.destroy();
      activeSelect = null;
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
      list: staffList,
      excludeIds: busyIds,
      placeholder: "Начните вводить имя...",
      onSelect: (staff) => {
        const suffix = slotNumber === 1 ? "" : slotNumber;
        const keyId = "staff_id" + suffix;
        const isNewOrReassign = !ticket[keyId] || keyId in draft;
        if (staff && isNewOrReassign) {
          notifyWrap.style.display = "inline-flex";
        } else {
          notifyWrap.style.display = "none";
          notifyCheck.checked = false;
        }
      },
    });
    activeSelect = staffSelect;

    const confirmBtn = document.createElement("button");
    confirmBtn.textContent = "Подтвердить";
    confirmBtn.style.cssText =
      "margin-top: 6px; padding: 6px 10px; border-radius: 6px; border: none; background: var(--accent); color: var(--mark-text); cursor: pointer; font-size: 12px; font-weight: 600;";

    confirmBtn.onclick = () => {
      const selectedId = staffSelect.getValue();
      if (!selectedId) return;

      const finalId = isNaN(selectedId) ? selectedId : Number(selectedId);
      const staffName =
        staffList.find((s) => String(s.id) === String(selectedId))?.name ||
        null;

      handlers.onAssign(slotNumber, finalId, staffName, notifyCheck.checked);

      staffSelect.destroy();
      activeSelect = null;
      // Перерисовка произойдет из контроллера после обновления стейта
    };

    const cancelBtn = document.createElement("button");
    cancelBtn.textContent = "Отмена";
    cancelBtn.style.cssText =
      "margin-top: 6px; margin-left: 6px; padding: 6px 10px; border-radius: 6px; border: 1px solid var(--border-color); background: var(--bg-secondary); color: var(--text-primary); cursor: pointer; font-size: 12px;";
    cancelBtn.onclick = () => {
      staffSelect.destroy();
      activeSelect = null;
      handlers.onAutoOpenConsumed(); // Сбрасываем флаг
      // Триггерим перерисовку через контроллер
      handlers.onUnassign(-1); // Хак для принудительной перерисовки, либо можно добавить onCancel
    };

    row.appendChild(staffSelect.element);
    row.appendChild(notifyWrap);
    row.appendChild(confirmBtn);
    row.appendChild(cancelBtn);

    setTimeout(() => {
      if (staffSelect && activeSelect === staffSelect) staffSelect.focus();
    }, 30);
  }

  function _renderFilledSlot(slot, slotNumber, ctx) {
    const { isOpen, isEdit, isAdmin, canAssign, isGridLocked } = ctx;
    const suffix = slotNumber === 1 ? "" : slotNumber;

    const row = document.createElement("div");
    row.style.cssText =
      "display: flex; flex-direction: column; gap: 4px; padding: 8px 10px; border-radius: 8px; border: 1px solid var(--border-color); background: var(--bg-primary);";

    const head = document.createElement("div");
    head.style.cssText =
      "display: flex; justify-content: space-between; align-items: center; gap: 8px;";

    const phoneFromTicket = ticket["staff_phone" + suffix];
    const staffObj = staffList.find((s) => String(s.id) === String(slot.id));
    const phone = phoneFromTicket || (staffObj ? staffObj.phone : null);

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
    labelEl.textContent = _slotLabel(slotNumber);
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
    const isNewlyAssigned = keyStaffId in draft;

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
          if (!cb.checked) return;
          handlers.onNotify(slotNumber);
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
        replaceBtn.onclick = () => _openAssignForm(slotNumber);
        actionsRow.appendChild(replaceBtn);
      }

      if (canUnassign) {
        const unassignBtn = document.createElement("button");
        unassignBtn.textContent = "× Снять";
        unassignBtn.style.cssText =
          "padding: 4px 10px; border-radius: 6px; border: 1px solid #ef4444; background: transparent; color: #ef4444; cursor: pointer; font-size: 11px;";
        unassignBtn.onclick = () => handlers.onUnassign(slotNumber);
        actionsRow.appendChild(unassignBtn);
      }

      row.appendChild(actionsRow);
    }

    container.appendChild(row);
  }

  function _renderEmptySlot(slotNumber, idx, ctx) {
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
      <span style="font-size: 13px; font-weight: 600; color: var(--text-secondary);">${_slotLabel(slotNumber)}</span>
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
      addBtn.onclick = () => _openAssignForm(slotNumber);
      row.appendChild(addBtn);
    }

    container.appendChild(row);
  }

  // --- Основная логика рендера ---
  if (!container) return { destroy: () => {} };

  if (ticket.type === "close") {
    const slots = _getStaffSlots().filter((s) => s.id);
    if (slots.length === 0) {
      container.innerHTML =
        '<div style="font-size: 13px; color: var(--text-secondary); font-style: italic;">Нет данных об ответственных</div>';
      return { destroy: () => {} };
    }
    const list = document.createElement("div");
    list.style.cssText =
      "font-size: 14px; line-height: 1.6; font-weight: 500; color: var(--text-primary);";
    slots.forEach((slot) => {
      const div = document.createElement("div");
      div.textContent = `• ${slot.name} (${getStatusWord(slot.notifyStatus)})`;
      list.appendChild(div);
    });
    container.innerHTML = "";
    container.appendChild(list);
    return { destroy: () => {} };
  }

  if (activeSelect) {
    activeSelect.destroy();
    activeSelect = null;
  }
  container.innerHTML = "";

  const slots = _getStaffSlots();
  const isOpen = ticket.type !== "close";
  const isEdit = mode === "edit";
  const isGridLocked = !!document.querySelector(
    ".ticket-card-layout-grid.card-locked",
  );

  const filled = slots.map((slot, idx) => {
    const keyId = "staff_id" + (idx === 0 ? "" : idx + 1);
    if (keyId in draft) return !!draft[keyId];
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

  const ctx = {
    isOpen,
    isEdit,
    isAdmin: permissions.isAdmin,
    canAssign: permissions.canAssign,
    isGridLocked,
    isSessionLocked: false /* передается если нужно */,
    firstEmptyIdx,
  };

  slots.forEach((slot, idx) => {
    if (!visible[idx]) return;
    const slotNumber = idx + 1;
    if (filled[idx]) {
      _renderFilledSlot(slot, slotNumber, ctx);
    } else {
      _renderEmptySlot(slotNumber, idx, ctx);
    }
  });

  if (
    autoOpenPending &&
    isEdit &&
    firstEmptyIdx === 0 &&
    permissions.canAssign &&
    !isGridLocked
  ) {
    handlers.onAutoOpenConsumed();
    setTimeout(() => _openAssignForm(1), 0);
  }

  return {
    destroy: () => {
      if (activeSelect) {
        activeSelect.destroy();
        activeSelect = null;
      }
    },
  };
}
