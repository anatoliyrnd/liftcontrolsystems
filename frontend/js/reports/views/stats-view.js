/**
 * Сводка отчёта. Чистый рендер: числа и подписи приходят с сервера,
 * DOM собирается createElement + textContent.
 *
 * NULL-корзины («Без отдела», «Без адреса»…) сервер отдаёт готовыми
 * подписями с id:null — здесь они ничем не отличаются от обычных
 * строк. Молча потерять их значило бы показать диспетчеру меньшее
 * число заявок, чем он видит в таблице.
 */
function el(tag, attrs = {}, text = null) {
    const node = document.createElement(tag);
    for (const [k, v] of Object.entries(attrs)) {
        if (k === "class") node.className = v;
        else if (k === "style") node.style.cssText = v;
    }
    if (text != null) node.textContent = text;
    return node;
}

function fmtDuration(sec) {
    if (sec == null || !Number.isFinite(Number(sec))) return "—";
    const total = Math.round(Number(sec));
    const h = Math.floor(total / 3600);
    const m = Math.floor((total % 3600) / 60);
    return h > 0 ? `${h} ч ${m} мин` : `${m} мин`;
}

function card(title, value) {
    const box = el("div", {
        class: "rep-card",
        style:
            "background:var(--bg-secondary);border:2px solid var(--border-color);border-radius:10px;padding:10px 14px;min-width:130px;",
    });
    box.appendChild(el("div", {
        style: "font-size:11px;font-weight:700;color:var(--text-secondary);text-transform:uppercase;",
    }, title));
    box.appendChild(el("div", {
        style: "font-size:20px;font-weight:700;color:var(--text-primary);",
    }, String(value)));
    return box;
}

function groupBlock(title, rows) {
    if (!Array.isArray(rows) || rows.length === 0) return null;
    const box = el("div", { class: "rep-group", style: "min-width:200px;" });
    box.appendChild(el("div", {
        style: "font-size:11px;font-weight:700;color:var(--text-secondary);text-transform:uppercase;margin-bottom:4px;",
    }, title));
    for (const row of rows) {
        const line = el("div", {
            style: "display:flex;justify-content:space-between;gap:10px;font-size:12px;color:var(--text-primary);",
        });
        line.appendChild(el("span", {
            style: "overflow:hidden;text-overflow:ellipsis;white-space:nowrap;",
        }, String(row.name ?? "—")));
        line.appendChild(el("span", { style: "font-weight:600;" }, String(row.count ?? 0)));
        box.appendChild(line);
    }
    return box;
}

export function renderStats(host, stats) {
    host.innerHTML = "";
    if (!stats) {
        host.appendChild(el("div", {
            class: "rep-stats-empty",
            style: "font-size:13px;color:var(--text-secondary);margin:8px 0;",
        }, "Нет данных за выбранный период."));
        return;
    }
    const cards = el("div", {
        style: "display:flex;gap:10px;flex-wrap:wrap;margin:10px 0;",
    });
    cards.appendChild(card("Всего", stats.total ?? 0));
    cards.appendChild(card("Открыто", stats.open ?? 0));
    cards.appendChild(card("Закрыто", stats.closed ?? 0));
    cards.appendChild(card("Среднее время закрытия", fmtDuration(stats.avg_close_time_seconds)));
    const repair = stats.avg_repair_time || {};
    cards.appendChild(card(
        "Срок ремонта (сервер/диспетчер)",
        `${repair.default ?? 0} / ${repair.custom ?? 0}`,
    ));
    host.appendChild(cards);

    const grid = el("div", {
        class: "rep-stats-grid",
        style: "display:flex;gap:16px;flex-wrap:wrap;margin-bottom:10px;",
    });
    const blocks = [
        ["По отделам", stats.by_department],
        ["По городам", stats.by_city],
        ["По группам", stats.by_group],
        ["По типам запроса", stats.by_request],
    ];
    for (const [title, rows] of blocks) {
        const b = groupBlock(title, rows);
        if (b) grid.appendChild(b);
    }
    const levels = Array.isArray(stats.by_alert_level)
        ? stats.by_alert_level.map((r) => ({ name: `Уровень ${r.level}`, count: r.count }))
        : [];
    const lb = groupBlock("По уровням тревоги", levels);
    if (lb) grid.appendChild(lb);
    if (grid.childElementCount > 0) host.appendChild(grid);
}
