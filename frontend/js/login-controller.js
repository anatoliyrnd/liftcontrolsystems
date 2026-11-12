import { authStore } from "./auth-store.js";
import { notify } from "./components/notify.js";
import { logHistoryAction } from "./history-logger.js";

/**
 * Имя организации грузит main.js → loadTenantInfo() через get_tenant_info.
 * Дублирующий вызов { data: "tenant_info" } удалён (п. 1.18): такого экшена
 * нет, а org_name лежит под data, а не в корне ответа.
 */
export class LoginController {
  constructor(apiInstance, routerInstance) {
    this.api = apiInstance;
    this.router = routerInstance;
    this._focusTimer = null;
    this._mountId = 0;
  }

  async mount() {
    const myMountId = ++this._mountId;
    const isStale = () => this._mountId !== myMountId;

    const form = document.getElementById("loginForm");
    const nameInput = document.getElementById("loginName");
    const pwdInput = document.getElementById("loginPassword");
    const autoInput = document.getElementById("loginAutoLogin");
    const errorBox = document.getElementById("loginError");
    const submitBtn = document.getElementById("loginSubmit");
    const datalist = document.getElementById("orgUsersList");

    if (!form) return;

    this._focusTimer = setTimeout(() => nameInput?.focus(), 50);

    // onsubmit привязывается СИНХРОННО, до любого await: иначе ранний Enter
    // отправляет форму нативно и страница перезагружается.
    form.onsubmit = async (e) => {
      e.preventDefault();
      if (errorBox) errorBox.style.display = "none";
      if (submitBtn) {
        submitBtn.disabled = true;
        submitBtn.textContent = "Вход...";
      }

      const name = nameInput?.value.trim() || "";
      const pwd = pwdInput?.value || "";
      const auto = !!autoInput?.checked;

      let selectedUserId = null;
      if (datalist) {
        const matched = Array.from(datalist.options).find(
          (opt) => opt.value === name,
        );
        if (matched?.dataset.id) selectedUserId = Number(matched.dataset.id);
      }

      try {
        const resp = selectedUserId
          ? await this.api.loginById(selectedUserId, pwd, auto)
          : await this.api.login(name, pwd, auto);

        if (resp && resp.status === "ok" && resp.access_token) {
          authStore.setSession(resp.access_token, resp.expires_at, resp.user);
          const greetingName = this._formatName(resp.user);
          logHistoryAction("Вход выполнен: " + greetingName);
          notify.success("Добро пожаловать, " + greetingName);
          window.dispatchEvent(
            new CustomEvent("auth:loggedin", { detail: resp.user }),
          );
          this.router.navigate("#/");
          return;
        }

        const msg = (resp && resp.message) || "Не удалось войти.";
        const code = (resp && resp.code) || "";
        let friendly = msg;
        if (code === "invalid_credentials")
          friendly = "Неверное имя или пароль.";
        else if (code === "user_blocked")
          friendly = "Учётная запись заблокирована.";
        else if (code === "device_mismatch")
          friendly = "Устройство изменилось. Введите пароль заново.";
        else if (code === "invalid_input")
          friendly = "Проверьте логин и пароль.";
        else if (code === "network_error")
          friendly = "Нет связи с сервером. Проверьте соединение.";
        else if (code === "rate_limited")
          friendly = "Слишком много попыток. Подождите немного.";

        if (errorBox) {
          errorBox.textContent = friendly;
          errorBox.style.display = "block";
        }
        logHistoryAction("Ошибка входа: " + friendly);
        notify.error(friendly);
      } catch (err) {
        console.error("[LoginController] Ошибка:", err);
        if (errorBox) {
          errorBox.textContent = "Сбой сети при попытке входа.";
          errorBox.style.display = "block";
        }
      } finally {
        const btn = document.getElementById("loginSubmit");
        if (btn) {
          btn.disabled = false;
          btn.textContent = "Войти";
        }
      }
    };

    // Список быстрого входа — после привязки onsubmit.
    const orgKey = localStorage.getItem("org_key");
    if (orgKey && datalist && navigator.onLine) {
      try {
        const resp = await this.api.post(
          { data: "get_org_users", org_key: orgKey },
          null,
          "silent",
        );
        if (isStale()) return;
        if (resp && resp.status === "ok" && Array.isArray(resp.users)) {
          const liveList = document.getElementById("orgUsersList");
          if (!liveList) return;
          liveList.innerHTML = "";
          for (const u of resp.users) {
            const option = document.createElement("option");
            option.value = u.name;
            option.dataset.id = String(u.user_id);
            liveList.appendChild(option);
          }
        }
      } catch (e) {
        console.warn(
          "[LoginController] Не удалось загрузить список пользователей",
          e,
        );
      }
    }
  }

  _formatName(user) {
    if (!user) return "Пользователь";
    if (user.surname) return `${user.surname} ${user.name || ""}`.trim();
    return user.name || "Пользователь";
  }

  unmount() {
    this._mountId++;
    if (this._focusTimer) {
      clearTimeout(this._focusTimer);
      this._focusTimer = null;
    }
    const form = document.getElementById("loginForm");
    if (form) form.onsubmit = null;
    this.api.abortTag("login");
  }
}
