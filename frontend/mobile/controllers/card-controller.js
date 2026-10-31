import { api } from "../api.js";
import { offlineDB } from "../offline-db.js";
import { syncManager } from "../sync-manager.js";
import { compressImage } from "../components/image-compressor.js";
import { authStore } from "../auth-store.js";
import { escapeHtml, safeUrl } from "../utils/sanitize.js";
import { formatTime, formatDate } from "../utils/format.js";
import { ui } from "../components/ui-modal.js";

export class CardController {
  constructor() {
    this.ticket = null;
    this.ticketId = null;
    this.currentPhotoBase64 = null;
    this._cancelled = false;

    this.view = document.getElementById("view-detail");
    this.titleEl = document.getElementById("detailTitle");
    this.loadingEl = document.getElementById("cardLoading");
    this.bodyEl = document.getElementById("cardBody");
    this.detailAddress = document.getElementById("detailAddress");
    this.detailDesc = document.getElementById("detailDesc");
    this.acceptBtn = document.getElementById("acceptBtn");
    this.closeBtn = document.getElementById("closeTicketBtn");
    this.commentsContainer = document.getElementById("notesContainerDOM");
    this.composerTextarea = this.view.querySelector(
      ".comment-composer textarea",
    );
    this.photoInput = document.getElementById("photoInput");
    this.sendCommentBtn = document.getElementById("sendCommentBtn");
    this.photoLabel = this.view.querySelector(".btn-attach");
    this.composerBlock = this.view.querySelector(".comment-composer");
    this.modal = document.getElementById("closeModal");
    this.solutionInput = document.getElementById("solutionInput");
    this.cancelCloseBtn = document.getElementById("cancelCloseBtn");
    this.confirmCloseBtn = document.getElementById("confirmCloseBtn");
    this.solutionBlock = document.getElementById("solutionBlock");
    this.solutionText = document.getElementById("solutionText");
    this.solutionMeta = document.getElementById("solutionMeta");
  }

  async mount(ticketId) {
    this._cancelled = false;
    this.ticketId = ticketId;
    this.view.classList.add("active");
    this.titleEl.textContent = `Заявка № ${ticketId}`;

    if (this.loadingEl) this.loadingEl.style.display = "flex";
    if (this.bodyEl) this.bodyEl.style.display = "none";

    this.currentPhotoBase64 = null;
    this.composerTextarea.value = "";
    this.photoLabel.innerHTML = "📷 Фото";
    this.photoLabel.style.color = "var(--text-muted)";
    this.solutionInput.value = "";
    this.modal.classList.remove("active");

    await this.loadData();

    if (this._cancelled) return;

    if (!this.ticket) {
      await ui.alert("Заявка не найдена или нет связи с сервером.");
      if (!this._cancelled) window.location.hash = "#/list";
      return;
    }

    if (this.loadingEl) this.loadingEl.style.display = "none";
    if (this.bodyEl) this.bodyEl.style.display = "flex";

    this.render();
    this.bindEvents();
  }

  unmount() {
    this._cancelled = true;
    api.abortTag("card-detail");
    this.view.classList.remove("active");
  }

  async loadData() {
    const tickets = await offlineDB.getList("tickets");
    if (this._cancelled) return;

    this.ticket = tickets.find((t) => String(t.id) === String(this.ticketId));

    if (!this.ticket) {
      try {
        const res = await api.post({ data: "open" }, null, "card-detail");
        if (this._cancelled) return;

        if (Array.isArray(res)) {
          this.ticket = res.find((t) => String(t.id) === String(this.ticketId));
        }

        if (!this.ticket) {
          const closedRes = await api.post(
            { data: "close", period: "7" },
            null,
            "card-detail",
          );
          if (this._cancelled) return;

          if (Array.isArray(closedRes)) {
            this.ticket = closedRes.find(
              (t) => String(t.id) === String(this.ticketId),
            );
          }
        }
      } catch (e) {
        console.error("Ошибка загрузки заявки", e);
      }
    }
  }

  render() {
    if (this.detailAddress) {
      this.detailAddress.textContent =
        this.ticket.fullAddress || this.ticket.address || "Адрес не указан";
    }
    if (this.detailDesc) {
      this.detailDesc.textContent =
        this.ticket.details || "Описание отсутствует";
    }

    const isNew =
      !this.ticket.notify_status || Number(this.ticket.notify_status) === 0;
    const isClosed =
      this.ticket.type === "close" || Number(this.ticket.close_date) > 0;

    if (isClosed) {
      if (this.solutionBlock) this.solutionBlock.style.display = "block";
      if (this.solutionText) {
        const sol = this.ticket.solution;
        this.solutionText.textContent =
          sol && sol !== "—" && sol !== "-" ? sol : "Решение не указано";
      }
      let metaStr = `Закрыл: ${this.ticket.close_name || "Сотрудник"}`;
      if (this.ticket.close_date) {
        const dateStr = formatDate(this.ticket.close_date);
        if (dateStr !== "—") metaStr += ` (${dateStr})`;
      }
      if (this.solutionMeta) this.solutionMeta.textContent = metaStr;

      this.acceptBtn.classList.add("hidden");
      this.closeBtn.classList.add("hidden");
      if (this.composerBlock) this.composerBlock.style.display = "none";
    } else {
      if (this.solutionBlock) this.solutionBlock.style.display = "none";
      if (this.composerBlock) this.composerBlock.style.display = "block";

      if (isNew) this.acceptBtn.classList.remove("hidden");
      else this.acceptBtn.classList.add("hidden");

      this.closeBtn.classList.remove("hidden");
    }

    this.renderComments();
  }

  renderComments() {
    this.commentsContainer.innerHTML = "";
    const notes = this.ticket.note ? Object.values(this.ticket.note) : [];

    if (notes.length === 0) {
      this.commentsContainer.innerHTML =
        '<div style="color:var(--text-muted); font-size:13px; padding: 10px 0;">Нет комментариев</div>';
      return;
    }

    notes.forEach((n) => {
      const dateStr = formatTime(n.date);
      const div = document.createElement("div");
      div.className = "comment-item";

      let photoHtml = "";
      const safePhoto = safeUrl(n.photo_url);
      if (safePhoto) {
        photoHtml = `<img src="${escapeHtml(safePhoto)}" alt="" style="max-width:100%; border-radius:8px; margin-top:8px;">`;
      }

      div.innerHTML = `
        <div class="comment-header">
            <span class="comment-author">${escapeHtml(n.user || "Сотрудник")}</span>
            <span class="comment-date">${escapeHtml(dateStr)}</span> 
        </div>
        <div class="comment-text">${escapeHtml(n.body || "")}</div>
        ${photoHtml}
      `;
      this.commentsContainer.appendChild(div);
    });

    this.commentsContainer.scrollTop = this.commentsContainer.scrollHeight;
  } // <-- ЗДЕСЬ БЫЛА ПРОПУЩЕНА СКОБКА

  bindEvents() {
    this.view.querySelector(".btn-back").onclick = () => {
      window.location.hash = "#/list";
    };

    this.acceptBtn.onclick = async () => {
      if (this.acceptBtn.disabled) return;
      this.acceptBtn.disabled = true;
      this.acceptBtn.textContent = "Отправка...";

      try {
        const action = {
          payload: {
            action: "calledit",
            call_id: this.ticket.id,
            notify_status: 2,
          },
        };
        const res = await syncManager.sendActionDirectly(action);

        if (res && res.status === "offline_saved") {
          this.ticket.notify_status = 2;
          await offlineDB.updateTicket(this.ticket.id, { notify_status: 2 });
          ui.toast("Нет сети. Статус сохранен локально.");
          this.render();
        } else if (res && res.status !== "error") {
          this.ticket.notify_status = 2;
          await offlineDB.updateTicket(this.ticket.id, { notify_status: 2 });
          this.render();
        } else {
          await ui.alert("Ошибка отправки. Проверьте связь.");
        }
      } catch (e) {
        await ui.alert("Не удалось принять заявку. Попробуйте позже.");
      } finally {
        this.acceptBtn.disabled = false;
        this.acceptBtn.textContent = "✓ Принять в работу";
      }
    };

    this.photoInput.onchange = async (e) => {
      const file = e.target.files[0];
      if (!file) return;
      try {
        this.photoLabel.innerHTML = "⏳ Сжатие...";
        this.photoLabel.style.color = "var(--text-muted)";
        this.currentPhotoBase64 = await compressImage(file);
        this.photoLabel.innerHTML = "✅ Фото готово";
        this.photoLabel.style.color = "var(--success)";
      } catch (err) {
        this.currentPhotoBase64 = null;
        this.photoLabel.innerHTML = "📷 Фото";
        this.photoLabel.style.color = "var(--text-muted)";
        this.photoInput.value = "";
        await ui.alert(err.message || "Не удалось обработать фото.");
      }
    };
    this.sendCommentBtn.onclick = async () => {
      if (this.sendCommentBtn.disabled) return;
      const text = this.composerTextarea.value.trim();
      if (!text && !this.currentPhotoBase64) return;

      this.sendCommentBtn.disabled = true;
      this.sendCommentBtn.textContent = "Отправка...";

      try {
        const action = {
          payload: {
            action: "callnote",
            call_id: this.ticket.id,
            note: text,
            photo_base64: this.currentPhotoBase64,
          },
        };
        const res = await syncManager.sendActionDirectly(action);

        if (res && (res.status === "offline_saved" || res.status !== "error")) {
          const newNote = {
            user: "Вы",
            body: text,
            date: Math.floor(Date.now() / 1000),
            type: 0,
          };
          if (!this.ticket.note) this.ticket.note = [];
          this.ticket.note.push(newNote);
          await offlineDB.updateTicket(this.ticket.id, {
            note: this.ticket.note,
          });

          this.composerTextarea.value = "";
          this.currentPhotoBase64 = null;
          this.photoInput.value = "";
          this.photoLabel.innerHTML = "📷 Фото";
          this.photoLabel.style.color = "var(--text-muted)";
          this.renderComments();

          // Если офлайн — показываем зеленый тост (не блокирует экран)
          if (res.status === "offline_saved") {
            ui.toast("Комментарий сохранен локально");
          }
        } else {
          await ui.alert("Ошибка отправки. Проверьте связь.");
        }
      } catch (e) {
        await ui.alert("Не удалось отправить комментарий. Попробуйте позже.");
      } finally {
        this.sendCommentBtn.disabled = false;
        this.sendCommentBtn.textContent = "Отправить";
      }
    };

    // ОТКРЫТИЕ МОДАЛА ЗАКРЫТИЯ
    this.closeBtn.onclick = () => {
      this.modal.classList.add("active");
      this.solutionInput.focus();
    };

    // ЗАКРЫТИЕ МОДАЛА (Кнопка "Отмена" и клик по фону)
    this.cancelCloseBtn.onclick = () => this.modal.classList.remove("active");
    this.modal.onclick = (e) => {
      if (e.target === this.modal) this.modal.classList.remove("active");
    };

    this.confirmCloseBtn.onclick = async () => {
      if (this.confirmCloseBtn.disabled) return;
      const solution = this.solutionInput.value.trim();
      if (solution.length < 6) {
        await ui.alert("Опишите решение (минимум 6 символов).");
        return;
      }

      this.confirmCloseBtn.disabled = true;
      this.confirmCloseBtn.textContent = "Закрытие...";

      try {
        const action = {
          payload: {
            action: "callClose",
            call_id: this.ticket.id,
            solution: solution,
            user_id: authStore.getUser()?.id || 0,
          },
        };
        const res = await syncManager.sendActionDirectly(action);

        if (res && res.status === "offline_saved") {
          // ОФЛАЙН: Помечаем заявку как ожидающую синхронизации
          this.ticket._offline_pending = true;
          await offlineDB.updateTicket(this.ticket.id, {
            _offline_pending: true,
          });
          ui.toast("Заявка сохранена локально. Ожидает синхронизации.");
          this.modal.classList.remove("active");
          window.location.hash = "#/list";
        } else if (res && res.status !== "error") {
          // ОНЛАЙН: Удаляем из кэша
          await offlineDB.removeTicket(this.ticket.id);
          this.modal.classList.remove("active");
          window.location.hash = "#/list";
        } else {
          await ui.alert("Ошибка отправки. Проверьте связь.");
        }
      } catch (e) {
        await ui.alert("Не удалось закрыть заявку. Попробуйте позже.");
      } finally {
        this.confirmCloseBtn.disabled = false;
        this.confirmCloseBtn.textContent = "Закрыть заявку";
      }
    };
  }
}
