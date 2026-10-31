export function profilePageTemplate() {
  return `
    <div class="container" style="max-width: 800px;">
        <h1 style="margin-bottom: 1.5rem;">Личный кабинет</h1>
        <div class="table-wrapper" style="padding: 2rem; display: flex; flex-direction: column; gap: 25px;">
            
            <!-- Блок Профиля -->
            <div style="border-bottom: 1px solid var(--border-color); padding-bottom: 20px;">
                <h3 style="margin-bottom: 15px;">👤 Личные данные</h3>
                <div style="display: grid; grid-template-columns: 1fr 1fr 1fr; gap: 15px;">
                    <div><label style="display:block; margin-bottom: 5px; font-size: 13px; color: var(--text-secondary);">Фамилия</label><input type="text" id="profSurname" class="search-input" style="width: 100%;"></div>
                    <div><label style="display:block; margin-bottom: 5px; font-size: 13px; color: var(--text-secondary);">Имя</label><input type="text" id="profName" class="search-input" style="width: 100%;"></div>
                    <div><label style="display:block; margin-bottom: 5px; font-size: 13px; color: var(--text-secondary);">Отчество</label><input type="text" id="profPatronymic" class="search-input" style="width: 100%;"></div>
                </div>
            </div>

            <!-- Блок Смены Пароля -->
            <div style="border-bottom: 1px solid var(--border-color); padding-bottom: 20px;">
                <h3 style="margin-bottom: 15px;">🔒 Смена пароля</h3>
                <p style="font-size: 13px; color: var(--text-secondary); margin-bottom: 10px;">Оставьте поля пустыми, если не хотите менять пароль.</p>
                <div style="display: grid; grid-template-columns: 1fr 1fr; gap: 15px;">
                    <div><label style="display:block; margin-bottom: 5px; font-size: 13px; color: var(--text-secondary);">Текущий пароль</label><input type="password" id="profPassOld" class="search-input" style="width: 100%;"></div>
                    <div><label style="display:block; margin-bottom: 5px; font-size: 13px; color: var(--text-secondary);">Новый пароль</label><input type="password" id="profPassNew" class="search-input" style="width: 100%;"></div>
                </div>
            </div>

            <!-- Блок Настроек Таблицы -->
            <details style="border-bottom: 1px solid var(--border-color); padding-bottom: 20px;">
                <summary style="cursor: pointer; font-size: 1.17em; font-weight: bold; margin-bottom: 15px; outline: none; user-select: none; display: flex; align-items: center; gap: 8px;">📊 Настройка таблицы</summary>
                <p style="font-size: 13px; color: var(--text-secondary); margin-bottom: 10px; padding-top: 10px;">Используйте стрелки для изменения порядка колонок. Колонки «№» и «Адрес» зафиксированы.</p>
                <div id="columnsSettingsList" style="display: flex; flex-direction: column; gap: 8px;"></div>
            </details>

            <div style="display: flex; justify-content: flex-end; margin-top: 10px;">
                <button id="saveSettingsBtn" class="theme-toggle-btn" style="border-radius: 8px; width: auto; padding: 10px 24px; font-size: 14px; background: var(--accent); color: var(--mark-text); font-weight: 600;">Сохранить профиль и настройки</button>
            </div>
        </div>
    </div>`;
}
