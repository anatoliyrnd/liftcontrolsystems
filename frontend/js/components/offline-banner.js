/**
 * Плашка «Вы офлайн / есть несинхронизированные действия».
 * Показывается под шапкой, если:
 *   - navigator.onLine = false, ИЛИ
 *   - есть проблемы с сетью/сервером (api-error), ИЛИ
 *   - pending + failed > 0.
 */
import { offlineDB } from "../offline-db.js";
import { onlineStatus } from "../utils/online-status.js";

class OfflineBanner {
  constructor() {
    this.el = null;
    this.textEl = null;
    this.btn = null;
    this._isOnline = true;
    this._isApiHealthy = true; // 🔥 Статус связи с сервером
    this._counts = { pending: 0, failed: 0 };

    // Таймеры для антидребезга
    this._showTimer = null;
    this._hideTimer = null;

    this._onRefresh = this._onRefresh.bind(this);
    this._onOnlineChange = this._onOnlineChange.bind(this);
    this._onApiError = this._onApiError.bind(this);
    this._onApiSuccess = this._onApiSuccess.bind(this);
    this._unsubscribe = null;
  }

  init() {
    this.el = document.getElementById("offlineBanner");
    if (!this.el) return;
    this.textEl = this.el.querySelector(".offline-banner-text");
    this.btn = this.el.querySelector(".offline-banner-btn");

    if (this.btn) {
      this.btn.onclick = (e) => {
        e.preventDefault();
        window.dispatchEvent(new Event("triggerSync"));
      };
    }

    this._unsubscribe = onlineStatus.subscribe(this._onOnlineChange);
    window.addEventListener("refreshSyncState", this._onRefresh);

    // 🔥 Подписываемся на новые события от api-service
    window.addEventListener("app:network-error", this._onApiError);
    window.addEventListener("app:network-success", this._onApiSuccess);

    this._onRefresh();
  }

  _onOnlineChange(isOnline) {
    this._isOnline = isOnline;
    this._render();
  }

  // 🔥 Логика при ошибке сети (ждем 3 секунды перед показом)
  _onApiError() {
    if (this._hideTimer) {
      clearTimeout(this._hideTimer);
      this._hideTimer = null;
    }

    if (this._showTimer || !this._isApiHealthy) return; // Таймер уже идет или баннер уже показан

    this._showTimer = setTimeout(() => {
      this._showTimer = null;
      this._isApiHealthy = false;
      this._render();
    }, 3000);
  }

  // 🔥 Логика при успешном запросе (ждем 2 секунды перед скрытием)
  _onApiSuccess() {
    if (this._showTimer) {
      clearTimeout(this._showTimer);
      this._showTimer = null;
    }

    if (this._hideTimer || this._isApiHealthy) return; // Таймер уже идет или баннер уже скрыт

    this._hideTimer = setTimeout(() => {
      this._hideTimer = null;
      this._isApiHealthy = true;
      this._render();
    }, 2000);
  }

  async _onRefresh() {
    const [pending, failed] = await Promise.all([
      offlineDB.getOutboxCount(),
      offlineDB.getFailedCount(),
    ]);
    this._counts = { pending, failed };
    this._render();
  }

  _render() {
    if (!this.el) return;
    const total = this._counts.pending + this._counts.failed;

    // Проверяем, надо ли показывать баннер вообще
    const shouldShow = !this._isOnline || !this._isApiHealthy || total > 0;

    if (!shouldShow) {
      this.el.style.display = "none";
      return;
    }

    this.el.style.display = "flex";
    this.el.classList.toggle("offline-banner--error", this._counts.failed > 0);

    let text;
    if (!this._isOnline) {
      // Жесткий офлайн (нет интернета)
      text =
        total === 0
          ? "Вы работаете офлайн. Действия будут сохранены локально."
          : `Вы офлайн. ${total} действий ждут синхронизации.`;
    } else if (!this._isApiHealthy) {
      // Интернет есть, но сервер недоступен
      text = "Проблемы с соединением. Сервер временно недоступен.";
      this.el.classList.add("offline-banner--error");
    } else if (this._counts.failed > 0) {
      text = `Не удалось синхронизировать ${this._counts.failed} действий. Попробуйте снова.`;
    } else {
      text = `Ожидает синхронизации: ${this._counts.pending}.`;
    }

    if (this.textEl) this.textEl.textContent = text;
    if (this.btn) {
      this.btn.style.display =
        this._isOnline && this._isApiHealthy ? "inline-flex" : "none";
    }
  }
}

export const offlineBanner = new OfflineBanner();
