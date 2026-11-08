export function mainPageTemplate() {
  return `
    <div class="container">
                <div class="search-container" style="display: flex; gap: 10px; align-items: center; margin-bottom: 1rem; max-width: 100%; flex-wrap: wrap;">
            <input type="text" id="searchInput" class="search-input" placeholder="Поиск по видимым колонкам..." style="flex: 1; min-width: 200px;">
            
            <!-- Фильтры для открытых заявок -->
            <div id="openOnlyFilters" style="display: flex; gap: 10px; align-items: center; flex-wrap: wrap;">
                
                <!-- Дропдаун городов -->
                <div class="city-filter-wrapper" style="position: relative;">
                    <button id="cityFilterBtn" class="search-input" style="display: flex; align-items: center; gap: 8px; cursor: pointer; padding: 0.75rem 1rem; background: var(--bg-secondary); border: 2px solid var(--border-color); border-radius: 8px;">
                        <span id="cityFilterText">Города: Все</span>
                        <svg viewBox="0 0 24 24" width="16" height="16" fill="currentColor"><path d="M7 10l5 5 5-5z"/></svg>
                    </button>
                    <div id="cityFilterDropdown" class="user-dropdown" style="display: none; width: 250px; padding: 10px 0; max-height: 300px; overflow-y: auto;">
                        <div style="padding: 0 12px 8px 12px; border-bottom: 1px solid var(--border-color); margin-bottom: 5px;">
                            <label style="display: flex; align-items: center; gap: 8px; cursor: pointer; font-size: 13px; font-weight: 600;">
                                <input type="checkbox" id="citySelectAll"> Выбрать / Снять все
                            </label>
                        </div>
                        <div id="cityCheckboxList" style="display: flex; flex-direction: column; gap: 5px; padding: 0 12px;"></div>
                    </div>
                </div>

                <!-- Чекбокс долгосрочных заявок -->
                <label style="display: flex; align-items: center; gap: 8px; font-size: 13px; color: var(--text-secondary); cursor: pointer; background: var(--bg-secondary); padding: 0.75rem 1rem; border: 2px solid var(--border-color); border-radius: 8px;">
                    <input type="checkbox" id="hideLongRepair">
                    <span id="hideLongRepairLabel"></span>
                </label>
            </div>

            <!-- Контейнер для селектора периода (только для закрытых) -->
            <div id="periodSelectorContainer" style="display: flex; align-items: center;"></div>

            <!-- Кнопка обновления / синхронизации -->
            <div style="position: relative; display: flex;">
                <button id="refreshBtn" class="theme-toggle-btn" title="Перезагрузить данные" style="position: relative;">
                    <svg viewBox="0 0 24 24" style="width: 20px; height: 24px; fill: currentColor;">
                        <path d="M17.65 6.35C16.2 4.9 14.21 4 12 4c-4.42 0-7.99 3.58-7.99 8s3.57 8 7.99 8c3.73 0 6.84-2.55 7.73-6h-2.08c-.82 2.33-3.07 4-5.65 4-3.31 0-6-2.69-6-6s2.69-6 6-6c1.66 0 3.14.69 4.22 1.78L13 11h7V4l-2.35 2.35z"/>
                    </svg>
                </button>
                <span id="syncBadge" style="display: none; position: absolute; top: -5px; right: -8px; background: #ef4444; color: white; border-radius: 50%; padding: 2px 6px; font-size: 10px; font-weight: 700; border: 2px solid var(--bg-primary); box-shadow: 0 2px 4px rgba(0,0,0,0.2);">0</span>
            </div>
        </div>

        <div class="table-wrapper">
            <table id="dataTable">
                <thead>
                    <tr></tr>
                </thead>
                <tbody></tbody>
            </table>
            <div id="noResults">Ничего не найдено по вашему запросу</div>
        </div>
    </div>`;
}
