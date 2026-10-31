import { notify } from "./components/notify.js";
import { logHistoryAction } from "./history-logger.js";

import { authStore } from "./auth-store.js";
import {
  tableSettings,
  syncTableSettingsFromStorage,
} from "./table/settings.js";
export class ProfileController {
  constructor(api, router) {
    this.api = api;
    this.router = router;
    this._currentColumns = [];
  }

  async mount() {
    await this._loadUserData();
    this._renderColumnsSettings();

    const saveBtn = document.getElementById("saveSettingsBtn");
    if (saveBtn) {
      saveBtn.onclick = () => this._saveSettings();
    }
  }

  async _loadUserData() {
    try {
      const response = await this.api.post(
        { data: "get_user_settings" },
        "Загрузка профиля...",
      );

      if (response && response.status === "ok") {
        const p = response.profile || {};
        const profSurname = document.getElementById("profSurname");
        const profName = document.getElementById("profName");
        const profPatronymic = document.getElementById("profPatronymic");

        if (profSurname) profSurname.value = p.surname || "";
        if (profName) profName.value = p.name || "";
        if (profPatronymic) profPatronymic.value = p.patronymic || "";

        const baseColumns = tableSettings.columns.map((c) => ({ ...c }));

        if (response.column_settings && response.column_settings.order) {
          this._currentColumns = baseColumns;

          const orderArr = response.column_settings.order;
          const hiddenArr = response.column_settings.hidden || [];

          this._currentColumns.forEach((col) => {
            col.visible = !hiddenArr.includes(col.id);
          });

          const getOrderIndex = (id) => {
            const i = orderArr.indexOf(id);
            return i === -1 ? Number.MAX_SAFE_INTEGER : i;
          };
          this._currentColumns.sort(
            (a, b) => getOrderIndex(a.id) - getOrderIndex(b.id),
          );
        } else {
          baseColumns.forEach((c) => (c.visible = !c.hidden));
          this._currentColumns = baseColumns;
        }
      } else {
        this._currentColumns = tableSettings.columns.map((c) => ({
          ...c,
          visible: !c.hidden,
        }));
      }
    } catch (e) {
      console.error("[ProfileController] Ошибка загрузки профиля:", e);
      this._currentColumns = tableSettings.columns.map((c) => ({
        ...c,
        visible: !c.hidden,
      }));
    }
  }

  _renderColumnsSettings() {
    const container = document.getElementById("columnsSettingsList");
    if (!container) return;
    container.innerHTML = "";

    if (!this._currentColumns || this._currentColumns.length === 0) {
      container.innerHTML =
        '<div style="color:red; font-size:12px;">Ошибка: список колонок пуст.</div>';
      return;
    }

    this._currentColumns.forEach((col, index) => {
      const row = document.createElement("div");
      row.style.cssText =
        "display: flex; align-items: center; justify-content: space-between; padding: 8px 12px; background: var(--bg-primary); border: 1px solid var(--border-color); border-radius: 6px;";

      const leftPart = document.createElement("div");
      leftPart.style.cssText = "display: flex; align-items: center; gap: 10px;";

      const checkbox = document.createElement("input");
      checkbox.type = "checkbox";
      checkbox.checked = col.visible !== false;

      if (col.isAbsoluteFixed || col.isRequired) {
        checkbox.disabled = true;
        checkbox.title = "Эту колонку нельзя скрыть";
        checkbox.checked = true;
      } else {
        checkbox.onchange = (e) => {
          col.visible = e.target.checked;
        };
      }

      const label = document.createElement("span");
      label.textContent = col.name;
      label.style.fontSize = "14px";

      leftPart.appendChild(checkbox);
      leftPart.appendChild(label);

      const rightPart = document.createElement("div");
      rightPart.style.cssText = "display: flex; gap: 4px;";

      const btnUp = document.createElement("button");
      btnUp.innerHTML = "↑";
      btnUp.className = "theme-toggle-btn";
      btnUp.style.cssText =
        "padding: 4px 8px; font-size: 14px; border-radius: 4px; cursor: pointer;";

      const btnDown = document.createElement("button");
      btnDown.innerHTML = "↓";
      btnDown.className = "theme-toggle-btn";
      btnDown.style.cssText =
        "padding: 4px 8px; font-size: 14px; border-radius: 4px; cursor: pointer;";

      btnUp.disabled =
        index === 0 ||
        col.isAbsoluteFixed ||
        this._currentColumns[index - 1]?.isAbsoluteFixed;
      btnDown.disabled =
        index === this._currentColumns.length - 1 || col.isAbsoluteFixed;

      if (btnUp.disabled) {
        btnUp.style.opacity = "0.3";
        btnUp.style.cursor = "not-allowed";
      }
      if (btnDown.disabled) {
        btnDown.style.opacity = "0.3";
        btnDown.style.cursor = "not-allowed";
      }

      btnUp.onclick = () => {
        if (btnUp.disabled) return;
        const temp = this._currentColumns[index - 1];
        this._currentColumns[index - 1] = this._currentColumns[index];
        this._currentColumns[index] = temp;
        this._renderColumnsSettings();
      };

      btnDown.onclick = () => {
        if (btnDown.disabled) return;
        const temp = this._currentColumns[index + 1];
        this._currentColumns[index + 1] = this._currentColumns[index];
        this._currentColumns[index] = temp;
        this._renderColumnsSettings();
      };

      rightPart.appendChild(btnUp);
      rightPart.appendChild(btnDown);

      row.appendChild(leftPart);
      row.appendChild(rightPart);
      container.appendChild(row);
    });
  }

  async _saveSettings() {
    const btn = document.getElementById("saveSettingsBtn");
    btn.disabled = true;
    btn.textContent = "Сохранение...";

    const profile = {
      surname: document.getElementById("profSurname").value.trim(),
      name: document.getElementById("profName").value.trim(),
      patronymic: document.getElementById("profPatronymic").value.trim(),
    };

    const passOld = document.getElementById("profPassOld").value;
    const passNew = document.getElementById("profPassNew").value;
    let password = null;
    if (passOld || passNew) {
      if (!passOld || !passNew) {
        notify.error("Для смены пароля заполните оба поля");
        btn.disabled = false;
        btn.textContent = "Сохранить профиль и настройки";
        return;
      }
      password = { old: passOld, new: passNew };
    }

    const order = [];
    const hidden = [];
    this._currentColumns.forEach((col) => {
      order.push(col.id);
      if (col.visible === false) hidden.push(col.id);
    });

    const payload = {
      action: "save_user_settings",
      profile,
      column_settings: { order, hidden },
    };
    if (password) payload.password = password;

    try {
      const response = await this.api.post(payload, "Сохранение настроек...");

      if (response && response.status === "ok") {
        notify.success(response.message || "Настройки сохранены");
        logHistoryAction("Обновлены настройки профиля/таблицы");

        document.getElementById("profPassOld").value = "";
        document.getElementById("profPassNew").value = "";
        this._applyLocalTableSettings(order, hidden);

        // --- НОВЫЙ БЛОК: Обновляем authStore и шапку ---
        const currentUser = authStore.getUser();
        if (currentUser) {
          // Сохраняем раздельно, как того требует API 4.0
          currentUser.surname = profile.surname;
          currentUser.name = profile.name; // В authStore теперь лежит только Имя
          currentUser.patronymic = profile.patronymic;

          // Перезаписываем сессию (обновляет localStorage)
          authStore.setSession(
            authStore.getAccess(),
            authStore.getExpiresAt(),
            currentUser,
          );

          // Кидаем событие для main.js, чтобы он перерисовал шапку
          window.dispatchEvent(new CustomEvent("auth:updated"));
        }
        // ------------------------------------------------
      } else {
        notify.error(response.message || "Ошибка сохранения");
      }
    } catch (e) {
      console.error(e);
      notify.error("Сбой сети при сохранении");
    } finally {
      btn.disabled = false;
      btn.textContent = "Сохранить профиль и настройки";
    }
  }

  _applyLocalTableSettings(order, hidden) {
    localStorage.setItem("tableColumnOrder", order.join(","));
    localStorage.setItem("tableColumnHidden", JSON.stringify(hidden));

    // Применяем настройки через единую функцию
    syncTableSettingsFromStorage();
  }
}
