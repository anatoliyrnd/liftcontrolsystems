/**
 * Клиентский SPA-Роутер на чистом JavaScript.
 *
 * Публичных маршрутов нет. Любой неавторизованный переход
 * принудительно перенаправляется на #/login.
 *
 * Авторизованный пользователь с #/login перенаправляется на #/.
 */
export class Router {
  constructor(authCheck) {
    this.routes = {};
    this.appContainer = document.getElementById("app");
    this.authCheck = authCheck || (() => true);
    this._onBeforeNavigate = null;

    window.addEventListener("hashchange", () => this._handleRoute());
  }

  addRoute(hashPath, templateFn, mountFn = () => {}) {
    this.routes[hashPath] = { templateFn, mountFn };
  }

  /**
   * Регистрирует callback, который вызывается ПЕРЕД заменой DOM
   * при каждом переходе (и для известных маршрутов, и для 404,
   * и для placeholder-маршрутов без mountFn).
   *
   * Зачем: unmount активных контроллеров должен видеть старый DOM
   * (например, _unlockForm/_unlockCard ищут свои элементы). Если
   * вызывать unmount после innerHTML — эти методы молча ничего
   * не сделают. Также единая точка очистки закрывает placeholder
   * и 404, где mountFn не задан.
   */
  onBeforeNavigate(cb) {
    this._onBeforeNavigate = cb;
  }

  navigate(hashPath) {
    window.location.hash = hashPath;
  }

  /**
   * Внутренний обработчик маршрутизации.
   * Вызывается на hashchange и один раз вручную из main.js после tryAutoLogin.
   */
  _handleRoute() {
    let currentHash = window.location.hash || "#/";
    const isAuthenticated = this.authCheck();

    // Редиректы — до onBeforeNavigate: маршрут не меняется, DOM не перерисовывается.
    if (!isAuthenticated && currentHash !== "#/login") {
      this.navigate("#/login");
      return;
    }
    if (isAuthenticated && currentHash === "#/login") {
      this.navigate("#/");
      return;
    }

    let param = null;
    if (currentHash.startsWith("#/ticket/")) {
      param = currentHash.replace("#/ticket/", "");
      currentHash = "#/ticket";

      // 1.2: валидация param — только цифры или offline_<digits>_<8 alnum>.
      // Иначе 404 без запроса к сети.
      const isValidParam =
        /^\d+$/.test(param) || /^offline_\d+_[a-z0-9]{8}$/.test(param);
      if (!isValidParam) {
        if (typeof this._onBeforeNavigate === "function") {
          try {
            this._onBeforeNavigate();
          } catch (e) {
            console.error("[Router] onBeforeNavigate error:", e);
          }
        }
        this.appContainer.innerHTML = `
        <div class="container" style="text-align: center; padding: 4rem 0;">
          <h2>Раздел не найден (404)</h2>
          <a href="#/" style="color: var(--accent); font-size: 14px;">Вернуться в Открытые заявки</a>
        </div>`;
        return;
      }
    }

    // Cleanup ДО innerHTML — unmount видит старый DOM.
    if (typeof this._onBeforeNavigate === "function") {
      try {
        this._onBeforeNavigate();
      } catch (e) {
        console.error("[Router] onBeforeNavigate error:", e);
      }
    }

    const route = this.routes[currentHash];
    if (route) {
      this.appContainer.innerHTML = route.templateFn(param);
      route.mountFn(param);
    } else {
      this.appContainer.innerHTML = `
      <div class="container" style="text-align: center; padding: 4rem 0;">
        <h2>Раздел не найден (404)</h2>
        <a href="#/" style="color: var(--accent); font-size: 14px;">Вернуться в Открытые заявки</a>
      </div>`;
    }
  }
}
