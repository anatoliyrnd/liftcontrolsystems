import { notify } from "./components/notify.js";
import { logHistoryAction } from "./history-logger.js";
import { UI } from "./config.js";
import { appState } from "./app-state.js";
import { nowTs } from "./utils/date-utils.js";
import { createCreateFormView } from "./create/views/create-form-view.js";
import { createRepository } from "./create/create-repository.js";
import { duplicateTicketModal } from "./components/duplicate-ticket-modal.js";
import { authStore } from "./auth-store.js";

export class CreateController {
  constructor(apiInstance, routerInstance) {
    this.api = apiInstance;
    this.router = routerInstance;
    this.autoReturnTimer = null;
    this.errorUnlockTimer = null;
    this.formView = null;
    this._saving = false;
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

    this.formView = createCreateFormView({ onChange: () => {} });
    this.formView.mount(prefilledAddress);

    const cancelBtn = document.getElementById("cancelFormBtn");
    if (cancelBtn) cancelBtn.onclick = () => this.router.navigate("#/");

    const saveBtn = document.getElementById("saveTicketBtn");
    if (saveBtn) saveBtn.onclick = () => this._onSave(globalTicketsArrayRef);
  }

  /** Атомарная замена глобального списка (п. 1.17). */
  async _refreshOpenList(globalTicketsArrayRef) {
    if (!Array.isArray(globalTicketsArrayRef)) return;
    try {
      const freshOpen = await this.api.post({ data: "open" }, null, "global");
      if (Array.isArray(freshOpen)) {
        const localOnly = globalTicketsArrayRef.filter((t) => t.isOffline);
        for (const item of freshOpen) {
          item.type = "open";
          if (!item.address && item.fullAddress)
            item.address = item.fullAddress;
        }
        globalTicketsArrayRef.splice(
          0,
          globalTicketsArrayRef.length,
          ...localOnly,
          ...freshOpen,
        );
      }
    } catch (e) {
      console.warn("[CreateController] Не удалось обновить список open", e);
    }
  }

  _scheduleReturn() {
    if (this.autoReturnTimer) clearTimeout(this.autoReturnTimer);
    this.autoReturnTimer = setTimeout(
      () => this.router.navigate("#/"),
      UI.AUTO_RETURN_MS,
    );
  }

  _scheduleUnlock() {
    if (this.errorUnlockTimer) clearTimeout(this.errorUnlockTimer);
    this.errorUnlockTimer = setTimeout(() => {
      this.formView?.unlock();
      this._setSaveBtnState("idle");
    }, UI.ERROR_UNLOCK_MS);
  }

  async _onSave(globalTicketsArrayRef) {
    if (this._saving || !this.formView) return;

    const validation = this.formView.isValid();
    if (!validation.ok) {
      notify.error(validation.msg);
      logHistoryAction(validation.msg);
      return;
    }

    const payload = this.formView.getPayload();
    this._saving = true;
    this.formView.lock();
    this._setSaveBtnState("loading");

    try {
      if (!navigator.onLine) {
        await this._handleOfflineSave(payload, globalTicketsArrayRef);
        return;
      }

      const response = await createRepository.saveOnline(this.api, payload);

      if (response && response.code === "network_error") {
        await this._handleOfflineSave(payload, globalTicketsArrayRef);
        return;
      }
      if (response && response._authLost) {
        this._setSaveBtnState("idle");
        this.formView.unlock();
        return;
      }

      const isDuplicate =
        response &&
        (response.code === "duplicate_detected" ||
          response.reason === "duplicate_detected" ||
          response.status === "duplicate_detected" ||
          (typeof response.message === "string" &&
            response.message.includes("duplicate_detected")));

      if (isDuplicate) {
        await this._handleDuplicate(response, payload, globalTicketsArrayRef);
        return;
      }

      if (response && response.status === "ok") {
        this._setSaveBtnState("success");
        const msg = response.message || "Заявка зарегистрирована.";
        logHistoryAction(msg);
        notify.success(msg);
        await this._refreshOpenList(globalTicketsArrayRef);
        this.formView.reset();
        this._scheduleReturn();
      } else {
        const msg =
          (response && response.message) || "Не удалось создать заявку.";
        this._setSaveBtnState("error");
        logHistoryAction(msg);
        notify.error(msg);
        this._scheduleUnlock();
      }
    } catch (err) {
      console.error("[CreateController] Save error:", err);
      await this._handleOfflineSave(payload, globalTicketsArrayRef);
    } finally {
      this._saving = false;
    }
  }

  async _handleDuplicate(response, payload, globalTicketsArrayRef) {
    this.formView.unlock();
    this._setSaveBtnState("idle");

    let existingTickets =
      response.existing_tickets || response.data?.existing_tickets || [];

    if (
      existingTickets.length === 0 &&
      typeof response.message === "string" &&
      response.message.includes("[")
    ) {
      try {
        existingTickets = JSON.parse(
          response.message.substring(response.message.indexOf("[")),
        );
      } catch (e) {
        console.warn(
          "[CreateController] Не удалось распарсить existing_tickets",
          e,
        );
      }
    }

    const userName = authStore.getUser()?.name || "вами";
    const confirmed = await duplicateTicketModal.show(
      { ...payload, offline_author_name: userName },
      existingTickets,
    );

    if (!confirmed) {
      this._setSaveBtnState("idle");
      notify.info("Создание заявки отменено.");
      return;
    }

    this._setSaveBtnState("loading");
    this.formView.lock();

    try {
      const forceResponse = await createRepository.saveOnline(
        this.api,
        payload,
        {
          force_create: true,
        },
      );

      if (forceResponse && forceResponse.status === "ok") {
        this._setSaveBtnState("success");
        notify.success(forceResponse.message || "Заявка создана (дубликат).");
        logHistoryAction("Создана заявка (дубликат).");
        await this._refreshOpenList(globalTicketsArrayRef);
        this.formView.reset();
        this._scheduleReturn();
      } else {
        throw new Error(
          forceResponse?.message || "Ошибка при создании дубликата",
        );
      }
    } catch (err) {
      console.error("[CreateController] Force create error:", err);
      this._setSaveBtnState("error");
      notify.error(err.message || "Не удалось создать дубликат.");
      this._scheduleUnlock();
    }
  }

  async _handleOfflineSave(payload, globalTicketsArrayRef) {
    try {
      const result = await createRepository.saveOffline(payload);

      if (!result.ok) {
        this._setSaveBtnState("error");
        const msg = "Достигнут лимит офлайн-заявок. Дождитесь синхронизации.";
        notify.error(msg);
        logHistoryAction(msg);
        this._scheduleUnlock();
        return;
      }

      this._setSaveBtnState("success");
      notify.offline(
        "Заявка сохранена. Будет синхронизирована при восстановлении сети.",
      );
      logHistoryAction("Заявка сохранена локально (нет сети).");

      if (Array.isArray(globalTicketsArrayRef)) {
        globalTicketsArrayRef.unshift({
          ...payload,
          id: result.offlineUuid,
          offline_uuid: result.offlineUuid,
          call_number: result.offlineUuid,
          type: "open",
          address: payload.fullAddress,
          date: nowTs(),
          repair_time: null,
          isOffline: true,
        });
      }

      this.formView.reset();
      this._scheduleReturn();
    } catch (e) {
      console.error("[CreateController] Offline save error:", e);
      this._setSaveBtnState("error");
      notify.error("Сбой локальной базы данных.");
      this._scheduleUnlock();
    }
  }

  _setSaveBtnState(state) {
    const btn = document.getElementById("saveTicketBtn");
    if (!btn) return;
    btn.classList.remove("btn-loading", "btn-success", "btn-error");

    if (state === "loading" || state === "success" || state === "error") {
      btn.disabled = true;
      btn.classList.add("btn-" + state);
      btn.textContent = "";
    } else {
      btn.textContent = "Сохранить заявку";
      this.formView?.unlock();
    }
  }

  unmount() {
    this.formView?.destroy();
    this.formView = null;
    this._saving = false;
    this.api.abortTag("create");

    if (this.autoReturnTimer) {
      clearTimeout(this.autoReturnTimer);
      this.autoReturnTimer = null;
    }
    if (this.errorUnlockTimer) {
      clearTimeout(this.errorUnlockTimer);
      this.errorUnlockTimer = null;
    }
  }
}
