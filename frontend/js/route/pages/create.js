/**
 * Шаблон Б: Страница создания новой заявки (#/create)
 */
export function createPageTemplate() {
  return `
    <div class="container" style="max-width: 600px;">
        <h1 style="margin-bottom: 1.5rem;">Регистрация новой неисправности</h1>
<div class="table-wrapper create-form-wrapper" style="padding: 2rem; display: flex; flex-direction: column; gap: 15px;">
            <div>
    <!-- Компонент AddressPicker сам отрисует свои label'ы и инпуты -->
    <div id="formAddressSlot"></div>
    <div id="formAddressHint" style="display: none; font-size: 12px; color: var(--accent); margin-top: 4px; font-style: italic;"></div>
</div>
            <div>
    <label style="display:block; margin-bottom: 5px; font-size: 13px; color: var(--text-secondary);">Описание проблемы *</label>
    <div id="formDetailsRow" style="display: flex; gap: 8px; align-items: flex-start;">
        <textarea id="formDetails" class="search-input" style="height: 100px; resize: none; flex: 1;" placeholder="Нет связи, кабина стоит..."></textarea>
    </div>
    <div id="capsWarnFormDetails" style="display: none; color: #ef4444; font-size: 12px; margin-top: 4px;">⚠️ Слишком много заглавных букв подряд (максимум 4)</div>
</div>
                                  <div>
                <label style="display:block; margin-bottom: 5px; font-size: 13px; color: var(--text-secondary);">Назначить ответственного</label>
                <div id="formStaffSlot"></div>
            </div>
                                  <div style="display: flex; flex-direction: column; gap: 12px;">
                                  <div>
                    <label style="display:block; margin-bottom: 5px; font-size: 13px; color: var(--text-secondary);">Группа *</label>
                    <div id="createGroupSlot"></div>
                </div>
                <div>
                    <label style="display:block; margin-bottom: 5px; font-size: 13px; color: var(--text-secondary);">Отдел *</label>
                    <div id="createDeptSlot"></div>
                </div>
                <div>
                    <label style="display:block; margin-bottom: 5px; font-size: 13px; color: var(--text-secondary);">Тип запроса *</label>
                    <div id="createReqSlot"></div>
                </div>
                
            </div>
                        <div>
                <label style="display:block; margin-bottom: 5px; font-size: 13px; color: var(--text-secondary);">Предполагаемое окончание ремонта</label>
                <div id="repairTimeSlot"></div>
            </div>
            <div style="display: flex; gap: 10px; margin-top: 10px;">
                <button id="saveTicketBtn" class="theme-toggle-btn" style="border-radius: 8px; width: auto; padding: 0 20px; font-size: 14px; background: var(--accent); color: var(--mark-text); font-weight: 600;">Сохранить заявку</button>
                <button id="cancelFormBtn" class="theme-toggle-btn" style="border-radius: 8px; width: auto; padding: 0 20px; font-size: 14px;">Отмена</button>
            </div>
        </div>
    </div>`;
}
