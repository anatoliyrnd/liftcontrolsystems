export function loginPageTemplate() {
  return `
    <div class="container" style="max-width: 400px; margin: 0 auto; display: flex; align-items: center; justify-content: center; min-height: 60vh;">
        <div class="table-wrapper" style="padding: 2rem; width: 100%;">
            <h1 style="font-size: 1.5rem; margin-bottom: 1.5rem; text-align: center;">Вход в систему</h1>
            <form id="loginForm" style="display: flex; flex-direction: column; gap: 14px;">
                <div>
                    <label style="display:block; margin-bottom: 5px; font-size: 13px; color: var(--text-secondary);">Логин</label>
                    <input type="text" id="loginName" class="search-input" autocomplete="username" list="orgUsersList" required>
                    <datalist id="orgUsersList"></datalist>
                </div>
                <div>
                    <label style="display:block; margin-bottom: 5px; font-size: 13px; color: var(--text-secondary);">Пароль</label>
                    <input type="password" id="loginPassword" class="search-input" autocomplete="current-password" required>
                </div>
                <label style="display: inline-flex; align-items: center; gap: 8px; font-size: 13px; color: var(--text-secondary); cursor: pointer;">
                    <input type="checkbox" id="loginAutoLogin" checked>
                    <span>Запомнить меня (30 дней)</span>
                </label>
                <div id="loginError" style="display: none; color: #ef4444; font-size: 13px; padding: 8px 12px; background: rgba(239,68,68,0.1); border: 1px solid #ef4444; border-radius: 6px;"></div>
                <button type="submit" id="loginSubmit" class="theme-toggle-btn" style="border-radius: 8px; width: 100%; padding: 12px; font-size: 14px; background: var(--accent); color: var(--mark-text); font-weight: 600;">Войти</button>
            </form>
        </div>
    </div>`;
}
