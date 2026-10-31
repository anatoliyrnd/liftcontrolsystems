import { api } from "../api.js";
import { syncManager } from "../sync-manager.js";
import { offlineDB } from "../offline-db.js";
import { escapeHtml } from "../utils/sanitize.js";

import { ui } from "../components/ui-modal.js";
import { formatTime, formatShortDate } from "../utils/format.js";

export class ListController {
  constructor() {
    this.container = document.querySelector("#view-list .cards-container");
    this.totalCountEl = document.getElementById("totalTicketsCount");
    this.newCountEl = document.getElementById("newTicketsCount");
    this.newBlock = document.getElementById("newTicketsBlock");
    this.acceptAllBtn = document.getElementById("acceptAllBtn");
    this.view = document.getElementById("view-list");

    this.tickets = [];
    this._cancelled = false;
    this._inFlight = false;
    this._pollTimer = null;

    this._onVisibilityChange = () => {
      if (document.visibilityState === "visible" && !this._cancelled) {
        this._poll(); // Немедленный запрос при возврате в фокус
      }
    };
  }

  async mount() {
    this._cancelled = false;
    this.view.classList.add("active");

    // 1. МГНОВЕННО показываем кэш (Stale-While-Revalidate)
    this.tickets = await offlineDB.getList("tickets");
    this.render();
    this.bindEvents();

    // 2. Фоновая загрузка свежих данных
    this._poll();

    // 3. Слушаем возврат в фокус
    document.addEventListener("visibilitychange", this._onVisibilityChange);
  }

  unmount() {
    this._cancelled = true;
    if (this._pollTimer) {
      clearTimeout(this._pollTimer);
      this._pollTimer = null;
    }
    document.removeEventListener("visibilitychange", this._onVisibilityChange);
    api.abortTag("mobile_list");
    this.view.classList.remove("active");
  }

  // УМНЫЙ POLLING
  async _poll() {
    // Проверки перед запросом
    if (this._cancelled) return;
    if (!navigator.onLine) return;
    if (this._inFlight) return;
    if (syncManager.isSyncing) return;

    // Сбрасываем старый таймер, если он был
    if (this._pollTimer) {
      clearTimeout(this._pollTimer);
      this._pollTimer = null;
    }

    this._inFlight = true;
    try {
      await this.loadData();
    } finally {
      this._inFlight = false;

      // Планируем следующий poll через 5 минут
      if (!this._cancelled && document.visibilityState === "visible") {
        this._pollTimer = setTimeout(() => {
          this._pollTimer = null;
          this._poll();
        }, 300000); // 5 минут
      }
    }
  }

  async loadData() {
    if (this.tickets.length === 0) {
      this.container.innerHTML =
        '<div style="text-align:center; padding: 40px; color: var(--text-muted);">Обновление...</div>';
    }

    try {
      // ИСПРАВЛЕНО: правильный payload { data: "open" }
      const response = await api.post({ data: "open" }, null, "mobile_list");

      if (this._cancelled) return;

      if (Array.isArray(response)) {
        this.tickets = response;
        await offlineDB.saveList("tickets", response);

        // Сохраняем скролл
        const appContent = document.querySelector(".app-content");
        const scrollTop = appContent ? appContent.scrollTop : 0;

        if (!this._cancelled) this.render();

        if (appContent) appContent.scrollTop = scrollTop;
      }
    } catch (e) {
      console.warn("[ListController] Нет связи, показываем кэш", e);
      if (!this._cancelled && this.tickets.length === 0) {
        this.container.innerHTML =
          '<div style="text-align:center; padding: 40px; color: var(--danger);">Нет открытых заявок (Офлайн)</div>';
      }
    }
  }

  render() {
    if (!this.container) return;

    const isTicketNew = (status) => {
      const s = Number(status);
      return s === 0 || status === null || status === undefined || isNaN(s);
    };

    const newTickets = this.tickets.filter(
      (t) => isTicketNew(t.notify_status) && !t._offline_pending,
    );

    this.totalCountEl.textContent = this.tickets.length;

    if (newTickets.length > 0) {
      this.newCountEl.textContent = newTickets.length;
      this.newBlock.classList.remove("hidden");
      this.acceptAllBtn.classList.remove("hidden");
    } else {
      this.newBlock.classList.add("hidden");
      this.acceptAllBtn.classList.add("hidden");
    }

    this.container.innerHTML = "";

    if (this.tickets.length === 0) {
      this.container.innerHTML =
        '<div style="text-align:center; padding: 40px; color: var(--text-muted);">Нет открытых заявок</div>';
      return;
    }

    const sortedTickets = [...this.tickets].sort((a, b) => {
      const aWeight =
        (a.alert_level === 3 ? 100 : 0) +
        (isTicketNew(a.notify_status) ? 10 : 0);
      const bWeight =
        (b.alert_level === 3 ? 100 : 0) +
        (isTicketNew(b.notify_status) ? 10 : 0);
      if (aWeight !== bWeight) return bWeight - aWeight;
      return 0;
    });

    sortedTickets.forEach((ticket) => {
      const isNew = isTicketNew(ticket.notify_status);
      const isPending = ticket._offline_pending === true;

      const rawDate = ticket.date || ticket.call_date;
      const shortDate = formatShortDate(rawDate);
      const timeStr = formatTime(rawDate);
      const timeString = shortDate !== "—" ? `${shortDate} ${timeStr}` : "—";
      const card = document.createElement("div");
      card.className = "ticket-card";
      card.dataset.id = ticket.id;

      // Визуальные маркеры
      let statusClass = isNew ? "status-open" : "status-work";
      let statusText = isNew ? "Новая" : "В работе";

      if (isPending) {
        statusClass = "status-pending";
        statusText = "⏳ Ожидает";
        card.style.borderLeftColor = "var(--text-muted)"; // Серый цвет
        card.style.opacity = "0.7";
      } else if (ticket.alert_level === 3) {
        card.style.borderLeftColor = "var(--danger)";
      } else if (isNew) {
        card.style.borderLeftColor = "var(--warning)";
      } else {
        card.style.borderLeftColor = "var(--success)";
      }

      const addressText =
        ticket.fullAddress || ticket.address || "Адрес не указан";
      const detailsRaw = ticket.details || "Без описания";
      const shortDetails =
        detailsRaw.length > 80
          ? detailsRaw.substring(0, 80) + "..."
          : detailsRaw;

      card.innerHTML = `
        <div class="card-top">
            <span class="card-id">№ ${escapeHtml(ticket.id)}</span>
            <span class="card-status ${statusClass}">${statusText}</span>
        </div>
        <div class="card-address">${escapeHtml(addressText)}</div>
        <div class="card-desc">${escapeHtml(shortDetails)}</div>
        <div class="card-bottom">
            <span class="card-date">${escapeHtml(timeString)}</span>
            <span class="card-arrow">→</span>
        </div>
      `;

      card.addEventListener("click", () => {
        if (isPending) {
          ui.toast("Заявка ожидает синхронизации с сервером");
          return; // Блокируем переход
        }
        window.location.hash = `#/detail/${ticket.id}`;
      });

      this.container.appendChild(card);
    });
  }

  bindEvents() {
    this.acceptAllBtn.onclick = async () => {
      if (this.acceptAllBtn.disabled) return;

      const newTickets = this.tickets.filter(
        (t) => !t.notify_status && !t._offline_pending,
      );
      if (newTickets.length === 0) return;

      if (!confirm(`Принять в работу ${newTickets.length} новых заявок?`))
        return;

      this._inFlight = true;
      this.acceptAllBtn.disabled = true;
      this.acceptAllBtn.textContent = "Принятие...";

      let offlineMode = false; // Флаг "сеть пропала"

      try {
        for (const ticket of newTickets) {
          const action = {
            payload: {
              action: "calledit",
              call_id: ticket.id,
              notify_status: 2,
            },
          };

          if (offlineMode) {
            // ОПТИМИЗАЦИЯ: Сеть уже упала, не ждем 6 секунд на каждую заявку
            ticket.notify_status = 2;
            await offlineDB.updateTicket(ticket.id, { notify_status: 2 });
            await offlineDB.addToQueue(action);
          } else {
            // Первая попытка отправки
            const res = await syncManager.sendActionDirectly(action);

            if (res && res.status === "offline_saved") {
              offlineMode = true; // Включаем офлайн-режим для остальных
              ticket.notify_status = 2;
              await offlineDB.updateTicket(ticket.id, { notify_status: 2 });
            } else if (res && res.status !== "error") {
              ticket.notify_status = 2;
              await offlineDB.updateTicket(ticket.id, { notify_status: 2 });
            }
          }
        }

        if (offlineMode) {
          ui.toast("Нет сети. Заявки сохранены локально.");
        }
      } catch (e) {
        console.error("[ListController] acceptAll error", e);
        await ui.alert("Произошла ошибка при массовом принятии.");
      } finally {
        this._inFlight = false;
        this.acceptAllBtn.disabled = false;
        this.acceptAllBtn.textContent = "Принять все";
        this.render();
      }
    };
  }
}
