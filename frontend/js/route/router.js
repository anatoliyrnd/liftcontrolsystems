/**
 * Клиентский SPA-Роутер на чистом JavaScript.
 *
 * Публичных маршрутов нет. Любой неавторизованный переход
 * принудительно перенаправляется на #/login.
 *
 * Авторизованный пользователь с #/login перенаправляется на #/.
 */
export class Router {
    /**
     * @param {Function} authCheck — функция, возвращающая true, если пользователь авторизован
     */
    constructor(authCheck) {
        this.routes = {};
        this.appContainer = document.getElementById('app');
        this.authCheck = authCheck || (() => true);

        // 'load' больше не слушаем — старт роутера контролируется вручную из main.js
        window.addEventListener('hashchange', () => this._handleRoute());
    }

    /**
     * @param {string} hashPath — Путь роута ('#/', '#/create', '#/ticket', '#/login')
     * @param {Function} templateFn — Функция, возвращающая HTML-строку
     * @param {Function} mountFn — Логика (JS), инициализируемая после рендера в DOM
     */
    addRoute(hashPath, templateFn, mountFn = () => {}) {
        this.routes[hashPath] = { templateFn, mountFn };
    }

    navigate(hashPath) {
        window.location.hash = hashPath;
    }



    /**
     * Внутренний обработчик маршрутизации.
     * Вызывается на hashchange и один раз вручную из main.js после tryAutoLogin.
     */
    _handleRoute() {
        let currentHash = window.location.hash || '#/';

        // Парсинг динамических ID параметров (например: #/ticket/35732 -> #/ticket)
        let param = null;
        if (currentHash.startsWith('#/ticket/')) {
            param = currentHash.replace('#/ticket/', '');
            currentHash = '#/ticket';
        }

        const isAuthenticated = this.authCheck();

        // 1. Не авторизован → только #/login
        if (!isAuthenticated && currentHash !== '#/login') {
            this.navigate('#/login');
            return;
        }

        // 2. Авторизован и сидит на #/login → на главную
        if (isAuthenticated && currentHash === '#/login') {
            this.navigate('#/');
            return;
        }

        const route = this.routes[currentHash];

        if (route) {
            this.appContainer.innerHTML = route.templateFn(param);
            route.mountFn(param);
        } else {
            // 404
            this.appContainer.innerHTML = `
                <div class="container" style="text-align: center; padding: 4rem 0;">
                    <h2>Раздел не найден (404)</h2>
                    <a href="#/" style="color: var(--accent); font-size: 14px;">Вернуться в Открытые заявки</a>
                </div>`;
        }
    }
}