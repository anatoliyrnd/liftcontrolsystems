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
 *
 * 3.2: order/hidden пишутся per-user/per-scope через settings API.
 * 3.3: ширины здесь не участвуют — только ресайзер, локально.
 *
 * Серверная часть (save_user_settings) ещё не реализована: экшен уходит
 * в unknown_action, настройки колонок сохраняются локально и не теряются.
 *
 * ДЕМО-РЕЖИМ. На демо все учётки общие — admin, dispatcher, mechanic,
 * guest. Смена пароля одним посетителем запирает вход остальным, а смена
 * ФИО подменяет автора во всех заявках и заметках. Решение принимает
 * сервер (DemoGuard), клиент только исполняет флаг can_edit_profile.
 *
 * Флаг читается из config, а не выводится из роли или домена: второй
 * источник решения разошёлся бы с серверным отказом, когда появится
 * save_user_settings. Значение по умолчанию — РАЗРЕШЕНО: отсутствие
 * поля означает старый сервер, а блокировка по транспорту забрала бы
 * рабочий экран. Клиентский disabled — это UX, не защита: обходится
 * через DevTools, поэтому барьер обязан быть и на сервере.
 */

const PROFILE_FIELD_IDS = ["profSurname", "profName", "profPatronymic"];
const PASSWORD_FIELD_IDS = ["profPassOld", "profPassNew"];

const READONLY_NOTICE_ID = "profileReadonlyNotice";
const READONLY_HINT = "Демо-аккаунт общий: пароль и ФИО менять нельзя";

const SAVE_LABEL_FULL = "Сохранить профиль и настройки";
const SAVE_LABEL_COLUMNS = "Сохранить настройки колонок";

export class ProfileController {
  constructor(api, router) {
    this.api = api;
    this.router = router;
    this._currentColumns = [];
    this._scope = "open";

    // true до ответа сервера — см. комментарий класса.
    this._canEditProfile = true;
  }

  async mount() {
    // Редактируем тот журнал, который был активен; отчёты не трогаем.
    this._scope = tableSettings.scope === "close" ? "close" : "open";
    setScope(this._scope);

    // Порядок важен: сначала гасим поля, потом наполняем их значениями.
    // Программная установка value работает и на disabled-инпуте, поэтому
    // заблокированное поле показывает реальное ФИО, а не пустую рамку.
    await this._loadProfilePermission();
    this._applyProfilePermission();

    await this._loadUserData();
    this._renderColumnsSettings();

    const saveBtn = document.getElementById("saveSettingsBtn");
    if (saveBtn) {
      saveBtn.onclick = () => this._saveSettings();
      // Кнопка ОДНА на профиль и колонки. Скрывать её нельзя — это
      // забрало бы сохранение колонок, которое в демо разрешено.
      // Меняем подпись: она обязана описывать то, что реально сохранится.
      saveBtn.textContent = this._saveLabel();
    }
  }

  _saveLabel() {
    return this._canEditProfile ? SAVE_LABEL_FULL : SAVE_LABEL_COLUMNS;
  }

  /**
   * Флаг запрашивается у config — единственного эндпоинта, который его
   * несёт. Профиль открывается редко, один запрос на вход в экран дешевле
   * зависимости от формы чужого кэша прав.
   *
   * Если полей профиля в шаблоне нет, запрос не нужен вовсе.
   */
  async _loadProfilePermission() {
    this._canEditProfile = true;

    const hasFields = [...PROFILE_FIELD_IDS, ...PASSWORD_FIELD_IDS].some(
      (id) => document.getElementById(id) !== null,
    );
    if (!hasFields) return;

    try {
      const response = await this.api.post(
        { data: "config" },
        "Загрузка профиля...",
      );
      const flag = response?.user_permissions?.can_edit_profile;

      // Строго boolean: сервер отдаёт JSON-bool. Строка "false" truthy,
      // и приведение «на глаз» открыло бы редактирование там, где сервер
      // его запретил. Неизвестное значение = флаг не пришёл = дефолт.
      if (typeof flag === "boolean") {
        this._canEditProfile = flag;
      }
    } catch (e) {
      console.warn(
        "[ProfileController] Флаг профиля недоступен, редактирование разрешено:",
        e,
      );
    }
  }

  /** Идемпотентно: повторный mount не плодит баннеры и не теряет title. */
  _applyProfilePermission() {
    const locked = !this._canEditProfile;

    [...PROFILE_FIELD_IDS, ...PASSWORD_FIELD_IDS].forEach((id) => {
      const el = document.getElementById(id);
      if (!el) return;

      el.disabled = locked;

      if (locked) {
        el.setAttribute("aria-disabled", "true");
        el.title = READONLY_HINT;
        el.dataset.demoLocked = "1";

        // Плейсхолдер виден прямо в поле: баннер стоит над блоком ФИО
        // и до полей пароля может не попадать в экран.
        if (PASSWORD_FIELD_IDS.includes(id)) {
          if (!("demoPlaceholder" in el.dataset)) {
            el.dataset.demoPlaceholder = el.placeholder || "";
          }
          el.placeholder = "Недоступно в демо-режиме";
          el.value = "";
        }
      } else if (el.dataset.demoLocked === "1") {
        // Снимаем только своё: title и placeholder могли быть заданы
        // шаблоном, и стирать их при разблокировке нельзя.
        el.removeAttribute("aria-disabled");
        el.removeAttribute("title");
        delete el.dataset.demoLocked;

        if ("demoPlaceholder" in el.dataset) {
          el.placeholder = el.dataset.demoPlaceholder;
          delete el.dataset.demoPlaceholder;
        }
      }
    });

    this._renderReadonlyNotice(locked);
  }

  _renderReadonlyNotice(locked) {
    const existing = document.getElementById(READONLY_NOTICE_ID);

    if (!locked) {
      existing?.remove();
      return;
    }
    if (existing) return;

    const anchor =
      document.getElementById(PROFILE_FIELD_IDS[0]) ||
      document.getElementById(PASSWORD_FIELD_IDS[0]);
    if (!anchor) return;

    // Вставляем над блоком, а не внутрь строки формы: иначе баннер
    // унаследует grid/flex-раскладку строки и сожмёт подпись.
    const host =
      anchor.closest("fieldset, .form-group, .form-row, .settings-block") ||
      anchor;
    const parent = host.parentElement;
    if (!parent) return;

    const note = document.createElement("div");
    note.id = READONLY_NOTICE_ID;
    note.setAttribute("role", "note");
    note.style.cssText = [
      "display:flex",
      "align-items:flex-start",
      "gap:8px",
      "margin:0 0 12px",
      "padding:10px 12px",
      "border:1px solid var(--border-color)",
      "border-left:3px solid #d97706",
      "border-radius:6px",
      "background:var(--bg-primary)",
      "color:var(--text-secondary)",
      "font-size:12px",
      "line-height:1.5",
    ].join(";");

    const icon = document.createElement("span");
    icon.textContent = "🔒";
    icon.setAttribute("aria-hidden", "true");

    const text = document.createElement("span");
    text.textContent =
      "Демо-аккаунт общий для всех посетителей. Пароль и ФИО менять нельзя — " +
      "это заперло бы вход остальным и подменило автора в заявках. " +
      "Настройки колонок сохраняются.";

    note.appendChild(icon);
    note.appendChild(text);
    parent.insertBefore(note, host);
  }

  async _loadUserData() {
    const uid = authStore.getUser()?.id ?? null;
    let response = null;

    try {
      response = await this.api.post(
        { data: "get_user_settings" },
        "Загрузка профиля...",
      );

      if (response && response.status === "ok" && response.column_settings) {
        applyUserSettings(uid, response.column_settings);
        setScope(this._scope);
      }
    } catch (e) {
      console.warn("[ProfileController] Профиль недоступен, локальный кэш:", e);
    }

    // Фолбэк на сессию: get_user_settings пока отвечает unknown_action,
    // и без него поля оставались пустыми даже при известном ФИО.
    // Пустое заблокированное поле выглядит как поломка, а не как запрет.
    //
    // user.name — имя (user_firstname), для незаполненных записей полное
    // ФИО (§19.1): то же значение, что показывает шапка.
    const session = authStore.getUser() || {};
    const p = (response && response.status === "ok" && response.profile) || {};

    const values = {
      profSurname: p.surname || session.surname || "",
      profName: p.name || session.name || "",
      profPatronymic: p.patronymic || session.patronymic || "",
    };

    Object.entries(values).forEach(([id, value]) => {
      const el = document.getElementById(id);
      if (el) el.value = value;
    });

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
    const idleLabel = this._saveLabel();

    if (btn) {
      btn.disabled = true;
      btn.textContent = "Сохранение...";
    }

    const canEdit = this._canEditProfile;
    let profile = null;
    let password = null;

    // В демо профиль и пароль не читаются и не отправляются вовсе.
    // Отправка «пустого профиля» перезаписала бы ФИО пустыми строками,
    // когда сервер начнёт принимать экшен.
    if (canEdit) {
      profile = {
        surname: document.getElementById("profSurname")?.value.trim() || "",
        name: document.getElementById("profName")?.value.trim() || "",
        patronymic:
          document.getElementById("profPatronymic")?.value.trim() || "",
      };

      const passOld = document.getElementById("profPassOld")?.value || "";
      const passNew = document.getElementById("profPassNew")?.value || "";

      if (passOld || passNew) {
        if (!passOld || !passNew) {
          notify.error("Для смены пароля заполните оба поля");
          if (btn) {
            btn.disabled = false;
            btn.textContent = idleLabel;
          }
          return;
        }
        password = { old: passOld, new: passNew };
      }
    }

    const order = [];
    const hidden = [];
    this._currentColumns.forEach((col) => {
      order.push(col.id);
      if (col.visible === false) hidden.push(col.id);
    });

    // 3.2: локальное применение per-user/per-scope — всегда, даже офлайн.
    // Настройки колонок в демо разрешены: они персональны и безвредны.
    setOrder(this._scope, order);
    setHidden(this._scope, hidden);

    const payload = {
      action: "save_user_settings",
      column_settings: { [this._scope]: { order, hidden } },
    };
    if (profile) payload.profile = profile;
    if (password) payload.password = password;

    let response = null;
    try {
      response = await this.api.post(payload, "Сохранение настроек...");
    } catch (e) {
      console.warn(
        "[ProfileController] Сервер недоступен, сохранено локально:",
        e,
      );
    }

    const serverOk = !!response && response.status === "ok";

    // unknown_action — штатный режим «сервер ещё не поддерживает»,
    // не ошибка. Всё остальное с status !== ok — явный отказ.
    const serverRejected =
      !!response &&
      response.status !== "ok" &&
      response.code !== "unknown_action";

    if (serverRejected) {
      notify.error(response.message || "Ошибка сохранения на сервере");
    }

    // Шапка: раздельное ФИО (протокол §13.4).
    // Не применяем при явном отказе сервера — иначе интерфейс показывает
    // сохранённое имя, которого сервер не принял, и после F5 оно исчезнет.
    // Офлайн и unknown_action остаются локальным режимом, как и раньше.
    if (canEdit && profile && !serverRejected) {
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
    }

    const oldEl = document.getElementById("profPassOld");
    const newEl = document.getElementById("profPassNew");
    if (oldEl) oldEl.value = "";
    if (newEl) newEl.value = "";

    logHistoryAction(
      canEdit
        ? "Обновлены настройки профиля/таблицы"
        : "Обновлены настройки колонок",
    );

    // Успех не заявляем после отказа: два противоположных тоста подряд
    // оставили бы пользователя в неведении, что именно сохранилось.
    if (!serverRejected) {
      const scopeText = canEdit ? "Настройки" : "Настройки колонок";
      notify.success(
        serverOk
          ? `${scopeText} сохранены`
          : `${scopeText} сохранены локально (сервер ещё не поддерживает сохранение).`,
      );
    }

    if (btn) {
      btn.disabled = false;
      btn.textContent = idleLabel;
    }
  }
}
