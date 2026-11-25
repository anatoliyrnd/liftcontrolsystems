import { createValidatedTextarea } from "../../components/validated-textarea.js";
import { formatTs } from "../../utils/date-utils.js";
import { escapeHtml } from "../../utils/escape-html.js"; 
/**
 * Рендер списка комментариев.
 */
export function renderNotesList(containerDOM, countBadge, notesData) {
  if (!containerDOM) return;

  const notesList = Array.isArray(notesData) ? notesData : [];

  if (countBadge) countBadge.textContent = notesList.length;

  if (notesList.length === 0) {
    containerDOM.innerHTML = `
      <div style="text-align: center; color: var(--text-secondary); margin: auto 0; padding: 2rem;">
        <div style="font-size: 13px; font-weight: 500;">Комментарии к заявке отсутствуют</div>
      </div>`;
    return;
  }

  containerDOM.innerHTML = "";
  notesList.forEach((note) => {
    const noteItem = document.createElement("div");
    const isAccent = String(note.type) === "1";
    noteItem.style.cssText = `
      background: ${isAccent ? "rgba(138, 43, 226, 0.05)" : "var(--bg-primary)"};
      border: 1px solid ${isAccent ? "var(--accent)" : "var(--border-color)"};
      border-radius: 8px; padding: 10px 12px;
      display: flex; flex-direction: column; gap: 4px;
    `;

    const header = document.createElement("div");
    header.style.cssText =
      "display: flex; justify-content: space-between; align-items: center; border-bottom: 1px dashed var(--border-color); padding-bottom: 3px; margin-bottom: 2px;";

    const userSpan = document.createElement("span");
    userSpan.style.cssText = "font-size: 12px; font-weight: 700;";
    
    // 🔥 ДОБАВЛЯЕМ МАРКЕР ОФЛАЙН-КОММЕНТАРИЯ (⏳)
    const offlineMarker = (note.is_offline === 1 || note.is_offline === true) 
      ? ' <span title="Ожидает синхронизации" style="font-size: 10px; color: #f59e0b;">⏳</span>' 
      : '';
      
    userSpan.innerHTML = "👤 " + escapeHtml(note.user || "Сотрудник не указан") + offlineMarker;

    const dateSpan = document.createElement("span");
    dateSpan.style.cssText =
      "font-size: 11px; color: var(--text-secondary); font-weight: 500;";
    dateSpan.textContent = "🕒 " + formatTs(note.date);

    header.appendChild(userSpan);
    header.appendChild(dateSpan);

    const body = document.createElement("div");
    body.style.cssText =
      "font-size: 13px; line-height: 1.4; white-space: pre-wrap; word-break: break-word;";
    body.textContent = note.body || "Пустая заметка.";

    noteItem.appendChild(header);
    noteItem.appendChild(body);
    containerDOM.appendChild(noteItem);
  });
}

/**
 * Создает композер для добавления комментария (текст + фото).
 * @param {HTMLElement} container
 * @param {Object} options
 * @param {Function} options.onSubmit - коллбэк при клике на "Добавить"
 * @returns {Object} API для управления из контроллера
 */
export function createNotesComposer(container, { onSubmit }) {
  container.innerHTML = "";
  let previewBlobUrl = null;

  const noteField = createValidatedTextarea({
    placeholder: "Введите комментарий к заявке...",
    rows: 3,
    minLength: 1,
    voice: true,
    onChange: (value, isValid) => {
      const enabled = isValid && !!value;
      submitBtn.disabled = !enabled;
      submitBtn.style.opacity = enabled ? "1" : "0.5";
      submitBtn.style.cursor = enabled ? "pointer" : "not-allowed";
    },
  });

  const isOnline = navigator.onLine;

  const photoInput = document.createElement("input");
  photoInput.type = "file";
  photoInput.accept = "image/jpeg,image/png";
  photoInput.style.display = "none";
  if (!isOnline) photoInput.disabled = true;

  const photoPreview = document.createElement("div");
  photoPreview.style.cssText =
    "display: none; align-items: center; gap: 8px; margin-top: 8px; padding: 6px; background: var(--bg-primary); border: 1px solid var(--border-color); border-radius: 6px;";

  const photoPreviewImg = document.createElement("img");
  photoPreviewImg.alt = "Превью";
  photoPreviewImg.style.cssText =
    "max-height: 60px; max-width: 60px; object-fit: cover; border-radius: 4px;";

  const photoPreviewName = document.createElement("span");
  photoPreviewName.style.cssText =
    "font-size: 12px; color: var(--text-secondary); flex: 1; overflow: hidden; text-overflow: ellipsis; white-space: nowrap;";

  const photoClearBtn = document.createElement("button");
  photoClearBtn.type = "button";
  photoClearBtn.textContent = "×";
  photoClearBtn.title = "Убрать фото";
  photoClearBtn.style.cssText =
    "padding: 2px 8px; border-radius: 4px; border: 1px solid var(--border-color); background: transparent; color: var(--text-primary); cursor: pointer; font-size: 16px; line-height: 1;";

  function revokeBlob() {
    if (previewBlobUrl) {
      URL.revokeObjectURL(previewBlobUrl);
      previewBlobUrl = null;
    }
  }

  photoClearBtn.onclick = () => {
    revokeBlob();
    photoInput.value = "";
    photoPreview.style.display = "none";
  };

  photoPreview.appendChild(photoPreviewImg);
  photoPreview.appendChild(photoPreviewName);
  photoPreview.appendChild(photoClearBtn);

  photoInput.onchange = () => {
    revokeBlob();
    const file = photoInput.files && photoInput.files[0];
    if (!file) {
      photoPreview.style.display = "none";
      return;
    }
    photoPreviewName.textContent =
      file.name + " (" + Math.round(file.size / 1024) + " КБ)";
    const url = URL.createObjectURL(file);
    previewBlobUrl = url;
    photoPreviewImg.src = url;
    photoPreview.style.display = "flex";
  };

  const attachBtn = document.createElement("button");
  attachBtn.type = "button";
  attachBtn.textContent = "📎 Прикрепить фото";
  attachBtn.style.cssText =
    "margin-top: 8px; align-self: flex-start; padding: 6px 12px; border-radius: 6px; border: 1px solid var(--border-color); background: var(--bg-secondary); color: var(--text-primary); cursor: pointer; font-size: 12px;";

  if (!isOnline) {
    attachBtn.disabled = true;
    attachBtn.style.opacity = "0.5";
    attachBtn.style.cursor = "not-allowed";
    attachBtn.title = "Фото доступно только онлайн";
  } else {
    attachBtn.onclick = () => photoInput.click();
  }

  const submitBtn = document.createElement("button");
  submitBtn.textContent = "Добавить комментарий";
  submitBtn.disabled = true;
  submitBtn.style.cssText =
    "align-self: flex-end; margin-top: 8px; padding: 8px 16px; border-radius: 6px; border: none; background: var(--accent); color: var(--mark-text); cursor: not-allowed; font-size: 13px; font-weight: 600; opacity: 0.5; transition: all 0.2s ease;";
  submitBtn.onclick = onSubmit;

  container.appendChild(noteField.element);
  container.appendChild(photoInput);
  container.appendChild(attachBtn);
  container.appendChild(photoPreview);
  container.appendChild(submitBtn);

  return {
    destroy: () => {
      revokeBlob();
      noteField.destroy();
    },
    getValue: () => {
      return {
        text: noteField.getValue(),
        file:
          photoInput.files && photoInput.files[0] ? photoInput.files[0] : null,
      };
    },
    lock: () => {
      submitBtn.disabled = true;
      const ta = noteField.element.querySelector("textarea");
      if (ta) ta.disabled = true;
    },
    unlock: () => {
      const ta = noteField.element.querySelector("textarea");
      if (ta) ta.disabled = false;
      const val = noteField.getValue();
      const valid = noteField.isValid();
      submitBtn.disabled = !valid || !val;
      submitBtn.style.opacity = submitBtn.disabled ? "0.5" : "1";
      submitBtn.style.cursor = submitBtn.disabled ? "not-allowed" : "pointer";
    },
    setLoadingText: (text) => {
      submitBtn.textContent = text;
      submitBtn.disabled = true;
      submitBtn.style.opacity = "0.7";
    },
    resetButton: () => {
      submitBtn.textContent = "Добавить комментарий";
      submitBtn.disabled = true;
      submitBtn.style.opacity = "0.5";
    },
    reset: () => {
      revokeBlob();
      noteField.reset();
      photoInput.value = "";
      photoPreview.style.display = "none";
      submitBtn.textContent = "Добавить комментарий";
      submitBtn.disabled = true;
      submitBtn.style.opacity = "0.5";
    },
  };
}
