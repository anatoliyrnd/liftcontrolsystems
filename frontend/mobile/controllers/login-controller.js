import { api } from "../api.js";
import { authStore } from "../auth-store.js";

export class LoginController {
  constructor() {
    this.view = document.getElementById("view-login");
    this.form = document.getElementById("loginForm");
    this.nameInput = document.getElementById("loginName");
    this.pwdInput = document.getElementById("loginPassword");
    this.autoInput = document.getElementById("loginAutoLogin");
    this.errorBox = document.getElementById("loginError");
    this.submitBtn = document.getElementById("loginSubmit");
  }

  mount() {
    this.view.classList.add("active");
    this.errorBox.style.display = "none";

    this.form.onsubmit = async (e) => {
      e.preventDefault();
      this.errorBox.style.display = "none";
      this.submitBtn.disabled = true;
      this.submitBtn.textContent = "Вход...";

      const name = this.nameInput.value.trim();
      const pwd = this.pwdInput.value;
      const auto = this.autoInput.checked;

      try {
        // Вызываем твой родной метод логина
        const resp = await api.login(name, pwd, auto);

        if (resp && resp.status === "ok" && resp.access_token) {
          // Сохраняем сессию (в authStore)
          authStore.setSession(resp.access_token, resp.expires_at, resp.user);

          // ВАЖНО ДЛЯ МОБИЛКИ: Дублируем токен в localStorage для офлайн-режима
          localStorage.setItem("mob_offline_token", resp.access_token);
          localStorage.setItem("mob_offline_user", JSON.stringify(resp.user));

          // Переходим в приложение
          window.location.hash = "#/list";
        } else {
          const code = (resp && resp.code) || "";
          let msg = (resp && resp.message) || "Ошибка входа";

          if (code === "invalid_credentials") msg = "Неверный логин или пароль";
          if (code === "network_error") msg = "Нет связи с сервером";

          this.errorBox.textContent = msg;
          this.errorBox.style.display = "block";
        }
      } catch (err) {
        this.errorBox.textContent = "Сбой сети при попытке входа.";
        this.errorBox.style.display = "block";
      } finally {
        this.submitBtn.disabled = false;
        this.submitBtn.textContent = "Войти";
      }
    };
  }
  unmount() {
    this.view.classList.remove("active");
    if (this.form) this.form.onsubmit = null; // Снимаем обработчик
  }
}
