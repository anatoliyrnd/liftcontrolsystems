import { notify } from "./components/notify.js";
import { logHistoryAction } from "./history-logger.js";
import { UI } from "./config.js";
import { appState } from "./app-state.js";
import { nowTs } from "./utils/date-utils.js";
import { createCreateFormView } from "./create/views/create-form-view.js";
import { createRepository } from "./create/create-repository.js";
import { duplicateTicketModal } from "./components/duplicate-ticket-modal.js";
import { authStore } from "./auth-store.js";

/**
 * Экран создания заявки.
 * Владение DOM: _mountId растёт в mount/unmount, после каждого await —
 * isStale() перед обращением к форме, кнопке или навигации.
 * Офлайн-ветка только при фактическом отсутствии сети: сетевой отказ
 * api.post приходит объектом { code: "network_error" }, а не исключением.
 * Произвольная ошибка (в т.ч. после уже успешного ответа сервера при
 * уходе с экрана) НЕ создаёт офлайн-дубль.
 */
export class CreateController {
    constructor(apiInstance, routerInstance) {
        this.api = apiInstance;
        this.router = routerInstance;
        this.autoReturnTimer = null;
        this.errorUnlockTimer = null;
        this.formView = null;
        this._saving = false;
        this._mountId = 0;
    }

    mount(globalTicketsArrayRef) {
        this._mountId++;

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
        const myMountId = this._mountId;
        const isStale = () => this._mountId !== myMountId || !this.formView;

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
                await this._handleOfflineSave(payload, globalTicketsArrayRef, myMountId);
                return;
            }

            const response = await createRepository.saveOnline(this.api, payload);

            if (response && response._authLost) {
                if (!isStale()) {
                    this._setSaveBtnState("idle");
                    this.formView.unlock();
                }
                return;
            }

            // api-service ставит offline: true трём кодам: network_error,
            // aborted (таймаут 15 с), invalid_response (не-JSON). Работа не
            // должна теряться ни в одном из них. Сохранение в outbox не
            // трогает DOM — выполняем даже если экран уже сменился.
            if (response && response.offline === true) {
                await this._handleOfflineSave(
                    payload,
                    globalTicketsArrayRef,
                    myMountId,
                    response,
                );
                return;
            }

            if (isStale()) return;

            const isDuplicate =
                response &&
                (response.code === "duplicate_detected" ||
                    response.reason === "duplicate_detected" ||
                    response.status === "duplicate_detected" ||
                    (typeof response.message === "string" &&
                        response.message.includes("duplicate_detected")));
            if (isDuplicate) {
                await this._handleDuplicate(response, payload, globalTicketsArrayRef, myMountId);
                return;
            }

            if (response && response.status === "ok") {
                this._setSaveBtnState("success");
                const msg = response.message || "Заявка зарегистрирована.";
                logHistoryAction(msg);
                notify.success(msg);
                await this._refreshOpenList(globalTicketsArrayRef);
                if (isStale()) return;
                this.formView.reset();
                this._scheduleReturn();
            } else {
                const msg = (response && response.message) || "Не удалось создать заявку.";
                this._setSaveBtnState("error");
                logHistoryAction(msg);
                notify.error(msg);
                this._scheduleUnlock();
            }
        } catch (err) {
            console.error("[CreateController] Save error:", err);
            if (isStale()) return;
            // Исключение при живой сети — сбой UI/кода, а не отказ канала:
            // офлайн-дубль из него не делаем.
            if (!navigator.onLine) {
                await this._handleOfflineSave(payload, globalTicketsArrayRef, myMountId);
            } else {
                this._setSaveBtnState("error");
                notify.error("Не удалось создать заявку. Попробуйте ещё раз.");
                this._scheduleUnlock();
            }
        } finally {
            if (this._mountId === myMountId) this._saving = false;
        }
    }
  async _handleOfflineSave(payload, globalTicketsArrayRef, myMountId, networkResp = null) {
        const isStale = () => this._mountId !== myMountId || !this.formView;
        // network_error — запрос точно не дошёл. aborted / invalid_response —
        // сервер мог применить запрос, но результат не подтверждён.
        const uncertain =
            networkResp != null && networkResp.code !== "network_error";
        try {
            const result = await createRepository.saveOffline(payload);
            if (!result.ok) {
                if (isStale()) return;
                this._setSaveBtnState("error");
                const msg = "Достигнут лимит офлайн-заявок. Дождитесь синхронизации.";
                notify.error(msg);
                logHistoryAction(msg);
                this._scheduleUnlock();
                return;
            }

            if (uncertain) {
                notify.offline(
                    "Сервер не подтвердил создание. Заявка сохранена локально. Если она уже создана — при синхронизации появится дубликат, удалите его в очереди.",
                    { timeout: 0, persistent: true },
                );
                logHistoryAction(
                    `Заявка сохранена локально: сервер не подтвердил создание (${networkResp.code}). При синхронизации возможна проверка дубликата.`,
                );
            } else {
                notify.offline(
                    "Заявка сохранена. Будет синхронизирована при восстановлении сети.",
                );
                logHistoryAction("Заявка сохранена локально (нет сети).");
            }

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
            if (isStale()) return;
            this._setSaveBtnState("success");
            this.formView.reset();
            this._scheduleReturn();
        } catch (e) {
            console.error("[CreateController] Offline save error:", e);
            if (isStale()) return;
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
        this._mountId++;
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