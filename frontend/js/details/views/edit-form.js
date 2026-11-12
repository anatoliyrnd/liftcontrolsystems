import { createDictSelect } from "../../components/dict-select.js";
import { createRepairTimePicker } from "../../components/repair-time-picker.js";
import {
  initVoiceTextarea,
  destroyVoiceInput,
} from "../../components/voiceInput.js";
import { VALIDATION } from "../../config.js";

const CAPS_REGEX = VALIDATION.CAPS_REGEX;
const ONLINE_ONLY_TITLE = "🔒 Редактирование доступно только онлайн";
const REPAIR_OFFLINE_TITLE =
  "🛠 Срок ремонта будет назначен сервером при синхронизации";

/**
 * Форма редактирования заявки.
 *
 * Офлайн (п. 1.4): picker срока не создаётся и слот скрыт, справочники
 * отдел / тип / группа тоже недоступны. Ответственные и статус уведомления
 * живут в staff-slots-view и офлайн сохраняются — их не трогаем.
 * Состояние пересчитывается по событиям online / offline, а не только
 * на.mount: форма может быть открыта в момент обрыва связи.
 */
export function createEditForm({ ticket, draft, permissions, onChange }) {
  let deptSelect = null;
  let reqSelect = null;
  let groupSelect = null;
  let repairPicker = null;
  let destroyed = false;

  const detailsAddBlock = document.getElementById("detailsAddBlock");
  const newDetailsInput = document.getElementById("newDetailsInput");
  const addDetailsBtn = document.getElementById("addDetailsBtn");
  const capsWarnDetails = document.getElementById("capsWarnDetails");

  const dictRules = [
    {
      key: "department",
      idField: "department_id",
      ref: "dept",
      blockId: "deptEditBlock",
      displayId: "deptDisplay",
      currentValue: ticket.department_id,
      can: permissions.canChangeDept,
    },
    {
      key: "request",
      idField: "request_id",
      ref: "req",
      blockId: "reqEditBlock",
      displayId: "reqDisplay",
      currentValue: ticket.request_id,
      can: permissions.canChangeReq,
    },
    {
      key: "group",
      idField: "group_id",
      ref: "group",
      blockId: "groupEditBlock",
      displayId: "groupDisplay",
      currentValue: ticket.group_id,
      can: permissions.canChangeGroup,
    },
  ];

  const refs = { dept: null, req: null, group: null };

  // --- Дополнение к описанию ---
  if (detailsAddBlock) detailsAddBlock.style.display = "block";

  if (newDetailsInput) {
    initVoiceTextarea(newDetailsInput);
    newDetailsInput.oninput = () => {
      const hasCaps = CAPS_REGEX.test(newDetailsInput.value);
      if (capsWarnDetails)
        capsWarnDetails.style.display = hasCaps ? "block" : "none";
      onChange();
    };
  }

  if (addDetailsBtn && newDetailsInput) {
    addDetailsBtn.onclick = () => {
      const text = newDetailsInput.value.trim();
      if (!text || CAPS_REGEX.test(text)) return;

      const existing = draft.details || "";
      const separator = existing ? "\n\n" : "";
      draft.details = existing + separator + "📝 Дополнение: " + text;

      const display = document.getElementById("detailsDisplay");
      if (display) {
        const base = ticket.details || "";
        display.textContent = base + (base ? "\n\n" : "") + draft.details;
      }

      newDetailsInput.value = "";
      if (capsWarnDetails) capsWarnDetails.style.display = "none";
      onChange();
    };
  }

  // --- Справочники ---
  function destroyDicts() {
    for (const key of Object.keys(refs)) {
      refs[key]?.destroy();
      refs[key] = null;
    }
    deptSelect = reqSelect = groupSelect = null;
    for (const rule of dictRules) {
      const block = document.getElementById(rule.blockId);
      if (block) {
        block.innerHTML = "";
        block.style.display = "none";
      }
    }
  }

  function buildDicts() {
    for (const rule of dictRules) {
      if (!rule.can || refs[rule.ref]) continue;
      const block = document.getElementById(rule.blockId);
      if (!block) continue;

      const comp = createDictSelect({
        key: rule.key,
        initialValue: rule.currentValue || null,
        placeholder: "— выберите —",
        required: true,
        onChange: (value) => {
          if (value) draft[rule.idField] = String(value);
          else delete draft[rule.idField];
          onChange();
        },
      });

      block.innerHTML = "";
      block.appendChild(comp.element);
      block.style.display = "block";
      refs[rule.ref] = comp;
    }
    deptSelect = refs.dept;
    reqSelect = refs.req;
    groupSelect = refs.group;
  }

  // --- Срок ремонта ---
  function destroyRepair() {
    if (repairPicker) {
      repairPicker.destroy();
      repairPicker = null;
    }
    delete draft.repair_time;
    const block = document.getElementById("repairTimeEditBlock");
    if (block) {
      block.innerHTML = "";
      block.style.display = "none";
    }
  }

  function buildRepair() {
    if (!permissions.canSetRepair || repairPicker) return;
    const block = document.getElementById("repairTimeEditBlock");
    if (!block) return;

    repairPicker = createRepairTimePicker({
      initialValue: ticket.repair_time,
      onChange: (value) => {
        draft.repair_time = value;
        onChange();
      },
    });
    block.innerHTML = "";
    block.appendChild(repairPicker.element);
    block.style.display = "block";
  }

  function applyNetworkState() {
    if (destroyed) return;
    const online = navigator.onLine;
    const repairDisplay = document.getElementById("repairTimeDisplay");

    if (online) {
      buildDicts();
      buildRepair();
      for (const rule of dictRules) {
        const el = document.getElementById(rule.displayId);
        if (el) el.title = "";
      }
      if (repairDisplay)
        repairDisplay.title = ticket.isOffline ? REPAIR_OFFLINE_TITLE : "";
    } else {
      destroyDicts();
      destroyRepair();
      for (const rule of dictRules) {
        const el = document.getElementById(rule.displayId);
        if (el) el.title = ONLINE_ONLY_TITLE;
      }
      if (repairDisplay) repairDisplay.title = REPAIR_OFFLINE_TITLE;
    }
    onChange();
  }

  window.addEventListener("online", applyNetworkState);
  window.addEventListener("offline", applyNetworkState);
  applyNetworkState();

  return {
    isValid: () => {
      if (newDetailsInput && CAPS_REGEX.test(newDetailsInput.value))
        return false;
      if (repairPicker && !repairPicker.isValid()) return false;
      if (deptSelect && !deptSelect.isValid()) return false;
      if (reqSelect && !reqSelect.isValid()) return false;
      if (groupSelect && !groupSelect.isValid()) return false;
      return true;
    },

    hasUncommittedDetails: () => {
      if (!newDetailsInput) return false;
      const typed = newDetailsInput.value.trim();
      return typed.length > 0 && !CAPS_REGEX.test(typed);
    },

    destroy: () => {
      destroyed = true;
      window.removeEventListener("online", applyNetworkState);
      window.removeEventListener("offline", applyNetworkState);

      destroyVoiceInput();
      if (newDetailsInput) {
        newDetailsInput.oninput = null;
        newDetailsInput.value = "";
      }
      if (addDetailsBtn) addDetailsBtn.onclick = null;
      if (capsWarnDetails) capsWarnDetails.style.display = "none";

      destroyDicts();
      destroyRepair();

      for (const rule of dictRules) {
        const el = document.getElementById(rule.displayId);
        if (el) el.title = "";
      }
      const repairDisplay = document.getElementById("repairTimeDisplay");
      if (repairDisplay) repairDisplay.title = "";
    },
  };
}
