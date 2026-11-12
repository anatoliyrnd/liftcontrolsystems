export function queuePageTemplate() {
    return `
        <div class="container">
            <div style="display:flex;justify-content:space-between;align-items:center;margin-bottom:1rem;gap:12px;flex-wrap:wrap;">
                <h1 style="margin:0;">Очередь синхронизации</h1>
                <div style="display:flex;gap:8px;">
                    <button id="queueSyncBtn" class="theme-toggle-btn"
                            style="border-radius:8px;width:auto;padding:0 16px;font-size:13px;"
                            title="Запустить синхронизацию">Синхронизировать</button>
                    <button id="queueBackBtn" class="theme-toggle-btn"
                            style="border-radius:8px;width:auto;padding:0 16px;font-size:13px;">← Назад</button>
                </div>
            </div>
            <div id="queueSummary" style="font-size:13px;color:var(--text-secondary);margin-bottom:10px;"></div>
            <div class="table-wrapper" style="max-height:calc(100vh - 220px);">
                <table id="queueTable">
                    <thead>
                        <tr>
                            <th style="width:50px;">#</th>
                            <th style="width:120px;">Тип</th>
                            <th style="width:150px;">Автор</th>
                            <th style="width:140px;">Объект</th>
                            <th>Фрагмент</th>
                            <th style="width:120px;">Статус</th>
                            <th style="width:170px;">Создано</th>
                            <th style="width:180px;"></th>
                        </tr>
                    </thead>
                    <tbody></tbody>
                </table>
                <div id="queueEmpty" style="display:none;text-align:center;padding:2rem;color:var(--text-secondary);font-size:14px;">
                    Очередь пуста — все действия синхронизированы.
                </div>
            </div>
        </div>
    `;
}