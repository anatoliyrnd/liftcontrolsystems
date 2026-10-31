import { api } from "../api.js";
import { escapeHtml } from "../utils/sanitize.js";
import { formatShortDate, formatTime } from "../utils/format.js";

export class ClosedController {
  constructor() {
    this.view = document.getElementById("view-closed");
    this.container = document.getElementById("closedContainer");
    this.periodBtns = this.view.querySelectorAll(".period-btn");
    this.currentPeriod = "1";
    this._cancelled = false;
  }

  async mount() {
    this._cancelled = false;
    this.view.classList.add("active");
    this.bindEvents();
    await this.loadData(this.currentPeriod);
  }

  unmount() {
    this._cancelled = true;
    api.abortTag("closed_list");
    this.view.classList.remove("active");
  }

  bindEvents() {
    this.periodBtns.forEach((btn) => {
      btn.onclick = () => {
        this.periodBtns.forEach((b) => b.classList.remove("active"));
        btn.classList.add("active");
        this.currentPeriod = btn.dataset.period;
        this.loadData(this.currentPeriod);
      };
    });
  }

  async loadData(period) {
    this.container.innerHTML =
      '<div style="text-align:center; padding: 40px; color: var(--text-muted);">Загрузка архива...</div>';

    try {
      const response = await api.post(
        { data: "close", period: period },
        null,
        "closed_list",
      );

      if (this._cancelled) return;

      if (Array.isArray(response)) {
        this.render(response);
      } else {
        this.container.innerHTML =
          '<div style="text-align:center; padding: 40px; color: var(--danger);">Ошибка формата данных</div>';
      }
    } catch (e) {
      if (this._cancelled) return;
      this.container.innerHTML =
        '<div style="text-align:center; padding: 40px; color: var(--danger);">Нет связи с сервером.<br>Архив доступен только онлайн.</div>';
    }
  }

  render(tickets) {
    this.container.innerHTML = "";

    if (tickets.length === 0) {
      this.container.innerHTML =
        '<div style="text-align:center; padding: 40px; color: var(--text-muted);">За этот период закрытых заявок нет</div>';
      return;
    }

    tickets.forEach((ticket) => {
      const card = document.createElement("div");
      card.className = "ticket-card closed";
      card.dataset.id = ticket.id;

      const rawDate = ticket.close_date || ticket.date;
      const shortDate = formatShortDate(rawDate);
      const timeStr = formatTime(rawDate);
      const dateStr = shortDate !== "—" ? `${shortDate} ${timeStr}` : "—";

      const addressText =
        ticket.fullAddress || ticket.address || "Адрес не указан";
      const solutionText = ticket.solution || "Решение не указано";

      card.innerHTML = `
        <div class="card-top">
          <span class="card-id">№ ${escapeHtml(ticket.id)}</span>
          <span class="card-status status-work" style="color: var(--success); background: rgba(34,197,94,0.15);">Закрыта</span>
        </div>
        <div class="card-address">${escapeHtml(addressText)}</div>
        <div class="card-solution">✅ ${escapeHtml(solutionText)}</div>
        <div class="card-bottom" style="margin-top: 8px;">
          <span class="card-date">${escapeHtml(dateStr)}</span>
          <span class="card-arrow">→</span>
        </div>
      `;

      card.addEventListener("click", () => {
        window.location.hash = `#/detail/${ticket.id}`;
      });

      this.container.appendChild(card);
    });
  }
}
