import { createDictSelect } from "../../components/dict-select.js";
import { createRepairTimePicker } from "../../components/repair-time-picker.js";
import {
  initVoiceTextarea,
  destroyVoiceInput,
} from "../../components/voiceInput.js";
import { VALIDATION } from "../../config.js";

const CAPS_REGEX = VALIDATION.CAPS_REGEX;

/**
 * Управляет формой редактирования заявки.
 */
export function createEditForm({ ticket, draft, permissions, onChange }) {
  let deptSelect = null;
  let reqSelect = null;
  let groupSelect = null;
  let repairPicker = null;

  const detailsAddBlock = document.getElementById("detailsAddBlock");
  const newDetailsInput = document.getElementById("newDetailsInput");
  const addDetailsBtn = document.getElementById("addDetailsBtn");
  const capsWarnDetails = document.getElementById("capsWarnDetails");

  // --- Инициализация инпутов ---
  if (detailsAddBlock) detailsAddBlock.style.display = "block";
  if (newDetailsInput) {
    initVoiceTextarea(newDetailsInput);
    newDetailsInput.oninput = () => {
      const hasCaps = CAPS_REGEX.test(newDetailsInput.value);
      if (capsWarnDetails)
        capsWarnDetails.style.display = hasCaps ? "block" : "none";
      onChange(); // сообщаем контроллеру, что нужно пересчитать кнопку "Сохранить"
    };
  }

  // --- Логика добавления описания ---
  if (addDetailsBtn && newDetailsInput) {
    addDetailsBtn.onclick = () => {
      const text = newDetailsInput.value.trim();
      if (!text || CAPS_REGEX.test(text)) return;

      const existing = draft.details || "";
      const separator = existing ? "\n\n" : "";
      const newDraftDetails = existing + separator + "📝 Дополнение: " + text;

      draft.details = newDraftDetails;

      const display = document.getElementById("detailsDisplay");
      if (display) {
        const base = ticket.details || "";
        const sep = base ? "\n\n" : "";
        display.textContent = base + sep + newDraftDetails;
      }

      newDetailsInput.value = "";
      if (capsWarnDetails) capsWarnDetails.style.display = "none";
      onChange();
    };
  }

  // --- Селекты справочников ---
  const dictRules = [
    {
      key: "department",
      idField: "department_id",
      ref: "deptSelect",
      blockId: "deptEditBlock",
      currentValue: ticket.department_id,
      can: permissions.canChangeDept,
    },
    {
      key: "request",
      idField: "request_id",
      ref: "reqSelect",
      blockId: "reqEditBlock",
      currentValue: ticket.request_id,
      can: permissions.canChangeReq,
    },
    {
      key: "group",
      idField: "group_id",
      ref: "groupSelect",
      blockId: "groupEditBlock",
      currentValue: ticket.group_id,
      can: permissions.canChangeGroup,
    },
  ];

  if (!navigator.onLine) {
    ["deptDisplay", "reqDisplay", "groupDisplay", "repairTimeDisplay"].forEach(
      (id) => {
        const el = document.getElementById(id);
        if (el) el.title = "🔒 Редактирование доступно только онлайн";
      },
    );
  } else {
    dictRules.forEach((rule) => {
      if (!rule.can) return;

      const block = document.getElementById(rule.blockId);
      if (!block) return;
      block.style.display = "block";

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
      if (rule.ref === "deptSelect") deptSelect = comp;
      if (rule.ref === "reqSelect") reqSelect = comp;
      if (rule.ref === "groupSelect") groupSelect = comp;
    });
  }

  // --- Дата ремонта ---
  if (permissions.canSetRepair && navigator.onLine) {
    const block = document.getElementById("repairTimeEditBlock");
    if (block) {
      block.style.display = "block";
      repairPicker = createRepairTimePicker({
        /* ... */
      });
      block.innerHTML = "";
      block.appendChild(repairPicker.element);
    }
  } else {
    // Офлайн: срок ремонта редактировать нельзя.
    const block = document.getElementById("repairTimeEditBlock");
    if (block) block.style.display = "none";
  }

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
      destroyVoiceInput();
      if (newDetailsInput) {
        newDetailsInput.oninput = null;
        // Очищаем старое значение
        newDetailsInput.value = "";
      }
      if (addDetailsBtn) addDetailsBtn.onclick = null;
      if (capsWarnDetails) capsWarnDetails.style.display = "none";

      if (deptSelect) {
        deptSelect.destroy();
        deptSelect = null;
      }
      if (reqSelect) {
        reqSelect.destroy();
        reqSelect = null;
      }
      if (groupSelect) {
        groupSelect.destroy();
        groupSelect = null;
      }
      if (repairPicker) {
        repairPicker.destroy();
        repairPicker = null;
      }

      [
        "deptEditBlock",
        "reqEditBlock",
        "groupEditBlock",
        "repairTimeEditBlock",
      ].forEach((id) => {
        const el = document.getElementById(id);
        if (el) el.innerHTML = "";
      });
    },
  };
}
