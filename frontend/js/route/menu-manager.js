import { staffStore } from '../staff-store.js';
import { userStore } from '../user-store.js';
import { dictStore } from '../dict-store.js';
import { authStore } from '../auth-store.js'; // <-- ДОБАВЛЕНО ДЛЯ FALLBACK
import { API, AUTH } from '../config.js';

/**
 * Класс динамического адаптивного управления навигационным меню SPA.
 */
export class MenuManager {
    constructor(apiInstance, routerInstance, containerId) {
        this.api = apiInstance;
        this.router = routerInstance;
        this.container = document.getElementById(containerId);
        this.hamburgerBtn = null;

        this._onDocumentClick = this._onDocumentClick.bind(this);
        this._onHashChange = this._onHashChange.bind(this);

        document.addEventListener('click', this._onDocumentClick);
        window.addEventListener('hashchange', this._onHashChange);
    }

    _sanitizeIconSvg(raw) {
        if (typeof raw !== 'string') return null;
        const s = raw.trim();
        if (!s.startsWith('<svg') || !s.endsWith('</svg>')) return null;
        if (/<script/i.test(s))         return null;
        if (/<foreignObject/i.test(s))  return null;
        if (/\son\w+\s*=/i.test(s))     return null;
        if (/javascript:/i.test(s))     return null;
        if (/data:text\/html/i.test(s)) return null;
        return s;
    }

    async initialize() {
        try {
            const responseData = await this.api.get(
                { data: 'config' },
                'Генерация интерфейса навигации...'
            );

            // УДАЛЕНО: Блок с AUTH.TOKEN_STORAGE_KEY и localStorage
            // Токен теперь управляется исключительно через authStore и httpOnly cookie.

            // Справочник механиков — в глобальный стор
            staffStore.setList(responseData && responseData.staff_list);

            // Справочники отдел / запрос / группа — в глобальный стор
            if (responseData) {
                dictStore.set('department', responseData.department);
                dictStore.set('request', responseData.request);
                dictStore.set('group', responseData.group);
            }

            // Роль и ID пользователя — в глобальный стор.
            const perms = (responseData && responseData.user_permissions) || {};
            userStore.setRole(perms.role);

            // ДОБАВЛЕНО: fallback на authStore, если сервер не прислал user_id
            const effectiveUserId = perms.user_id ?? (authStore.getUser()?.id ?? null);
            userStore.setUserId(effectiveUserId);

            if (responseData && Array.isArray(responseData.menu_structure)) {
                this.renderMenu(responseData.menu_structure, perms);
                return;
            }

            console.warn('[MenuManager] Нетипичная структура конфига. Задействован fallback.');
            this._renderDefaultFallbackMenu();

        } catch (error) {
            console.error('[MenuManager] Ошибка сети при сборке меню:', error);
            this._renderDefaultFallbackMenu();
        }
    }

    renderMenu(menuStructure, userPermissions = {}) {
        if (!this.container) return;

        const navParent = this.container.parentElement;
        const oldHamburger = navParent.querySelector('.menu-hamburger-trigger');
        if (oldHamburger) oldHamburger.remove();

        this.container.innerHTML = '';
        this.container.className = 'responsive-menu-list';

        this.hamburgerBtn = document.createElement('button');
        this.hamburgerBtn.className = 'menu-hamburger-trigger';
        this.hamburgerBtn.setAttribute('title', 'Открыть меню');
        this.hamburgerBtn.innerHTML = `
            <svg viewBox="0 0 24 24" width="24" height="24" fill="currentColor">
                <path d="M3 18h18v-2H3v2zm0-5h18v-2H3v2zm0-7v2h18V6H3z"/>
            </svg>
        `;
        this.hamburgerBtn.addEventListener('click', (e) => {
            e.stopPropagation();
            this.container.classList.toggle('open');
        });
        navParent.insertBefore(this.hamburgerBtn, this.container);

        menuStructure.forEach(item => {
            if (item.required_permission && !userPermissions[item.required_permission]) {
                return;
            }

            const li = document.createElement('li');
            li.className = 'nav-menu-li';

            let element;
            if (item.id === 'create' || item.type === 'icon-button') {
                element = document.createElement('button');
                element.className = 'theme-toggle-btn add-ticket-btn';
                element.setAttribute('title', item.title || 'Добавить заявку');
                element.style.cssText = 'display: inline-flex; align-items: center; justify-content: center; width: 36px; height: 36px; padding: 0; border-radius: 50%; cursor: pointer; vertical-align: middle; transition: all 0.2s ease;';
                const safeSvg = this._sanitizeIconSvg(item.icon_svg);
                element.innerHTML = safeSvg || `
                    <svg viewBox="0 0 24 24" width="20" height="20" fill="currentColor">
                        <path d="M19 13h-6v6h-2v-6H5v-2h6V5h2v6h6v2z"/>
                    </svg>`;
            } else {
                element = document.createElement('a');
                element.className = 'menu-item';
                element.textContent = item.title;
                element.href = item.target_hash;
            }

            element.setAttribute('data-target-hash', item.target_hash);

            element.addEventListener('click', (e) => {
                e.preventDefault();
                this.container.classList.remove('open');
                this.router.navigate(item.target_hash);
            });

            li.appendChild(element);
            this.container.appendChild(li);
        });

        this._syncActiveState();
    }

    _onDocumentClick(e) {
        if (!this.container) return;
        if (!this.container.classList.contains('open')) return;
        if (this.container.contains(e.target)) return;
        this.container.classList.remove('open');
    }

    _onHashChange() {
        this._syncActiveState();
    }

    _syncActiveState() {
        if (!this.container) return;

        const currentHash = window.location.hash || '#/';

        this.container.querySelectorAll('.nav-menu-li').forEach(li => li.classList.remove('active'));
        this.container.querySelectorAll('[data-target-hash]').forEach(el => el.classList.remove('active'));

        let matched = this.container.querySelector(`[data-target-hash="${currentHash}"]`);

        if (!matched && currentHash.startsWith('#/ticket/')) {
            matched = this.container.querySelector('[data-target-hash="#/"]');
        }

        if (matched) {
            matched.classList.add('active');
            const parentLi = matched.closest('.nav-menu-li');
            if (parentLi) parentLi.classList.add('active');
        }
    }

    _renderDefaultFallbackMenu() {
        const defaultStructure = [
            { "id": "create", "title": "Добавить заявку", "type": "icon-button", "icon_svg": "<svg viewBox='0 0 24 24' width='20' height='20' fill='currentColor'><path d='M19 13h-6v6h-2v-6H5v-2h6V5h2v6h6v2z'/></svg>", "target_hash": "#/create" },
            { "id": "open_tickets", "title": "Открытые заявки", "type": "nav-link", "target_hash": "#/", "is_default": true },
            { "id": "closed_tickets", "title": "Закрытые заявки", "type": "nav-link", "target_hash": "#/closed" },
            { "id": "reports", "title": "Отчеты", "type": "nav-link", "target_hash": "#/reports" },
            { "id": "addresses", "title": "Адреса", "type": "nav-link", "target_hash": "#/addresses" },
            { "id": "settings", "title": "Настройки", "type": "nav-link", "target_hash": "#/settings" },
            { "id": "more", "title": "Прочее", "type": "nav-link", "target_hash": "#/more" }
        ];

        const mockPermissions = { role: "administrator", can_add_ticket: true, can_view_reports: true, can_view_settings: true };
        this.renderMenu(defaultStructure, mockPermissions);
    }
}