import { createAddressPicker } from "../../components/address-picker.js";
import { createStaffSelect } from "../../components/staff-select.js";
import { createRepairTimePicker } from "../../components/repair-time-picker.js";
import { createDictSelect } from "../../components/dict-select.js";
import {
  initVoiceTextarea,
  destroyVoiceInput,
} from "../../components/voiceInput.js";
import { staffStore } from "../../staff-store.js";
import { VALIDATION } from "../../config.js";

const CAPS_REGEX = VALIDATION.CAPS_REGEX;
const DRAFT_KEY = "create_draft";

/**
 * Форма создания заявки.
 *
 * Офлайн (п. 1.3): picker срока не создаётся, слот скрыт, ключ repair_time
 * отсутствует в payload целиком — сервер назначит срок при синхронизации
 * (API_syncCommands §4.1.1). Видимость пересчитывается по online / offline,
 * а не только на mount.
 *
 * Не трогаем офлайн: ответственный, отдел, тип, группа — доступны всегда.
 */
export function createCreateFormView({ onChange }) {
  let addressPicker = null;
  let staffSelect = null;
  let repairPicker = null;
  let draftTimer = null;
  let isLocked = false;
  let destroyed = false;

  const dictRefs = { group: null, dept: null, req: null };

  const formDetails = document.getElementById("formDetails");
  const formContainer = document.querySelector(".create-form-wrapper");

  function _saveDraft() {
    const details = formDetails?.value || "";
    const address = addressPicker?.getValue();
    if (!details && !address) return;

    const draft = {
      details,
      address,
      staffId: staffSelect?.getValue(),
      dept: dictRefs.dept?.getValue(),
      req: dictRefs.req?.getValue(),
      grp: dictRefs.group?.getValue(),
      repair: navigator.onLine ? repairPicker?.getTimestamp() : null,
    };
    try {
      sessionStorage.setItem(DRAFT_KEY, JSON.stringify(draft));
    } catch (e) {
      console.warn("[CreateFormView] Не удалось сохранить черновик:", e);
    }
  }

  function _checkDraft() {
    const raw = sessionStorage.getItem(DRAFT_KEY);
    if (!raw) return;
    let draft;
    try {
      draft = JSON.parse(raw);
    } catch (e) {
      sessionStorage.removeItem(DRAFT_KEY);
      return;
    }

    if (confirm("Найден несохраненный черновик заявки. Восстановить данные?")) {
      if (draft.details && formDetails) formDetails.value = draft.details;
      if (draft.address) addressPicker?.setValue(draft.address);
      if (draft.dept) dictRefs.dept?.setValue(draft.dept);
      if (draft.req) dictRefs.req?.setValue(draft.req);
      if (draft.grp) dictRefs.group?.setValue(draft.grp);
      if (draft.staffId) staffSelect?.setValue(draft.staffId);
      if (draft.repair && navigator.onLine)
        repairPicker?.setValue(draft.repair);
    } else {
      sessionStorage.removeItem(DRAFT_KEY);
    }
  }

  function _updateSaveBtnState() {
    if (isLocked) return;
    const btn = document.getElementById("saveTicketBtn");
    if (!btn) return;

    const hasCaps = formDetails ? CAPS_REGEX.test(formDetails.value) : false;
    const allFilled =
      !!addressPicker?.isValid() &&
      !!dictRefs.dept?.isValid() &&
      !!dictRefs.req?.isValid() &&
      !!dictRefs.group?.isValid() &&
      !hasCaps;

    btn.disabled = !allFilled;
    btn.style.opacity = allFilled ? "1" : "0.5";
    btn.style.cursor = allFilled ? "pointer" : "not-allowed";
  }

  // --- Срок ремонта: создание и снятие по состоянию сети ---
  function _destroyRepairPicker() {
    if (repairPicker) {
      repairPicker.destroy();
      repairPicker = null;
    }
    const slot = document.getElementById("repairTimeSlot");
    if (slot) {
      slot.innerHTML = "";
      slot.style.display = "none";
    }
  }

  function _buildRepairPicker() {
    if (repairPicker) return;
    const slot = document.getElementById("repairTimeSlot");
    if (!slot) return;

    repairPicker = createRepairTimePicker({
      initialValue: null,
      onChange: () => {
        _updateSaveBtnState();
        onChange();
      },
    });
    slot.innerHTML = "";
    slot.appendChild(repairPicker.element);
    slot.style.display = "";

    // Бизнес-правило «Застревание»: 40 минут от текущего момента.
    if (dictRefs.group?.getValue() === "4" && !repairPicker.getTimestamp()) {
      repairPicker.setValue(Math.floor(Date.now() / 1000) + 40 * 60);
    }
  }

  function _syncRepairPicker() {
    if (destroyed) return;
    if (navigator.onLine) _buildRepairPicker();
    else _destroyRepairPicker();
    _updateSaveBtnState();
    onChange();
  }

  function mount(prefilledAddress) {
    const addressSlot = document.getElementById("formAddressSlot");
    if (addressSlot && !addressPicker) {
      addressPicker = createAddressPicker({
        readOnly: !!prefilledAddress,
        onChange: () => {
          _updateSaveBtnState();
          onChange();
        },
      });
      addressSlot.innerHTML = "";
      addressSlot.appendChild(addressPicker.element);

      if (prefilledAddress) {
        addressPicker.setValue(prefilledAddress);
        const addrHint = document.getElementById("formAddressHint");
        if (addrHint && prefilledAddress.from_ticket_id) {
          addrHint.textContent =
            "📍 Адрес из заявки №" +
            prefilledAddress.from_ticket_id +
            " — объект наследуется автоматически";
          addrHint.style.display = "block";
        }
      }
    }

    if (formContainer) {
      formContainer.onkeydown = (e) => {
        if ((e.ctrlKey || e.metaKey) && e.key === "Enter") {
          const saveBtn = document.getElementById("saveTicketBtn");
          if (saveBtn && !saveBtn.disabled) saveBtn.click();
        }
      };
      formContainer.oninput = () => {
        clearTimeout(draftTimer);
        draftTimer = setTimeout(_saveDraft, 1000);
      };
    }

    const staffSlot = document.getElementById("formStaffSlot");
    if (staffSlot && !staffSelect) {
      staffSelect = createStaffSelect({
        list: staffStore.list,
        placeholder: "Начните вводить имя...",
      });
      staffSlot.innerHTML = "";
      staffSlot.appendChild(staffSelect.element);
    }

    const slots = [
      {
        id: "createGroupSlot",
        key: "group",
        ref: "group",
        placeholder: "— выберите группу —",
      },
      {
        id: "createDeptSlot",
        key: "department",
        ref: "dept",
        placeholder: "— выберите отдел —",
      },
      {
        id: "createReqSlot",
        key: "request",
        ref: "req",
        placeholder: "— выберите тип —",
      },
    ];

    for (const s of slots) {
      const container = document.getElementById(s.id);
      if (!container || dictRefs[s.ref]) continue;

      const comp = createDictSelect({
        key: s.key,
        placeholder: s.placeholder,
        required: true,
        onChange: (value) => {
          _updateSaveBtnState();
          onChange();
          if (s.key === "group" && value === "4" && repairPicker) {
            repairPicker.setValue(Math.floor(Date.now() / 1000) + 40 * 60);
          }
        },
      });
      container.innerHTML = "";
      container.appendChild(comp.element);
      dictRefs[s.ref] = comp;
    }

    window.addEventListener("online", _syncRepairPicker);
    window.addEventListener("offline", _syncRepairPicker);
    _syncRepairPicker();

    _checkDraft();
    _updateSaveBtnState();

    const formDetailsRow = document.getElementById("formDetailsRow");
    if (formDetails) {
      initVoiceTextarea(
        formDetails,
        formDetailsRow ? { container: formDetailsRow } : {},
      );
      formDetails.oninput = () => {
        const hasCaps = CAPS_REGEX.test(formDetails.value);
        const capsWarn = document.getElementById("capsWarnFormDetails");
        if (capsWarn) capsWarn.style.display = hasCaps ? "block" : "none";
        _updateSaveBtnState();
        onChange();
      };
    }
  }

  return {
    mount,

    getPayload: () => {
      const addressData = addressPicker?.getValue() || {};
      const details = formDetails?.value.trim() || "";

      const payload = {
        city_id: addressData.city_id ?? null,
        street_id: addressData.street_id ?? null,
        home_id: addressData.home_id ?? null,
        object_id: addressData.object_id ?? null,
        fullAddress: addressData.address || "",
        group_id: dictRefs.group?.getValue() || null,
        request_id: dictRefs.req?.getValue() || null,
        department_id: dictRefs.dept?.getValue() || null,
        details,
        staff_id: staffSelect?.getValue() || null,
      };

      // Офлайн ключ не добавляем вовсе — не null, а отсутствие поля.
      if (navigator.onLine) {
        payload.repair_time = repairPicker?.getTimestamp() || null;
      }
      return payload;
    },

    isValid: () => {
      const addressData = addressPicker?.getValue();
      const details = formDetails?.value.trim() || "";

      if (!addressData || !details) {
        return {
          ok: false,
          msg: "Заполните обязательные поля: выберите адрес и введите описание проблемы.",
        };
      }
      if (navigator.onLine && repairPicker && !repairPicker.isValid()) {
        return { ok: false, msg: "Дата ремонта указана некорректно." };
      }
      if (
        !dictRefs.dept?.isValid() ||
        !dictRefs.req?.isValid() ||
        !dictRefs.group?.isValid()
      ) {
        return {
          ok: false,
          msg: "Пожалуйста, выберите отдел, тип запроса и группу.",
        };
      }
      return { ok: true };
    },

    lock: () => {
      isLocked = true;
      formContainer?.classList.add("create-form-locked");
    },

    unlock: () => {
      isLocked = false;
      formContainer?.classList.remove("create-form-locked");
      _updateSaveBtnState();
    },

    reset: () => {
      sessionStorage.removeItem(DRAFT_KEY);
      if (formDetails) formDetails.value = "";
      addressPicker?.reset?.();
      staffSelect?.reset?.();
      dictRefs.dept?.reset?.();
      dictRefs.req?.reset?.();
      dictRefs.group?.reset?.();
      repairPicker?.reset?.();
      const capsWarn = document.getElementById("capsWarnFormDetails");
      if (capsWarn) capsWarn.style.display = "none";
      _updateSaveBtnState();
    },

    destroy: () => {
      destroyed = true;
      window.removeEventListener("online", _syncRepairPicker);
      window.removeEventListener("offline", _syncRepairPicker);

      if (draftTimer) clearTimeout(draftTimer);
      destroyVoiceInput();
      if (formContainer) {
        formContainer.oninput = null;
        formContainer.onkeydown = null;
      }
      if (formDetails) formDetails.oninput = null;

      addressPicker?.destroy();
      staffSelect?.destroy();
      repairPicker?.destroy();
      dictRefs.dept?.destroy();
      dictRefs.req?.destroy();
      dictRefs.group?.destroy();

      addressPicker = staffSelect = repairPicker = null;
      dictRefs.dept = dictRefs.req = dictRefs.group = null;
    },
  };
}
