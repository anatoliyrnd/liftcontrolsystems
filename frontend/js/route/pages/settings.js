export function settingsPageTemplate() {
  return `
    <div class="container" style="max-width: 800px;">
        <h1 style="margin-bottom: 1.5rem;">Настройки устройства</h1>
        <div class="table-wrapper" style="padding: 2rem; display: flex; flex-direction: column; gap: 25px;">
            
            <!-- Блок Ключа Организации (Скрыт для всех, кроме админа/диспетчера) -->
            <div id="orgKeyBlock" style="border-bottom: 1px solid var(--border-color); padding-bottom: 20px; display: none;">
                <h3 style="margin-bottom: 15px;">🔑 Ключ организации</h3>
                <p style="font-size: 13px; color: var(--text-secondary); margin-bottom: 10px;">Привязывает это устройство к конкретной организации.</p>
                <div style="display: flex; gap: 10px; align-items: center;">
                    <input type="text" id="orgKeyInput" class="search-input" style="flex: 1; max-width: 300px;" placeholder="Введите ключ..." disabled>
                    <button id="editOrgKeyBtn" class="menu-item active" style="padding: 8px 16px; border-radius: 6px; border: none; cursor: pointer; display: none;">Редактировать</button>
                    <button id="saveOrgKeyBtn" class="theme-toggle-btn" style="padding: 8px 16px; border-radius: 6px; font-size: 14px; background: var(--accent); color: var(--mark-text); display: none;">Сохранить ключ</button>
                    <button id="cancelOrgKeyBtn" class="theme-toggle-btn" style="padding: 8px 16px; border-radius: 6px; font-size: 14px; display: none;">Отмена</button>
                </div>
            </div>

            <!-- Блок Локальных настроек (Город и Кэш) -->
            <div style="border-bottom: 1px solid var(--border-color); padding-bottom: 20px;">
                <h3 style="margin-bottom: 15px;">⚙️ Локальные настройки устройства</h3>
                <div style="margin-bottom: 15px;">
                    <label style="display:block; margin-bottom: 5px; font-size: 13px; color: var(--text-secondary);">Город по умолчанию (для формы создания)</label>
                    <div style="display: flex; gap: 10px;">
                        <select id="settingsDefaultCity" class="search-input" style="flex: 1; max-width: 300px;"></select>
                        <button id="saveDefaultCityBtn" class="menu-item active" style="padding: 0 16px; border-radius: 6px; border: none; cursor: pointer;">Сохранить город</button>
                    </div>
                </div>
                <div>
                    <p style="font-size: 13px; color: var(--text-secondary); margin-bottom: 10px;">Если адреса перестали отображаться или вышли новые справочники, очистите кэш.</p>
                    <button id="clearAddressCacheBtn" class="menu-item" style="padding: 8px 16px; border-radius: 6px; border: 1px solid #ef4444; color: #ef4444; background: transparent; cursor: pointer;">Очистить кэш адресов</button>
                </div>
            </div>
        </div>
    </div>`;
}
