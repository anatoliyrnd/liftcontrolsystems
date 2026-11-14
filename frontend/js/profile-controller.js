import { notify } from "./components/notify.js";
import { logHistoryAction } from "./history-logger.js";
import { authStore } from "./auth-store.js";
import {
  tableSettings,
  setScope,
  setOrder,
  setHidden,
  applyUserSettings,
} from "./table/settings.js";

/**
 * Профиль + настройка колонок.
 * 3.2: order/hidden пишутся per-user/per-scope через settings API.
 * 3.3: ширины здесь не участвуют — только ресайзер, локально.
 * Серверная часть (save_user_settings) включается после готовности
 * бэкенда; до этого настройки сохраняются локально и не теряются.
 */
export class ProfileController {
  constructor(api, router) {
    this.api = api;
    this.router = router;
    this._currentColumns = [];
    this._scope = "open";
  }

  async mount() {
    // Редактируем тот журнал, который был активен; отчёты не трогаем.
    this._scope = tableSettings.scope === "close" ? "close" : "open";
    setScope(this._scope);

    await this._loadUserData();
    this._renderColumnsSettings();

    const saveBtn = document.getElementById("saveSettingsBtn");
    if (saveBtn) saveBtn.onclick = () => this._saveSettings();
  }

  async _loadUserData() {
    const uid = authStore.getUser()?.id ?? null;
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

        if (response.column_settings) {
          applyUserSettings(uid, response.column_settings);
          setScope(this._scope);
        }
      }
    } catch (e) {
      console.warn("[ProfileController] Профиль недоступен, локальный кэш:", e);
    }

    this._currentColumns = tableSettings.columns.map((c) => ({
      ...c,
      visible: !c.hidden,
    }));
  }

  _renderColumnsSettings() {
    const container = document.getElementById("columnsSettingsList");
    if (!container) return;
    container.innerHTML = "";

    if (!this._currentColumns || this._currentColumns.length === 0) {
      const empty = document.createElement("div");
      empty.style.cssText = "color:var(--text-secondary);font-size:12px;";
      empty.textContent = "Список колонок пуст.";
      container.appendChild(empty);
      return;
    }

    this._currentColumns.forEach((col, index) => {
      const row = document.createElement("div");
      row.style.cssText =
        "display:flex;align-items:center;justify-content:space-between;padding:8px 12px;background:var(--bg-primary);border:1px solid var(--border-color);border-radius:6px;";

      const leftPart = document.createElement("div");
      leftPart.style.cssText = "display:flex;align-items:center;gap:10px;";

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
      rightPart.style.cssText = "display:flex;gap:4px;";

      const btnUp = document.createElement("button");
      btnUp.textContent = "↑";
      btnUp.className = "theme-toggle-btn";
      btnUp.style.cssText =
        "padding:4px 8px;font-size:14px;border-radius:4px;cursor:pointer;";

      const btnDown = document.createElement("button");
      btnDown.textContent = "↓";
      btnDown.className = "theme-toggle-btn";
      btnDown.style.cssText =
        "padding:4px 8px;font-size:14px;border-radius:4px;cursor:pointer;";

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
        const tmp = this._currentColumns[index - 1];
        this._currentColumns[index - 1] = this._currentColumns[index];
        this._currentColumns[index] = tmp;
        this._renderColumnsSettings();
      };
      btnDown.onclick = () => {
        if (btnDown.disabled) return;
        const tmp = this._currentColumns[index + 1];
        this._currentColumns[index + 1] = this._currentColumns[index];
        this._currentColumns[index] = tmp;
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
    if (btn) {
      btn.disabled = true;
      btn.textContent = "Сохранение...";
    }

    const profile = {
      surname: document.getElementById("profSurname")?.value.trim() || "",
      name: document.getElementById("profName")?.value.trim() || "",
      patronymic: document.getElementById("profPatronymic")?.value.trim() || "",
    };

    const passOld = document.getElementById("profPassOld")?.value || "";
    const passNew = document.getElementById("profPassNew")?.value || "";
    let password = null;
    if (passOld || passNew) {
      if (!passOld || !passNew) {
        notify.error("Для смены пароля заполните оба поля");
        if (btn) {
          btn.disabled = false;
          btn.textContent = "Сохранить профиль и настройки";
        }
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

    // 3.2: локальное применение per-user/per-scope — всегда, даже офлайн.
    setOrder(this._scope, order);
    setHidden(this._scope, hidden);

    const payload = {
      action: "save_user_settings",
      profile,
      column_settings: { [this._scope]: { order, hidden } },
    };
    if (password) payload.password = password;

    let serverOk = false;
    try {
      const response = await this.api.post(payload, "Сохранение настроек...");
      serverOk = response && response.status === "ok";
      if (!serverOk && response && response.code !== "unknown_action") {
        notify.error(response.message || "Ошибка сохранения на сервере");
      }
    } catch (e) {
      console.warn(
        "[ProfileController] Сервер недоступен, сохранено локально:",
        e,
      );
    }

    // Шапка: раздельное ФИО (протокол §13.4).
    const currentUser = authStore.getUser();
    if (currentUser) {
      currentUser.surname = profile.surname;
      currentUser.name = profile.name;
      currentUser.patronymic = profile.patronymic;
      authStore.setSession(
        authStore.getAccess(),
        authStore.getExpiresAt(),
        currentUser,
      );
      window.dispatchEvent(new CustomEvent("auth:updated"));
    }

    const oldEl = document.getElementById("profPassOld");
    const newEl = document.getElementById("profPassNew");
    if (oldEl) oldEl.value = "";
    if (newEl) newEl.value = "";

    logHistoryAction("Обновлены настройки профиля/таблицы");
    notify.success(
      serverOk
        ? "Настройки сохранены"
        : "Настройки колонок сохранены локально (сервер ещё не поддерживает сохранение).",
    );

    if (btn) {
      btn.disabled = false;
      btn.textContent = "Сохранить профиль и настройки";
    }
  }
}
