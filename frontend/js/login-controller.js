import { authStore } from "./auth-store.js";
import { notify } from "./components/notify.js";
import { logHistoryAction } from "./history-logger.js";

export class LoginController {
  constructor(apiInstance, routerInstance) {
    this.api = apiInstance;
    this.router = routerInstance;
  }

  async mount() {
    const form = document.getElementById("loginForm");
    const nameInput = document.getElementById("loginName");
    const pwdInput = document.getElementById("loginPassword");
    const autoInput = document.getElementById("loginAutoLogin");
    const errorBox = document.getElementById("loginError");
    const submitBtn = document.getElementById("loginSubmit");
    const datalist = document.getElementById("orgUsersList");

    if (!form) return;

    setTimeout(() => nameInput && nameInput.focus(), 50);

    // --- УМНЫЙ ЛОГИН: Загрузка списка пользователей организации ---
    const orgKey = localStorage.getItem("org_key");
    if (orgKey && datalist) {
      try {
        // Делаем запрос тихо (без спиннера)
        const resp = await this.api.post(
          { data: "get_org_users", org_key: orgKey },
          null,
          "silent",
        );
        if (resp && resp.status === "ok" && Array.isArray(resp.users)) {
          datalist.innerHTML = "";
          resp.users.forEach((u) => {
            const option = document.createElement("option");
            option.value = u.name; // То, что видит пользователь
            option.dataset.id = u.user_id; // То, что отправим на сервер
            datalist.appendChild(option);
          });
        }
      } catch (e) {
        console.warn(
          "[LoginController] Не удалось загрузить список пользователей",
          e,
        );
      }
    }

    form.onsubmit = async (e) => {
      e.preventDefault();
      errorBox.style.display = "none";
      submitBtn.disabled = true;
      submitBtn.textContent = "Вход...";

      const name = nameInput.value.trim();
      const pwd = pwdInput.value;
      const auto = autoInput.checked;

      // Проверяем, выбран ли пользователь из datalist
      let selectedUserId = null;
      if (datalist) {
        const matchedOption = Array.from(datalist.options).find(
          (opt) => opt.value === name,
        );
        if (matchedOption && matchedOption.dataset.id) {
          selectedUserId = Number(matchedOption.dataset.id);
        }
      }

      try {
        let resp;
        if (selectedUserId) {
          // Логинимся по ID
          resp = await this.api.loginById(selectedUserId, pwd, auto);
        } else {
          // Обычный логин по имени
          resp = await this.api.login(name, pwd, auto);
        }

        if (resp && resp.status === "ok" && resp.access_token) {
          authStore.setSession(resp.access_token, resp.expires_at, resp.user);

          // Форматируем имя для красивого тоста
          const greetingName = this._formatName(resp.user);

          logHistoryAction("Вход выполнен: " + greetingName);
          notify.success("Добро пожаловать, " + greetingName);

          // Убираем reload() и кидаем событие
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

        errorBox.textContent = friendly;
        errorBox.style.display = "block";
        logHistoryAction("Ошибка входа: " + friendly);
        notify.error(friendly);
      } catch (err) {
        console.error("[LoginController] Ошибка:", err);
        errorBox.textContent = "Сбой сети при попытке входа.";
        errorBox.style.display = "block";
      } finally {
        submitBtn.disabled = false;
        submitBtn.textContent = "Войти";
      }
    };
  }
  _formatName(user) {
    if (!user) return "Пользователь";
    if (user.surname) {
      return `${user.surname} ${user.name || ""}`.trim();
    }
    return user.name || "Пользователь";
  }
  unmount() {
    const form = document.getElementById("loginForm");
    if (form) form.onsubmit = null;
  }
}
