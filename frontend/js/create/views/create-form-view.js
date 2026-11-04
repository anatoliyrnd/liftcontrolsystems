import { createAddressPicker } from "../../components/address-picker.js";
import { createStaffSelect } from "../../components/staff-select.js";
import { createRepairTimePicker } from "../../components/repair-time-picker.js";
import { createDictSelect } from "../../components/dict-select.js";
import {
  initVoiceTextarea,
  destroyVoiceInput,
} from "../../components/voiceInput.js";
import { staffStore } from "../../staff-store.js";
import { VALIDATION, UI } from "../../config.js";
import { notify } from "../../components/notify.js";
import { logHistoryAction } from "../../history-logger.js";

const CAPS_REGEX = VALIDATION.CAPS_REGEX;

export function createCreateFormView({ onChange }) {
  let addressPicker = null;
  let staffSelect = null;
  let repairPicker = null;
  let deptSelect = null;
  let reqSelect = null;
  let groupSelect = null;
  let draftTimer = null;
  let isLocked = false;

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
      dept: deptSelect?.getValue(),
      req: reqSelect?.getValue(),
      grp: groupSelect?.getValue(),
      repair: repairPicker?.getTimestamp(),
    };
    sessionStorage.setItem("create_draft", JSON.stringify(draft));
  }

  function _checkDraft() {
    const raw = sessionStorage.getItem("create_draft");
    if (!raw) return;
    try {
      const draft = JSON.parse(raw);
      if (
        confirm("Найден несохраненный черновик заявки. Восстановить данные?")
      ) {
        if (draft.details && formDetails) formDetails.value = draft.details;
        if (draft.address) addressPicker?.setValue(draft.address);
        if (draft.dept) deptSelect?.setValue(draft.dept);
        if (draft.req) reqSelect?.setValue(draft.req);
        if (draft.grp) groupSelect?.setValue(draft.grp);
        if (draft.staffId) staffSelect?.setValue(draft.staffId);
        if (draft.repair) repairPicker?.setValue(draft.repair);
      } else {
        sessionStorage.removeItem("create_draft");
      }
    } catch (e) {
      console.error("[CreateFormView] Draft restore error:", e);
    }
  }

  function _updateSaveBtnState() {
    if (isLocked) return;
    const btn = document.getElementById("saveTicketBtn");
    if (!btn) return;

    const hasCaps = formDetails && CAPS_REGEX.test(formDetails.value);
    const allFilled =
      addressPicker?.isValid() &&
      deptSelect?.isValid() &&
      reqSelect?.isValid() &&
      groupSelect?.isValid() &&
      !hasCaps;

    btn.disabled = !allFilled;
    btn.style.opacity = allFilled ? "1" : "0.5";
    btn.style.cursor = allFilled ? "pointer" : "not-allowed";
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

    const repairSlot = document.getElementById("repairTimeSlot");
    if (repairSlot && !repairPicker) {
      repairPicker = createRepairTimePicker({
        initialValue: null,
        onChange: () => {
          _updateSaveBtnState();
          onChange();
        },
      });
      repairSlot.innerHTML = "";
      repairSlot.appendChild(repairPicker.element);
    }

    const slots = [
      {
        id: "createGroupSlot",
        key: "group",
        ref: "groupSelect",
        placeholder: "— выберите группу —",
      },
      {
        id: "createDeptSlot",
        key: "department",
        ref: "deptSelect",
        placeholder: "— выберите отдел —",
      },
      {
        id: "createReqSlot",
        key: "request",
        ref: "reqSelect",
        placeholder: "— выберите тип —",
      },
    ];

    slots.forEach((s) => {
      const container = document.getElementById(s.id);
      if (container && !this[s.ref]) {
        const comp = createDictSelect({
          key: s.key,
          placeholder: s.placeholder,
          required: true,
          onChange: (value) => {
            _updateSaveBtnState();
            onChange();
            // Бизнес-логика "Застревания"
            if (s.key === "group" && value === "4" && repairPicker) {
              const fortyMinsLater = Math.floor(Date.now() / 1000) + 40 * 60;
              repairPicker.setValue(fortyMinsLater);
            }
          },
        });
        container.innerHTML = "";
        container.appendChild(comp.element);
        if (s.ref === "groupSelect") groupSelect = comp;
        if (s.ref === "deptSelect") deptSelect = comp;
        if (s.ref === "reqSelect") reqSelect = comp;
      }
    });

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
      const addressData = addressPicker?.getValue();
      const details = formDetails?.value.trim() || "";
      const staffId = staffSelect?.getValue() || null;
      return {
        city_id: addressData.city_id,
        street_id: addressData.street_id,
        home_id: addressData.home_id,
        object_id: addressData.object_id,
        fullAddress: addressData.address,
        group_id: groupSelect?.getValue() || null,
        request_id: reqSelect?.getValue() || null,
        department_id: deptSelect?.getValue() || null,
        repair_time: repairPicker?.getTimestamp() || null,
        details: details,
        staff_id: staffId,
      };
    },
    isValid: () => {
      const addressData = addressPicker?.getValue();
      const details = formDetails?.value.trim() || "";
      if (!addressData || !details)
        return {
          ok: false,
          msg: "Заполните обязательные поля: выберите адрес и введите описание проблемы.",
        };
      if (repairPicker && !repairPicker.isValid())
        return { ok: false, msg: "Дата ремонта указана некорректно." };
      if (
        !deptSelect?.isValid() ||
        !reqSelect?.isValid() ||
        !groupSelect?.isValid()
      )
        return {
          ok: false,
          msg: "Пожалуйста, выберите отдел, тип запроса и группу.",
        };
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
      sessionStorage.removeItem("create_draft");
      if (formDetails) formDetails.value = "";
      addressPicker?.reset();
      staffSelect?.reset();
      deptSelect?.reset();
      reqSelect?.reset();
      groupSelect?.reset();
      repairPicker?.reset();
      _updateSaveBtnState();
    },
    destroy: () => {
      if (draftTimer) clearTimeout(draftTimer);
      destroyVoiceInput();
      if (formContainer) formContainer.oninput = null;
      if (formDetails) formDetails.oninput = null;
      addressPicker?.destroy();
      staffSelect?.destroy();
      repairPicker?.destroy();
      deptSelect?.destroy();
      reqSelect?.destroy();
      groupSelect?.destroy();
      addressPicker =
        staffSelect =
        repairPicker =
        deptSelect =
        reqSelect =
        groupSelect =
          null;
    },
  };
}
