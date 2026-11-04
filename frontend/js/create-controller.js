import { notify } from "./components/notify.js";
import { logHistoryAction } from "./history-logger.js";
import { UI } from "./config.js";
import { appState } from "./app-state.js";
import { nowTs } from "./utils/date-utils.js";
import { createCreateFormView } from "./create/views/create-form-view.js";
import { createRepository } from "./create/create-repository.js";

export class CreateController {
  constructor(apiInstance, routerInstance) {
    this.api = apiInstance;
    this.router = routerInstance;
    this.autoReturnTimer = null;
    this.formView = null;
  }

  mount(globalTicketsArrayRef) {
    let prefilledAddress = null;
    if (appState.pendingCreateAddress) {
      prefilledAddress = appState.pendingCreateAddress;
      appState.pendingCreateAddress = null;
      sessionStorage.removeItem("create_draft");
      const h1 =
        document.querySelector(".create-form-wrapper h1") ||
        document.querySelector("h1");
      if (h1 && prefilledAddress.from_ticket_id) {
        h1.textContent =
          "Новая заявка для объекта из заявки №" +
          prefilledAddress.from_ticket_id;
      }
    }

    this.formView = createCreateFormView({
      onChange: () => {}, // View сам управляет состоянием кнопки "Сохранить"
    });
    this.formView.mount(prefilledAddress);

    const cancelBtn = document.getElementById("cancelFormBtn");
    if (cancelBtn) cancelBtn.onclick = () => this.router.navigate("#/");

    const saveBtn = document.getElementById("saveTicketBtn");
    if (saveBtn) saveBtn.onclick = () => this._onSave(globalTicketsArrayRef);
  }

  async _onSave(globalTicketsArrayRef) {
    const validation = this.formView.isValid();
    if (!validation.ok) {
      notify.error(validation.msg);
      logHistoryAction(validation.msg);
      return;
    }

    const payload = this.formView.getPayload();
    this.formView.lock();
    this._setSaveBtnState("loading");

    if (!navigator.onLine) {
      await this._handleOfflineSave(payload, globalTicketsArrayRef);
      return;
    }

    try {
      const response = await createRepository.saveOnline(this.api, payload);

      if (response && response.code === "network_error") {
        await this._handleOfflineSave(payload, globalTicketsArrayRef);
        return;
      }

      if (response && response.status === "ok") {
        this.formView.reset();
        this._setSaveBtnState("success");
        const msg = response.message || "Заявка зарегистрирована.";
        logHistoryAction(msg);
        notify.success(msg);

        try {
          const freshOpen = await this.api.post(
            { data: "open" },
            null,
            "global",
          );
          if (Array.isArray(freshOpen)) {
            globalTicketsArrayRef.length = 0;
            globalTicketsArrayRef.push(...freshOpen);
          }
        } catch (e) {
          console.warn("[CreateController] Не удалось обновить список open", e);
        }

        if (this.autoReturnTimer) clearTimeout(this.autoReturnTimer);
        this.autoReturnTimer = setTimeout(
          () => this.router.navigate("#/"),
          UI.AUTO_RETURN_MS,
        );
      } else {
        const msg =
          (response && response.message) || "Не удалось создать заявку.";
        this._setSaveBtnState("error");
        logHistoryAction(msg);
        notify.error(msg);
        if (this.autoReturnTimer) clearTimeout(this.autoReturnTimer);
        this.autoReturnTimer = setTimeout(() => {
          this.formView.unlock();
          this._setSaveBtnState("idle");
        }, UI.ERROR_UNLOCK_MS);
      }
    } catch (err) {
      console.error("[CreateController] Save error:", err);
      await this._handleOfflineSave(payload, globalTicketsArrayRef);
    }
  }

  async _handleOfflineSave(payload, globalTicketsArrayRef) {
    try {
      const result = await createRepository.saveOffline(payload);
      if (!result.ok) {
        this._setSaveBtnState("error");
        const msg = `Достигнут лимит офлайн-заявок. Дождитесь синхронизации.`;
        notify.error(msg);
        logHistoryAction(msg);
        setTimeout(() => {
          this.formView.unlock();
          this._setSaveBtnState("idle");
        }, UI.ERROR_UNLOCK_MS);
        return;
      }

      this.formView.reset();
      this._setSaveBtnState("success");
      notify.offline(
        "Заявка сохранена. Будет синхронизирована при восстановлении сети.",
      );
      logHistoryAction("Заявка сохранена локально (нет сети).");

      globalTicketsArrayRef.unshift({
        ...payload,
        id: result.offlineUuid,
        offline_uuid: result.offlineUuid,
        type: "open",
        address: payload.fullAddress,
        date: nowTs(),
        isOffline: true,
      });

      if (this.autoReturnTimer) clearTimeout(this.autoReturnTimer);
      this.autoReturnTimer = setTimeout(
        () => this.router.navigate("#/"),
        UI.AUTO_RETURN_MS,
      );
    } catch (e) {
      console.error("[CreateController] Offline save error:", e);
      this._setSaveBtnState("error");
      notify.error("Сбой локальной базы данных.");
      setTimeout(() => {
        this.formView.unlock();
        this._setSaveBtnState("idle");
      }, UI.ERROR_UNLOCK_MS);
    }
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
      // Состояние кнопки (disabled/opacity) восстановит сам View
      if (this.formView) this.formView.unlock();
    }
  }

  unmount() {
    if (this.formView) {
      this.formView.destroy();
      this.formView = null;
    }
    this.api.abortTag("create");
    if (this.autoReturnTimer) {
      clearTimeout(this.autoReturnTimer);
      this.autoReturnTimer = null;
    }
  }
}
