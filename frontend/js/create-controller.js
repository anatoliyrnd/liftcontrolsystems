import { staffStore } from "./staff-store.js";
import { createDictSelect } from "./components/dict-select.js";
import { createRepairTimePicker } from "./components/repair-time-picker.js";
import { createStaffSelect } from "./components/staff-select.js";
import {
  initVoiceTextarea,
  destroyVoiceInput,
} from "./components/voiceInput.js";
import { notify } from "./components/notify.js";
import { logHistoryAction } from "./history-logger.js";
import { VALIDATION, UI, OFFLINE } from "./config.js";
import { appState } from "./app-state.js";
import { createAddressPicker } from "./components/address-picker.js";
import { offlineDB } from "./offline-db.js";
import { authStore } from "./auth-store.js";
import { nowTs } from "./utils/date-utils.js";

export class CreateController {
  constructor(apiInstance, routerInstance) {
    this.api = apiInstance;
    this.router = routerInstance;
    this.autoReturnTimer = null;
    this.isLocked = false;
    this.staffSelect = null;
    this.repairPicker = null;
    this.deptSelect = null;
    this.reqSelect = null;
    this.groupSelect = null;
    this.prefilledAddress = null;
    this.addressPicker = null;
  }

  mount(globalTicketsArrayRef) {
    this.prefilledAddress = null;
    if (appState.pendingCreateAddress) {
      this.prefilledAddress = appState.pendingCreateAddress;
      appState.pendingCreateAddress = null;
      sessionStorage.removeItem("create_draft");
      const h1 =
        document.querySelector(".create-form-wrapper h1") ||
        document.querySelector("h1");
      if (h1 && this.prefilledAddress.from_ticket_id) {
        h1.textContent =
          "Новая заявка для объекта из заявки №" +
          this.prefilledAddress.from_ticket_id;
      }
    }

    const addressSlot = document.getElementById("formAddressSlot");
    if (addressSlot && !this.addressPicker) {
      const isPrefilled = !!this.prefilledAddress;

      this.addressPicker = createAddressPicker({
        readOnly: isPrefilled,
        onChange: (data) => {
          this._updateSaveBtnState();
        },
      });
      addressSlot.innerHTML = "";
      addressSlot.appendChild(this.addressPicker.element);

      if (isPrefilled) {
        this.addressPicker.setValue(this.prefilledAddress);
        const addrHint = document.getElementById("formAddressHint");
        if (addrHint && this.prefilledAddress.from_ticket_id) {
          addrHint.textContent =
            "📍 Адрес из заявки №" +
            this.prefilledAddress.from_ticket_id +
            " — объект наследуется автоматически";
          addrHint.style.display = "block";
        }
      }
    }

    const formContainer = document.querySelector(".create-form-wrapper");
    if (formContainer) {
      formContainer.onkeydown = (e) => {
        if ((e.ctrlKey || e.metaKey) && e.key === "Enter") {
          const saveBtn = document.getElementById("saveTicketBtn");
          if (saveBtn && !saveBtn.disabled) saveBtn.click();
        }
      };
      formContainer.oninput = () => {
        clearTimeout(this._draftTimer);
        this._draftTimer = setTimeout(() => this._saveDraft(), 1000);
      };
    }

    const staffSlot = document.getElementById("formStaffSlot");
    if (staffSlot && !this.staffSelect) {
      this.staffSelect = createStaffSelect({
        list: staffStore.list,
        placeholder: "Начните вводить имя...",
      });
      staffSlot.innerHTML = "";
      staffSlot.appendChild(this.staffSelect.element);
    }

    const repairSlot = document.getElementById("repairTimeSlot");
    if (repairSlot && !this.repairPicker) {
      this.repairPicker = createRepairTimePicker({
        initialValue: null, // Возьмет дефолт (17:00 сегодня/завтра) из date-utils.js
        onChange: () => {
          this._updateSaveBtnState();
        },
      });
      repairSlot.innerHTML = "";
      repairSlot.appendChild(this.repairPicker.element);
    }

    // В методе mount() контроллера
    const slots = [
      // 1. Группа (теперь первая)
      {
        id: "createGroupSlot",
        key: "group",
        ref: "groupSelect",
        placeholder: "— выберите группу —",
      },
      // 2. Отдел
      {
        id: "createDeptSlot",
        key: "department",
        ref: "deptSelect",
        placeholder: "— выберите отдел —",
      },
      // 3. Тип запроса
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
          onChange: (value, isValid) => {
            // 1. Обновляем состояние кнопки "Сохранить"
            this._updateSaveBtnState();

            // 2. ЛОГИКА ДЛЯ "ЗАСТРЕВАНИЯ"
            // Проверяем, что изменилась именно группа и её ID равен 4 (Застревание)
            if (s.key === "group" && value === "4") {
              if (this.repairPicker) {
                // Получаем текущий UNIX timestamp в секундах и добавляем 40 минут (2400 секунд)
                const fortyMinsLater = Math.floor(Date.now() / 1000) + 40 * 60;

                // Устанавливаем это время в виджет
                this.repairPicker.setValue(fortyMinsLater);

                // Опционально: уведомляем пользователя, чтобы он не удивился
                // notify.info("Время ремонта автоматически установлено на +40 минут");
              }
            }
          },
        });
        container.innerHTML = "";
        container.appendChild(comp.element);
        this[s.ref] = comp;
      }
    });

    this._checkDraft();
    this._updateSaveBtnState();

    const formDetails = document.getElementById("formDetails");
    const formDetailsRow = document.getElementById("formDetailsRow");
    if (formDetails) {
      initVoiceTextarea(
        formDetails,
        formDetailsRow ? { container: formDetailsRow } : {},
      );
    }

    if (formDetails) {
      const capsWarn = document.getElementById("capsWarnFormDetails");
      formDetails.oninput = () => {
        const hasCaps = VALIDATION.CAPS_REGEX.test(formDetails.value);
        if (capsWarn) capsWarn.style.display = hasCaps ? "block" : "none";
        this._updateSaveBtnState();
      };
    }

    const cancelBtn = document.getElementById("cancelFormBtn");
    if (cancelBtn) {
      cancelBtn.onclick = () => this.router.navigate("#/");
    }

    const saveBtn = document.getElementById("saveTicketBtn");
    if (saveBtn) {
      saveBtn.onclick = async () => {
        const addressData = this.addressPicker
          ? this.addressPicker.getValue()
          : null;
        const details = document.getElementById("formDetails").value.trim();
        const staffId = this.staffSelect ? this.staffSelect.getValue() : null;

        if (!addressData || !details) {
          const msg =
            "Заполните обязательные поля: выберите адрес и введите описание проблемы.";
          notify.error(msg);
          logHistoryAction(msg);
          return;
        }

        if (this.repairPicker && !this.repairPicker.isValid()) {
          const msg =
            "Дата ремонта указана некорректно: должна быть не менее чем через 25 минут от текущего момента.";
          notify.error(msg);
          logHistoryAction(msg);
          return;
        }

        if (
          !this.deptSelect?.isValid() ||
          !this.reqSelect?.isValid() ||
          !this.groupSelect?.isValid()
        ) {
          const msg = "Пожалуйста, выберите отдел, тип запроса и группу.";
          notify.error(msg);
          logHistoryAction(msg);
          return;
        }

        // Собираем чистый payload (без action) для онлайн и офлайн режимов
        const newTicketPayload = this._buildCallnewPayload(
          addressData,
          details,
          staffId,
        );

        this._lockForm();
        this._setSaveBtnState("loading");

        if (!navigator.onLine) {
          await this._saveOffline(newTicketPayload, globalTicketsArrayRef);
          return;
        }

        try {
          // ДОБАВЛЯЕМ action: 'callnew' К PAYLOAD
          const response = await this.api.post(
            { action: "callnew", ...newTicketPayload },
            "Запись инцидента...",
          );

          if (response && response.code === "network_error") {
            await this._saveOffline(newTicketPayload, globalTicketsArrayRef);
            return;
          }

          if (response && response.status === "ok") {
            this._clearDraft();
            this._setSaveBtnState("success");
            const msg = response.message || "Заявка зарегистрирована.";
            logHistoryAction(msg);
            notify.success(msg);

            // ВАРИАНТ B: Запрашиваем свежий список открытых заявок
            try {
              const freshOpen = await this.api.post(
                { data: "open" },
                null, // silent, без статус-бара
                "global",
              );
              if (Array.isArray(freshOpen)) {
                globalTicketsArrayRef.length = 0;
                globalTicketsArrayRef.push(...freshOpen);
              }
            } catch (e) {
              console.warn(
                "[CreateController] Не удалось обновить список open",
                e,
              );
              // Даже если не удалось обновить, заявка на сервере создана.
              // Просто перекидываем пользователя.
            }

            if (this.autoReturnTimer) clearTimeout(this.autoReturnTimer);
            this.autoReturnTimer = setTimeout(() => {
              this.router.navigate("#/");
            }, UI.AUTO_RETURN_MS);
          } else {
            const msg =
              (response && response.message) || "Не удалось создать заявку.";
            this._setSaveBtnState("error");
            logHistoryAction(msg);
            notify.error(msg);

            if (this.autoReturnTimer) clearTimeout(this.autoReturnTimer);
            this.autoReturnTimer = setTimeout(() => {
              this._unlockForm();
              this._setSaveBtnState("idle");
            }, UI.ERROR_UNLOCK_MS);
          }
        } catch (err) {
          console.error("[CreateController] Save error:", err);
          await this._saveOffline(newTicketPayload, globalTicketsArrayRef);
        }
      };
    }
  }

  /**
   * Формирует объект заявки в строгом соответствии с API_PROTOCOL.md v4.0
   * (Без action, без staff_date, без старых полей)
   */
  _buildCallnewPayload(addressData, details, staffId) {
    return {
      city_id: addressData.city_id,
      street_id: addressData.street_id,
      home_id: addressData.home_id,
      object_id: addressData.object_id,
      fullAddress: addressData.address, // Маппинг из address-picker
      group_id: this.groupSelect?.getValue() || null,
      request_id: this.reqSelect?.getValue() || null,
      department_id: this.deptSelect?.getValue() || null,
      repair_time: this.repairPicker ? this.repairPicker.getTimestamp() : null,
      details: details,
      staff_id: staffId || null,
    };
  }

  _saveDraft() {
    const details = document.getElementById("formDetails")?.value || "";
    const address = this.addressPicker?.getValue();
    const staffId = this.staffSelect?.getValue();
    const dept = this.deptSelect?.getValue();
    const req = this.reqSelect?.getValue();
    const grp = this.groupSelect?.getValue();
    const repair = this.repairPicker?.getTimestamp();

    if (!details && !address) return;

    const draft = { details, address, staffId, dept, req, grp, repair };
    sessionStorage.setItem("create_draft", JSON.stringify(draft));
  }

  _clearDraft() {
    sessionStorage.removeItem("create_draft");
  }

  _checkDraft() {
    const raw = sessionStorage.getItem("create_draft");
    if (!raw) return;
    try {
      const draft = JSON.parse(raw);
      if (
        confirm("Найден несохраненный черновик заявки. Восстановить данные?")
      ) {
        if (draft.details)
          document.getElementById("formDetails").value = draft.details;

        if (draft.address && this.addressPicker)
          this.addressPicker.setValue(draft.address);

        if (draft.dept && this.deptSelect) this.deptSelect.setValue(draft.dept);

        if (draft.req && this.reqSelect) this.reqSelect.setValue(draft.req);

        if (draft.grp && this.groupSelect) this.groupSelect.setValue(draft.grp);

        if (draft.staffId && this.staffSelect)
          this.staffSelect.setValue(draft.staffId);

        if (draft.repair && this.repairPicker)
          this.repairPicker.setValue(draft.repair);

        // Вызов this._updateSaveBtnState() удален,
        // так как методы setValue() сами триггерят onChange.
      } else {
        this._clearDraft();
      }
    } catch (e) {
      console.error("[CreateController] Draft restore error:", e);
    }
  }

  _lockForm() {
    this.isLocked = true;
    const wrapper = document.querySelector(".create-form-wrapper");
    if (wrapper) wrapper.classList.add("create-form-locked");
  }

  _unlockForm() {
    this.isLocked = false;
    const wrapper = document.querySelector(".create-form-wrapper");
    if (wrapper) wrapper.classList.remove("create-form-locked");
  }

  _setSaveBtnState(state) {
    const btn = document.getElementById("saveTicketBtn");
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
      btn.textContent = "Сохранить заявку";
      this._updateSaveBtnState();
    }
  }

  _updateSaveBtnState() {
    const btn = document.getElementById("saveTicketBtn");
    if (!btn || this.isLocked) return;

    const formDetails = document.getElementById("formDetails");
    const hasCaps =
      formDetails && VALIDATION.CAPS_REGEX.test(formDetails.value);

    const allFilled =
      this.addressPicker?.isValid() &&
      this.deptSelect?.isValid() &&
      this.reqSelect?.isValid() &&
      this.groupSelect?.isValid() &&
      !hasCaps;

    btn.disabled = !allFilled;
    btn.style.opacity = allFilled ? "1" : "0.5";
    btn.style.cursor = allFilled ? "pointer" : "not-allowed";
  }

  async _saveOffline(ticketPayload, globalTicketsArrayRef) {
    try {
      const count = await offlineDB.getOutboxCount();
      if (count >= OFFLINE.MAX_OFFLINE_TICKETS) {
        this._setSaveBtnState("error");
        const msg = `Достигнут лимит офлайн-заявок (${OFFLINE.MAX_OFFLINE_TICKETS}). Дождитесь синхронизации.`;
        notify.error(msg);
        logHistoryAction(msg);
        setTimeout(() => {
          this._unlockForm();
          this._setSaveBtnState("idle");
        }, UI.ERROR_UNLOCK_MS);
        return;
      }

      const user = authStore.getUser();
      const uuid =
        "offline_" + Date.now() + "_" + Math.random().toString(36).substr(2, 5);

      const offlineTicket = {
        uuid: uuid,
        offline_uuid: uuid,
        offline_author_id: user ? user.id : 0,
        offline_author_name: user ? user.name : "Неизвестный",
        payload: ticketPayload, // чистый payload без action
        created_at: nowTs(),
      };

      await offlineDB.addToOutbox(offlineTicket);

      this._setSaveBtnState("success");
      const msg =
        "Заявка сохранена локально (нет сети). Синхронизация при восстановлении связи.";
      notify.info(msg);
      logHistoryAction(msg);

      // Временно добавляем в память для отображения в журнале
      globalTicketsArrayRef.unshift({
        ...ticketPayload,
        id: uuid,
        type: "open",
        address: ticketPayload.fullAddress, // маппинг для таблицы
        date: new Date().toLocaleString("ru"), // временная дата для UI
        isOffline: true,
      });

      if (this.autoReturnTimer) clearTimeout(this.autoReturnTimer);
      this.autoReturnTimer = setTimeout(() => {
        this.router.navigate("#/");
      }, UI.AUTO_RETURN_MS);
    } catch (e) {
      console.error("[CreateController] Offline save error:", e);
      this._setSaveBtnState("error");
      notify.error("Сбой локальной базы данных.");
      setTimeout(() => {
        this._unlockForm();
        this._setSaveBtnState("idle");
      }, UI.ERROR_UNLOCK_MS);
    }
  }

  unmount() {
    destroyVoiceInput();
    this._unlockForm();
    this.prefilledAddress = null;
    this.api.abortTag("create");
    if (this.autoReturnTimer) {
      clearTimeout(this.autoReturnTimer);
      this.autoReturnTimer = null;
    }

    [
      "staffSelect",
      "repairPicker",
      "deptSelect",
      "reqSelect",
      "groupSelect",
      "addressPicker",
    ].forEach((name) => {
      const comp = this[name];
      if (comp && typeof comp.destroy === "function") comp.destroy();
      this[name] = null;
    });
  }
}
