import { notify } from "./components/notify.js";
import { logHistoryAction } from "./history-logger.js";
import { UI } from "./config.js";
import { appState } from "./app-state.js";
import { nowTs } from "./utils/date-utils.js";
import { createCreateFormView } from "./create/views/create-form-view.js";
import { createRepository } from "./create/create-repository.js";
import { duplicateTicketModal } from "./components/duplicate-ticket-modal.js";
import { authStore } from "./auth-store.js";

/** Ключ черновика формы (зеркалит DRAFT_KEY в create-form-view). */
const DRAFT_KEY = "create_draft";

/**
 * Экран создания заявки.
 *
 * Владение DOM: _mountId растёт в mount/unmount, после каждого await —
 * isStale() перед обращением к форме, кнопке или навигации.
 *
 * Целостность результата: как только сервер или outbox подтвердил
 * создание, операция выполнена. Любой последующий сбой интерфейса НЕ
 * превращается в сообщение об отказе — иначе диспетчер отправит форму
 * повторно и получит дубликат. Пост-коммитный UI изолирован по шагам.
 *
 * Офлайн-ветка только при отказе канала (resp.offline === true:
 * network_error, aborted/timeout, invalid_response) либо при отсутствии
 * сети. Произвольное исключение при живой сети — сбой кода, не канала.
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
      sessionStorage.removeItem(DRAFT_KEY);
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

  /** Шаг UI, который не имеет права уронить операцию. */
  _safeUi(label, fn) {
    try {
      fn();
    } catch (e) {
      console.warn(`[CreateController] UI «${label}» не выполнен:`, e);
    }
  }

  /**
   * Пост-коммитный UI после подтверждённого создания.
   * Ни один шаг не пробрасывает исключение наверх: заявка уже создана,
   * и сообщение об отказе здесь недопустимо.
   */
  async _finishSuccess(message, globalTicketsArrayRef, myMountId) {
    const isStale = () => this._mountId !== myMountId || !this.formView;

    this._safeUi("кнопка", () => this._setSaveBtnState("success"));
    this._safeUi("история", () => logHistoryAction(message));
    this._safeUi("уведомление", () => notify.success(message));

    try {
      await this._refreshOpenList(globalTicketsArrayRef);
    } catch (e) {
      console.warn("[CreateController] Журнал не обновлён:", e);
    }
    if (isStale()) return;

    this._safeUi("сброс формы", () => this.formView.reset());
    // Страховка: если reset упал на середине, черновик не должен
    // пережить уже созданную заявку — иначе следующий вход предложит дубль.
    this._safeUi("черновик", () => sessionStorage.removeItem(DRAFT_KEY));
    this._safeUi("автовозврат", () => this._scheduleReturn());
  }

  async _onSave(globalTicketsArrayRef) {
    if (this._saving || !this.formView) return;
    const myMountId = this._mountId;
    const isStale = () => this._mountId !== myMountId || !this.formView;

    // Этап — для диагностики: в консоли видно, где именно упало.
    let stage = "validate";
    // Коммит: сервер подтвердил создание. С этого момента показывать
    // «не удалось создать» нельзя ни при каких обстоятельствах.
    let committed = false;
    let commitMessage = "Заявка зарегистрирована.";

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
        stage = "offline-save";
        await this._handleOfflineSave(
          payload,
          globalTicketsArrayRef,
          myMountId,
        );
        return;
      }

      stage = "request";
      const response = await createRepository.saveOnline(this.api, payload);

      if (response && response._authLost) {
        if (!isStale()) {
          this._setSaveBtnState("idle");
          this.formView.unlock();
        }
        return;
      }

      // api-service ставит offline: true трём кодам: network_error,
      // aborted (таймаут), invalid_response. Работа не теряется ни в одном.
      if (response && response.offline === true) {
        stage = "offline-fallback";
        await this._handleOfflineSave(
          payload,
          globalTicketsArrayRef,
          myMountId,
          response,
        );
        return;
      }

      if (isStale()) return;

      stage = "duplicate-check";
      const isDuplicate =
        response &&
        (response.code === "duplicate_detected" ||
          response.reason === "duplicate_detected" ||
          response.status === "duplicate_detected" ||
          (typeof response.message === "string" &&
            response.message.includes("duplicate_detected")));
      if (isDuplicate) {
        await this._handleDuplicate(
          response,
          payload,
          globalTicketsArrayRef,
          myMountId,
        );
        return;
      }

      if (response && response.status === "ok") {
        committed = true;
        commitMessage = response.message || commitMessage;
        stage = "post-commit-ui";
        await this._finishSuccess(
          commitMessage,
          globalTicketsArrayRef,
          myMountId,
        );
        return;
      }

      stage = "server-refused";
      const msg =
        (response && response.message) || "Не удалось создать заявку.";
      this._setSaveBtnState("error");
      logHistoryAction(msg);
      notify.error(msg);
      this._scheduleUnlock();
    } catch (err) {
      console.error(`[CreateController] Save error на этапе «${stage}»:`, err);

      if (committed) {
        // Заявка создана. Сбой интерфейса не выглядит как отказ.
        logHistoryAction(
          "Заявка создана, но интерфейс не обновился: " +
            (err?.message || String(err)),
        );
        notify.warning("Заявка создана. Обновите журнал вручную.", {
          once: true,
        });
        if (!isStale()) {
          this._setSaveBtnState("success");
          this._scheduleReturn();
        }
        return;
      }

      if (isStale()) return;

      if (!navigator.onLine) {
        await this._handleOfflineSave(
          payload,
          globalTicketsArrayRef,
          myMountId,
        );
      } else {
        this._setSaveBtnState("error");
        notify.error("Не удалось создать заявку. Попробуйте ещё раз.");
        this._scheduleUnlock();
      }
    } finally {
      // Не сбрасываем _saving нового запуска, если этот уже устарел.
      if (this._mountId === myMountId) this._saving = false;
    }
  }

  async _handleDuplicate(response, payload, globalTicketsArrayRef, myMountId) {
    const isStale = () => this._mountId !== myMountId || !this.formView;
    if (isStale()) return;

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
    if (isStale()) return;
    if (!confirmed) {
      this._setSaveBtnState("idle");
      notify.info("Создание заявки отменено.");
      return;
    }

    this._setSaveBtnState("loading");
    this.formView.lock();

    let stage = "force-request";
    let committed = false;
    let commitMessage = "Заявка создана (дубликат).";

    try {
      const forceResponse = await createRepository.saveOnline(
        this.api,
        payload,
        {
          force_create: true,
        },
      );

      if (forceResponse && forceResponse.status === "ok") {
        committed = true;
        commitMessage = forceResponse.message || commitMessage;
        stage = "post-commit-ui";
        await this._finishSuccess(
          commitMessage,
          globalTicketsArrayRef,
          myMountId,
        );
        return;
      }

      // Таймаут force_create: сервер мог создать заявку. Уводим в outbox
      // БЕЗ force_create — сервер сам поднимет duplicate_detected, и
      // решение останется за пользователем в очереди.
      if (forceResponse && forceResponse.offline === true) {
        stage = "offline-fallback";
        await this._handleOfflineSave(
          payload,
          globalTicketsArrayRef,
          myMountId,
          forceResponse,
        );
        return;
      }

      stage = "server-refused";
      const msg =
        (forceResponse && forceResponse.message) ||
        "Не удалось создать дубликат.";
      this._setSaveBtnState("error");
      logHistoryAction(msg);
      notify.error(msg);
      this._scheduleUnlock();
    } catch (err) {
      console.error(
        `[CreateController] Force create error на этапе «${stage}»:`,
        err,
      );

      if (committed) {
        logHistoryAction(
          "Дубликат создан, но интерфейс не обновился: " +
            (err?.message || String(err)),
        );
        notify.warning("Заявка создана. Обновите журнал вручную.", {
          once: true,
        });
        if (!isStale()) {
          this._setSaveBtnState("success");
          this._scheduleReturn();
        }
        return;
      }

      if (isStale()) return;

      if (!navigator.onLine) {
        await this._handleOfflineSave(
          payload,
          globalTicketsArrayRef,
          myMountId,
        );
      } else {
        this._setSaveBtnState("error");
        notify.error(err?.message || "Не удалось создать дубликат.");
        this._scheduleUnlock();
      }
    }
  }

  async _handleOfflineSave(
    payload,
    globalTicketsArrayRef,
    myMountId,
    networkResp = null,
  ) {
    const isStale = () => this._mountId !== myMountId || !this.formView;
    // network_error — запрос точно не дошёл. aborted / invalid_response —
    // сервер мог применить запрос, но результат не подтверждён.
    const uncertain =
      networkResp != null && networkResp.code !== "network_error";

    let result;
    try {
      result = await createRepository.saveOffline(payload);
    } catch (e) {
      console.error("[CreateController] Offline save error:", e);
      if (isStale()) return;
      this._setSaveBtnState("error");
      notify.error("Сбой локальной базы данных.");
      this._scheduleUnlock();
      return;
    }

    if (!result || !result.ok) {
      if (isStale()) return;
      this._setSaveBtnState("error");
      const msg = "Достигнут лимит офлайн-заявок. Дождитесь синхронизации.";
      notify.error(msg);
      logHistoryAction(msg);
      this._scheduleUnlock();
      return;
    }

    // КОММИТ: запись в outbox состоялась. Дальше только UI —
    // его сбой не имеет права выглядеть как отказ записи.
    if (uncertain) {
      this._safeUi("уведомление", () =>
        notify.offline(
          "Сервер не подтвердил создание. Заявка сохранена локально. Если она уже создана — при синхронизации появится дубликат, удалите его в очереди.",
          { timeout: 0, persistent: true },
        ),
      );
      this._safeUi("история", () =>
        logHistoryAction(
          `Заявка сохранена локально: сервер не подтвердил создание (${networkResp.code}). При синхронизации возможна проверка дубликата.`,
        ),
      );
    } else {
      this._safeUi("уведомление", () =>
        notify.offline(
          "Заявка сохранена. Будет синхронизирована при восстановлении сети.",
        ),
      );
      this._safeUi("история", () =>
        logHistoryAction("Заявка сохранена локально (нет сети)."),
      );
    }

    this._safeUi("журнал", () => {
      if (!Array.isArray(globalTicketsArrayRef)) return;
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
    });

    if (isStale()) return;
    this._safeUi("кнопка", () => this._setSaveBtnState("success"));
    this._safeUi("черновик", () => sessionStorage.removeItem(DRAFT_KEY));
    this._safeUi("сброс формы", () => this.formView.reset());
    this._safeUi("автовозврат", () => this._scheduleReturn());
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
