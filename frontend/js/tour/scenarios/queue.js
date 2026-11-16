import { SEL } from "../selectors.js";

/**
 * Очередь синхронизации. Демо-строка существует только в DOM на время
 * тура: в outbox не пишется, на сервер не уходит, кнопки неактивны.
 */
export function queueSteps() {
    return [
        {
            element: SEL.demoRow,
            popover: {
                title: "Очередь синхронизации",
                description:
                    "Здесь собраны действия, выполненные без связи с сервером. Строка с пометкой «Демо» — учебная, она исчезнет после завершения обучения. Реальные записи показывают тип действия, автора, объект и время создания.",
            },
        },
        {
            element: SEL.demoConfirm,
            popover: {
                title: "Создать дубликат",
                description:
                    "Появляется, когда сервер ответил: на этот объект уже есть активная заявка того же отдела. Кнопка открывает список существующих заявок — вы решаете, создавать ли вторую. Без подтверждения дубликат не создастся.",
            },
        },
        {
            element: SEL.demoDelete,
            popover: {
                title: "Удалить задание",
                description:
                    "Убирает запись из очереди. Внимание: офлайн-данные будут удалены окончательно и на сервер не попадут. Используйте, только если действие создано ошибочно.",
            },
        },
    ];
}

let observer = null;

export function insertDemoRow() {
    const tbody = document.querySelector(SEL.queueTable + " tbody");
    if (!tbody || document.querySelector(SEL.demoRow)) return;

    const tr = document.createElement("tr");
    tr.setAttribute("data-demo-row", "true");

    const cells = [
        "⚠ Демо",
        "Создание",
        "—",
        "г. Ростов-на-Дону, пр. Буденновский, д.1, п.1 г/п",
        "Дубликат требует подтверждения",
        "Дубликат (3)",
        "—",
    ];
    for (const text of cells) {
        const td = document.createElement("td");
        td.textContent = text;
        tr.appendChild(td);
    }

    const actionsTd = document.createElement("td");
    actionsTd.style.cssText =
        "white-space:nowrap;overflow:visible;text-overflow:clip;max-width:none;";

    const wrap = document.createElement("div");
    wrap.style.cssText = "display:flex;align-items:center;gap:6px;";

    const confirmBtn = document.createElement("button");
    confirmBtn.type = "button";
    confirmBtn.className = "queue-action-btn";
    confirmBtn.dataset.action = "confirm";
    confirmBtn.disabled = true;
    confirmBtn.textContent = "Создать дубликат";
    confirmBtn.style.cssText =
        "flex:0 0 auto;white-space:nowrap;padding:2px 8px;border-radius:4px;" +
        "background:transparent;border:1px solid #f97316;color:#f97316;";

    const deleteBtn = document.createElement("button");
    deleteBtn.type = "button";
    deleteBtn.className = "queue-delete-btn";
    deleteBtn.dataset.action = "delete";
    deleteBtn.disabled = true;
    deleteBtn.textContent = "×";
    deleteBtn.title = "Удалить из очереди";
    deleteBtn.setAttribute("aria-label", "Удалить из очереди");
    deleteBtn.style.cssText =
        "flex:0 0 auto;padding:2px 8px;border-radius:4px;background:transparent;" +
        "border:1px solid #ef4444;color:#ef4444;";

    wrap.appendChild(confirmBtn);
    wrap.appendChild(deleteBtn);
    actionsTd.appendChild(wrap);
    tr.appendChild(actionsTd);

    tbody.insertBefore(tr, tbody.firstChild);
    const empty = document.querySelector(SEL.queueEmpty);
    if (empty) empty.style.display = "none";
}

/** Контроллер очереди перерисовывает tbody — возвращаем демо-строку. */
export function watchDemoRow() {
    const tbody = document.querySelector(SEL.queueTable + " tbody");
    if (!tbody || observer) return;
    observer = new MutationObserver(() => {
        if (!document.querySelector(SEL.demoRow)) insertDemoRow();
    });
    observer.observe(tbody, { childList: true });
}

export function removeDemoRow() {
    if (observer) {
        observer.disconnect();
        observer = null;
    }
    const row = document.querySelector(SEL.demoRow);
    if (row) row.remove();
    const tbody = document.querySelector(SEL.queueTable + " tbody");
    const empty = document.querySelector(SEL.queueEmpty);
    if (empty && tbody && tbody.children.length === 0) empty.style.display = "";
}