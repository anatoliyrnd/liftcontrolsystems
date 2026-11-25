import fs from 'node:fs';
import path from 'node:path';

const FILES = {
  css: './style.css',
  layout: './js/details/views/card-layout.js',
  picker: './js/components/repair-time-picker.js',
};

function fail(msg) {
  console.error(`\n❌ ОШИБКА ПАТЧА: ${msg}`);
  console.error('Ни один файл не был изменён.\n');
  process.exit(1);
}

function replaceExact(content, oldBlock, newBlock, label, file) {
  const isCRLF = content.includes('\r\n');
  const normContent = content.replace(/\r\n/g, '\n');
  const normOld = oldBlock.replace(/\r\n/g, '\n');
  const normNew = newBlock.replace(/\r\n/g, '\n');

  const firstIdx = normContent.indexOf(normOld);
  if (firstIdx === -1) {
    fail(`В файле "${file}" не найден ожидаемый блок [${label}]. Возможно, файл уже был изменён.`);
  }
  if (normContent.indexOf(normOld, firstIdx + 1) !== -1) {
    fail(`В файле "${file}" блок [${label}] найден более одного раза. Замена отменена во избежание дублей.`);
  }

  const updated = normContent.replace(normOld, normNew);
  return isCRLF ? updated.replace(/\n/g, '\r\n') : updated;
}

for (const [key, filePath] of Object.entries(FILES)) {
  if (!fs.existsSync(filePath)) {
    fail(`Файл не найден: ${path.resolve(filePath)} (запускайте скрипт из корня frontend)`);
  }
}

let css = fs.readFileSync(FILES.css, 'utf8');
let layout = fs.readFileSync(FILES.layout, 'utf8');
let picker = fs.readFileSync(FILES.picker, 'utf8');

const OLD_CSS_SEC8 = `/* ==========================================================================
   8. АДАПТИВНАЯ СЕТКА КАРТОЧКИ ИНЦИДЕНТА
   ========================================================================== */

/* Сетка для больших мониторов оператора */
.ticket-card-layout-grid {
    display: grid;
    grid-template-columns: 1fr 1fr;
    gap: 2rem;
    width: 100%;
    height: 100%;
    min-height: 0;
    padding-top: 15px;
}

/* Медиа-запрос: Если экран сужается меньше 920px (мобильные, планшеты, сжатая IDE) */
@media screen and (max-width: 768px) {
    /* Переводим сетку в один вертикальный столбец */
    .ticket-card-layout-grid {
        grid-template-columns: 1fr !important;
        grid-template-rows: auto auto;
        overflow-y: auto !important;
        gap: 1.5rem;
    }

    /* Снимаем жесткое ограничение высоты для контейнера приложения, чтобы прокрутка шла плавно */
    .container {
        height: auto !important;
        overflow-y: auto !important;
    }

    /* Панели карточки подстраиваются под контент, но не сжимаются меньше 300px */
    .ticket-info-panel,
    .ticket-notes-panel {
        overflow-y: visible !important;
        height: auto !important;
        min-height: 600px !important;
    }
}`;

const NEW_CSS_SEC8 = `/* ==========================================================================
   8. АДАПТИВНАЯ СЕТКА КАРТОЧКИ ИНЦИДЕНТА
   Колонки заданы ТОЛЬКО здесь. Нижний дублирующий блок удалён.
   ========================================================================== */
.ticket-card-layout-grid {
    display: grid;
    grid-template-columns: minmax(0, 1fr) minmax(0, 1fr);
    gap: 2rem;
    align-items: stretch;
    width: 100%;
    height: 100%;
    min-height: 0;
    padding-top: 15px;
}

/* Планшет/десктоп: 50/50 + фиксация высоты панелей.
   !important сохранён — гасит возможные inline-стили шаблона. */
@media screen and (min-width: 769px) {
    .ticket-card-layout-grid {
        display: grid !important;
        grid-template-columns: minmax(0, 1fr) minmax(0, 1fr) !important;
        gap: 2rem !important;
        align-items: stretch !important;
    }
    .ticket-info-panel,
    .ticket-notes-panel {
        height: 100% !important;
        min-height: 0 !important;
        max-height: 100% !important;
        min-width: 0;
    }
}

/* Большие мониторы: 70/30. Блок ПОСЛЕ 769-правила — поздний побеждает. */
@media screen and (min-width: 1200px) {
    .ticket-card-layout-grid {
        grid-template-columns: minmax(0, 7fr) minmax(0, 3fr) !important;
    }
}

/* Мобильные: один столбец */
@media screen and (max-width: 768px) {
    .ticket-card-layout-grid {
        grid-template-columns: minmax(0, 1fr) !important;
        grid-template-rows: auto auto;
        overflow-y: auto !important;
        gap: 1.5rem;
    }
    .container {
        height: auto !important;
        overflow-y: auto !important;
    }
    .ticket-info-panel,
    .ticket-notes-panel {
        overflow-y: visible !important;
        height: auto !important;
        min-height: 600px !important;
        min-width: 0;
    }
}

/* ==========================================================================
   МЕТА-СЕТКА КАРТОЧКИ (даты и классификация)
   Отступ между двумя сетками даёт родительский flex-gap ticketBodyBlock —
   собственный margin не нужен (info-group его не имеет).
   ========================================================================== */
.ticket-meta-grid {
    display: grid;
    grid-template-columns: repeat(auto-fit, minmax(195px, 1fr));
    gap: 1rem;
    align-items: start;
}

.ticket-meta-grid .info-group {
    min-width: 0;
}

/* Корневые контейнеры виджетов редактирования — на всю колонку */
#repairTimeEditBlock,
#deptEditBlock,
#reqEditBlock,
#groupEditBlock {
    width: 100%;
    max-width: 100%;
    min-width: 0;
}

/* dict-select — нативный select с inline width:100%;
   date/time инпуты пикера переносятся его собственным flex-wrap */
.ticket-meta-grid input,
.ticket-meta-grid select {
    max-width: 100%;
    min-width: 0;
    box-sizing: border-box;
}

/* ==========================================================================
   КОММЕНТАРИИ В УЗКОЙ КОЛОНКЕ — id подтверждены grep'ом.
   Скоуп .ticket-notes-panel: mobile-версия (notesContainerDOM без панели)
   не затрагивается.
   ========================================================================== */
.ticket-notes-panel #notesContainerDOM > div > div:first-child {
    flex-wrap: wrap;
    gap: 2px 8px;
}

.ticket-notes-panel #noteComposer > button:last-child {
    width: 100%;
    align-self: stretch !important;
}`;

const OLD_CSS_DUP = `/* ==========================================================================
   ЖЕСТКАЯ ФИКСАЦИЯ ДВУХ КОЛОНОК ДЛЯ ДЕСКТОПА
   ========================================================================== */
@media screen and (min-width: 769px) {
    .ticket-card-layout-grid {
        display: grid !important;
        grid-template-columns: 1fr 1fr !important;
        gap: 2rem !important;
        align-items: stretch !important;
    }
    
    .ticket-info-panel, 
    .ticket-notes-panel {
        height: 100% !important;
        min-height: 0 !important;
        max-height: 100% !important;
    }
}`;

css = replaceExact(css, OLD_CSS_SEC8, NEW_CSS_SEC8, 'Секция 8. АДАПТИВНАЯ СЕТКА КАРТОЧКИ', FILES.css);
css = replaceExact(css, OLD_CSS_DUP, '', 'Нижний дубль ЖЕСТКАЯ ФИКСАЦИЯ ДВУХ КОЛОНОК', FILES.css);
const OLD_LAYOUT_META = `        <div style="display: grid; grid-template-columns: 1fr 1fr; gap: 1rem;">
          <div class="info-group">
            <label style="\${LABEL}">📅 Дата регистрации</label>
            <div style="font-size: 14px; margin-top: 2px;">\${formatTs(t.date)}</div>
            <div style="font-size: 12px; color: var(--text-secondary); margin-top: 4px;">👤 \${escapeHtml(t.creator_name || t.offline_author_name || "Неизвестно")}</div>
          </div>
          <div class="info-group">
            <label style="\${LABEL}">🛠 Дата ремонта</label>
            <div id="repairTimeDisplay" style="font-size: 14px; margin-top: 2px;\${isOffline ? " color: #d97706; font-weight: 600;" : ""}">\${escapeHtml(repairText)}</div>
            <div id="repairTimeEditBlock" style="display: none; margin-top: 6px;"></div>
          </div>
        </div>

        <div style="display: flex; flex-direction: column; gap: 1rem;">
          <div class="info-group">
            <label style="\${LABEL}">🏢 Отдел</label>
            <div id="deptDisplay" style="font-size: 14px; margin-top: 2px;">\${escapeHtml(t.department || "—")}</div>
            <div id="deptEditBlock" style="display: none; margin-top: 6px;"></div>
          </div>
          <div class="info-group">
            <label style="\${LABEL}">📋 Тип запроса</label>
            <div id="reqDisplay" style="font-size: 14px; margin-top: 2px;">\${escapeHtml(t.request || "—")}</div>
            <div id="reqEditBlock" style="display: none; margin-top: 6px;"></div>
          </div>
          <div class="info-group">
            <label style="\${LABEL}">📦 Группа</label>
            <div id="groupDisplay" style="font-size: 14px; margin-top: 2px;">\${escapeHtml(t.group || "—")}</div>
            <div id="groupEditBlock" style="display: none; margin-top: 6px;"></div>
          </div>
        </div>`;

const NEW_LAYOUT_META = `        <!-- Блок дат -->
        <div class="ticket-meta-grid">
          <div class="info-group">
            <label style="\${LABEL}">📅 Дата регистрации</label>
            <div style="font-size: 14px; margin-top: 2px;">\${formatTs(t.date)}</div>
            <div style="font-size: 12px; color: var(--text-secondary); margin-top: 4px;">👤 \${escapeHtml(t.creator_name || t.offline_author_name || "Неизвестно")}</div>
          </div>
          <div class="info-group">
            <label style="\${LABEL}">🛠 Дата ремонта</label>
            <div id="repairTimeDisplay" style="font-size: 14px; margin-top: 2px;\${isOffline ? " color: #d97706; font-weight: 600;" : ""}">\${escapeHtml(repairText)}</div>
            <div id="repairTimeEditBlock" style="display: none; margin-top: 6px;"></div>
          </div>
        </div>

        <!-- Блок классификации -->
        <div class="ticket-meta-grid">
          <div class="info-group">
            <label style="\${LABEL}">🏢 Отдел</label>
            <div id="deptDisplay" style="font-size: 14px; margin-top: 2px;">\${escapeHtml(t.department || "—")}</div>
            <div id="deptEditBlock" style="display: none; margin-top: 6px;"></div>
          </div>
          <div class="info-group">
            <label style="\${LABEL}">📋 Тип запроса</label>
            <div id="reqDisplay" style="font-size: 14px; margin-top: 2px;">\${escapeHtml(t.request || "—")}</div>
            <div id="reqEditBlock" style="display: none; margin-top: 6px;"></div>
          </div>
          <div class="info-group">
            <label style="\${LABEL}">📦 Группа</label>
            <div id="groupDisplay" style="font-size: 14px; margin-top: 2px;">\${escapeHtml(t.group || "—")}</div>
            <div id="groupEditBlock" style="display: none; margin-top: 6px;"></div>
          </div>
        </div>`;

layout = replaceExact(layout, OLD_LAYOUT_META, NEW_LAYOUT_META, 'Блоки дат и классификации', FILES.layout);

const pickerRegex = /const\s+wrap\s*=\s*document\.createElement\('div'\);[\s\S]*?customWrap\.appendChild\(timeInput\);/;
const NEW_PICKER_PART = `const wrap = document.createElement('div');
    wrap.style.cssText = 'display: flex; flex-direction: column; gap: 6px; min-width: 0; max-width: 100%;';

    const display = document.createElement('div');
    display.className = 'editable-field';
    display.style.cssText = 'font-size: 13px; padding: 6px 10px; border-radius: 6px; border: 1px solid var(--border-color); background: var(--bg-primary); min-height: 32px; display: flex; align-items: center; font-weight: 600; min-width: 0;';
    display.textContent = formatTs(currentValue);

    const select = document.createElement('select');
    select.className = 'search-input editable-field';
    select.style.cssText = 'font-size: 13px; padding: 6px 8px; cursor: pointer; max-width: 100%;';

    [
        { value: '',         text: '— выбрать срок —' },
        { value: '30min',    text: '30 минут' },
        { value: '1hour',    text: '1 час' },
        { value: 'endday',   text: 'До 17:00' },
        { value: 'custom',   text: 'Другая дата...' }
    ].forEach(o => {
        const opt = document.createElement('option');
        opt.value = o.value;
        opt.textContent = o.text;
        select.appendChild(opt);
    });

    // ИСПРАВЛЕНО: flex-wrap + flex-basis вместо жёстких ширины/процентов.
    // Колонка >= ~236px — date и time в ряд; уже — time на вторую строку.
    const customWrap = document.createElement('div');
    customWrap.style.cssText = 'display: none; gap: 6px; align-items: center; flex-wrap: wrap; min-width: 0;';

    const dateInput = document.createElement('input');
    dateInput.type = 'date';
    dateInput.className = 'search-input editable-field';
    dateInput.style.cssText = 'font-size: 13px; padding: 6px 8px; flex: 1 1 110px; min-width: 0; width: auto;';
    dateInput.min = formatDateInput(new Date(getMinAllowedTs() * 1000));

    const timeInput = document.createElement('input');
    timeInput.type = 'time';
    timeInput.className = 'search-input editable-field';
    timeInput.style.cssText = 'font-size: 13px; padding: 6px 8px; flex: 0 1 120px; min-width: 0; width: auto;';
    timeInput.step = 1800;

    const initialMin = new Date(getMinAllowedTs() * 1000);
    dateInput.value = formatDateInput(initialMin);
    timeInput.value = formatTimeInput(initialMin);

    customWrap.appendChild(dateInput);
    customWrap.appendChild(timeInput);`;

if (!pickerRegex.test(picker)) {
  fail(`В файле "${FILES.picker}" не найдена структура wrap -> customWrap -> timeInput.`);
}
picker = picker.replace(pickerRegex, NEW_PICKER_PART);

fs.writeFileSync(FILES.css, css, 'utf8');
fs.writeFileSync(FILES.layout, layout, 'utf8');
fs.writeFileSync(FILES.picker, picker, 'utf8');

console.log('✅ Все 3 файла успешно обновлены!\n');

const metaCount = (layout.match(/ticket-meta-grid/g) || []).length;
const hasDup = css.includes('ЖЕСТКАЯ ФИКСАЦИЯ ДВУХ КОЛОНОК');
const hasFlexWrap = picker.includes('flex-wrap: wrap');
const requiredIds = ['deptEditBlock', 'reqEditBlock', 'groupEditBlock', 'repairTimeEditBlock'];
const idsOk = requiredIds.every(id => (layout.match(new RegExp(`id="${id}"`, 'g')) || []).length === 1);

console.log('--- Автопроверка ---');
console.log(`• Дубль "ЖЕСТКАЯ ФИКСАЦИЯ" в style.css удалён: ${!hasDup ? 'OK' : 'ОШИБКА'}`);
console.log(`• Обёрток ticket-meta-grid в card-layout.js: ${metaCount} (ожидалось 2)`);
console.log(`• Все 4 ID слотов редактирования уникальны: ${idsOk ? 'OK' : 'ОШИБКА'}`);
console.log(`• flex-wrap в repair-time-picker.js добавлен: ${hasFlexWrap ? 'OK' : 'ОШИБКА'}`);

console.log('\n--- Готовые команды для Git ---');
console.log('Вариант А (одним общим коммитом):');
console.log('git add style.css js/details/views/card-layout.js js/components/repair-time-picker.js && git commit -m "feat(ticket-card): 70/30 desktop grid, responsive meta-grid and flexible date/time picker"');

console.log('\nВариант Б (тремя атомарными коммитами):');
console.log('1) git add style.css && git commit -m "style(ticket-card): add 70/30 desktop layout at >=1200px, .ticket-meta-grid and narrow notes panel rules"');
console.log('2) git add js/details/views/card-layout.js && git commit -m "refactor(ticket-card): wrap dates and classification fields into .ticket-meta-grid"');
console.log('3) git add js/components/repair-time-picker.js && git commit -m "fix(repair-picker): allow date and time inputs to wrap in narrow columns"');
