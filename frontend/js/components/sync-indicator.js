/**
 * Индикатор очереди синхронизации в шапке (API_syncCommands.md v5.4 §13.3).
 *
 * Состояния (приоритет сверху вниз):
 *   ⏸ paused    — ручной режим (SyncManager.manualMode)
 *   🔴 error     — есть failed
 *   🟠 attention — есть needs_confirmation или rejected
 *   🟡 pending   — есть pending
 *   🟢 idle      — очередь пуста
 *
 * Единственный владелец #syncIndicator и .sync-indicator-badge.
 * _updateSyncButton в tickets-controller шапку не трогает.
 *
 * Клик → #/queue. Реакция на refreshSyncState. Прогресс «N/M» — sync:progress.
 */
import { offlineDB } from "../offline-db.js";

const PRIORITY = ["paused", "error", "attention", "pending", "idle"];

class SyncIndicator {
  constructor() {
    this.el = null;
    this.badge = null;
    this._last = {
      pending: -1,
      needs_confirmation: -1,
      failed: -1,
      rejected: -1,
      total: -1,
      manual: null,
    };
    this._progressActive = false;
    this._onRefresh = this._onRefresh.bind(this);
    this._onClick = this._onClick.bind(this);
    this._onProgress = this._onProgress.bind(this);
    this.progressLabel = null;
  }

init() {
    this.el = document.getElementById("syncIndicator");
    if (!this.el) return;
    this.badge = this.el.querySelector(".sync-indicator-badge");
    this.progressLabel = this.el.querySelector(".sync-indicator-progress");
    this.el.addEventListener("click", this._onClick);
    window.addEventListener("refreshSyncState", this._onRefresh);
    window.addEventListener("sync:progress", this._onProgress);
    this._onRefresh();
}

  _onClick() {
    window.location.hash = "#/queue";
  }

  async _onRefresh() {
    if (!this.el) return;
    let counts;
    try {
      counts = await offlineDB.getOutboxCounts();
    } catch (e) {
      console.warn("[sync-indicator] счётчики недоступны:", e);
      return;
    }
    this.update(counts);
  }

  /**
   * 2.6: прогресс «N из M» в бейдже во время активной синхронизации.
   * Не перебиваем paused/error/attention — они важнее.
   */
 _onProgress(e) {
    const p = e.detail;
    if (!p || !p.active || !p.total) {
        this._progressActive = false;
        if (this.progressLabel) this.progressLabel.textContent = "";
        return;
    }
    this._progressActive = true;
    // Label — чисто информационный, обновляем всегда (как делал менеджер).
    if (this.progressLabel) this.progressLabel.textContent = `${p.done} / ${p.total}`;
    const cls = this.el.classList;
    // paused/error/attention важнее прогресса — класс/бейдж не перебиваем.
    if (cls.contains("sync-paused") || cls.contains("sync-error") || cls.contains("sync-attention")) return;
    cls.remove("sync-idle");
    cls.add("sync-pending");
    this.el.title = `Синхронизация: ${Math.min(p.done + 1, p.total)} из ${p.total}`;
    if (this.badge) {
        this.badge.textContent = `${Math.min(p.done + 1, p.total)}/${p.total}`;
        this.badge.style.display = "inline-flex";
    }
}
  update(c) {
    if (!this.el) return;

    const manual = window.syncManagerInstance?.manualMode === true;
    const attention = c.needs_confirmation + c.rejected;

    // Skip только если все поля совпали И прогресс не активен.
    if (
      !this._progressActive &&
      c.pending === this._last.pending &&
      c.needs_confirmation === this._last.needs_confirmation &&
      c.failed === this._last.failed &&
      c.rejected === this._last.rejected &&
      c.total === this._last.total &&
      manual === this._last.manual
    ) {
      return;
    }

    this._last = {
      pending: c.pending,
      needs_confirmation: c.needs_confirmation,
      failed: c.failed,
      rejected: c.rejected,
      total: c.total,
      manual,
    };

    let state;
    if (manual) state = "paused";
    else if (c.failed > 0) state = "error";
    else if (attention > 0) state = "attention";
    else if (c.pending > 0) state = "pending";
    else state = "idle";

    // Сбрасываем все классы, ставим нужный.
    this.el.classList.remove(
      "sync-idle",
      "sync-pending",
      "sync-error",
      "sync-attention",
      "sync-paused",
    );

   if (state === "idle") {
    this._progressActive = false;
    this.el.classList.add("sync-idle");
    this.el.title = "Всё синхронизировано";
    if (this.badge) this.badge.style.display = "none";
    if (this.progressLabel) this.progressLabel.textContent = "";
    return;
}

    this.el.classList.add("sync-" + state);

    const titles = {
      paused: "Синхронизация приостановлена. Клик — очередь.",
      error: `Ошибка синхронизации: ${c.failed}. Клик — очередь.`,
      attention: `Требуют внимания: ${attention}. Клик — очередь.`,
      pending: `Ожидает синхронизации: ${c.pending}. Клик — очередь.`,
    };
    this.el.title = titles[state];

    if (this.badge) {
      this.badge.textContent = String(c.total);
      this.badge.style.display = "inline-flex";
    }
  }
}

export const syncIndicator = new SyncIndicator();