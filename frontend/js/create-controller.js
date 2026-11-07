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
      // 🔥 ПЕРЕХВАТ ДУБЛИКАТА ОТ СЕРВЕРА (ОНЛАЙН)
      // Проверяем все возможные варианты ответа сервера
      const isDuplicate = response && (
          response.code === "duplicate_detected" ||
          response.status === "duplicate_detected" ||
          (typeof response.message === "string" && response.message.includes("duplicate_detected"))
      );

      if (isDuplicate) {
        this.formView.unlock();
        this._setSaveBtnState("idle");

        // Пытаемся достать массив существующих заявок
        let existingTickets = response.existing_tickets || response.data?.existing_tickets || [];
        
        // Если сервер засунул массив в строку message (как на скрине), пробуем его вытащить
        if (existingTickets.length === 0 && typeof response.message === "string" && response.message.includes("[")) {
            try {
                const jsonStr = response.message.substring(response.message.indexOf("["));
                existingTickets = JSON.parse(jsonStr);
            } catch (e) {
                console.warn("[CreateController] Не удалось распарсить existing_tickets из message", e);
            }
        }
        
        // Передаем payload как record (модалке нужен этот объект для отображения)
        const userName = authStore.getUser()?.name || "вами";
        const mockRecord = { ...payload, offline_author_name: userName };
        
        const confirmed = await duplicateTicketModal.show(mockRecord, existingTickets);
        
        if (confirmed) {
            this._setSaveBtnState("loading");
            this.formView.lock();
            try {
                // Отправляем повторно с force_create: true
                const forceResponse = await createRepository.saveOnline(this.api, payload, { force_create: true });
                
                if (forceResponse && forceResponse.status === "ok") {
                    this._setSaveBtnState("success");
                    notify.success(forceResponse.message || "Заявка создана (дубликат).");
                    logHistoryAction("Создана заявка (дубликат).");
                    
                    // Обновляем глобальный список через безопасный splice
                    try {
                      const freshOpen = await this.api.post({ data: "open" }, null, "global");
                      if (Array.isArray(freshOpen)) {
                        globalTicketsArrayRef.splice(0, globalTicketsArrayRef.length, ...freshOpen);
                      }
                    } catch (e) { /* ignore */ }

                    this.formView.reset();
                    setTimeout(() => this.router.navigate("#/"), UI.AUTO_RETURN_MS);
                } else {
                    throw new Error(forceResponse?.message || "Ошибка при создании дубликата");
                }
            } catch (err) {
                console.error("[CreateController] Force create error:", err);
                this._setSaveBtnState("error");
                notify.error(err.message || "Не удалось создать дубликат.");
                setTimeout(() => {
                    this.formView.unlock();
                    this._setSaveBtnState("idle");
                }, UI.ERROR_UNLOCK_MS);
            }
        } else {
            // Пользователь нажал "Отмена"
            this._setSaveBtnState("idle");
            notify.info("Создание заявки отменено.");
        }
        return; // Прерываем дальнейшую обработку
      }
      if (response && response.status === "ok") {
        this._setSaveBtnState("success");
        const msg = response.message || "Заявка зарегистрирована.";
        logHistoryAction(msg);
        notify.success(msg);

        // Обновляем глобальный список
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

        // Вызываем reset() ТОЛЬКО когда всё успешно.
        // Если reset упадет, это не вызовет _handleOfflineSave.
        this.formView.reset();

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
      // Сюда попадают только реальные сетевые сбои от createRepository.saveOnline
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

      // Вызываем reset() здесь
      this.formView.reset();

      if (this.autoReturnTimer) clearTimeout(this.autoReturnTimer);
      this.autoReturnTimer = setTimeout(
        () => this.router.navigate("#/"),
        UI.AUTO_RETURN_MS,
      );
    } catch (e) {
      // Сюда попадут только реальные ошибки IndexedDB
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
