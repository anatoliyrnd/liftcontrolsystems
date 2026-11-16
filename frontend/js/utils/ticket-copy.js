/**
 * Копирование данных заявки в буфер обмена.
 *
 * Вариант C: только поля, которые есть в списке (§17). Слоты 2–3
 * не выводятся — в списках нет staff_id2/3, staff_name2/3,
 * notify_status2/3; дата без имени бессмысленна. Пользователь получает
 * явную пометку о границе данных. Сеть на клик не дёргается: writeText
 * после await теряет пользовательский жест и браузер откажет.
 *
 * Формат — плоский текст с переносами строк: вставляется в блокнот,
 * мессенджер и письмо без разметки.
 */
import { formatTs } from "./date-utils.js";
import { isOfflineTicket, isClosedTicket } from "./ticket-permissions.js";

/** Каналы уведомления, API_PROTOCOL §1.3. */
const NOTIFY_CHANNELS = {
    0: "не уведомлён",
    1: "по телефону",
    2: "онлайн",
    3: "в телеграм",
    4: "в макс",
    5: "в вк",
    6: "по смс",
    7: "по email",
};

function text(value) {
    if (value == null) return "";
    const s = String(value).trim();
    return s === "" || s === "—" ? "" : s;
}

function date(value) {
    const n = Number(value);
    if (!Number.isFinite(n) || n <= 0) return "";
    // Миллисекунды outbox приводим к секундам (правило 5 архитектуры).
    const sec = n > 9999999999 ? Math.floor(n / 1000) : n;
    return formatTs(sec).replace("@", " ");
}

function pushLine(lines, label, value) {
    const v = text(value);
    if (v) lines.push(`${label}: ${v}`);
}

function pushDate(lines, label, value) {
    const v = date(value);
    if (v) lines.push(`${label}: ${v}`);
}

/** Строка ответственного: имя + канал + дата уведомления. */
function staffLine(ticket, index) {
    const suffix = index === 1 ? "" : String(index);
    const name = text(ticket["staff_name" + suffix]);
    if (!name) return null;

    const parts = [name];
    const statusCode = ticket["notify_status" + suffix];
    const channel =
        statusCode == null || statusCode === ""
            ? null
            : NOTIFY_CHANNELS[Number(statusCode)] || null;
    if (channel) parts.push(channel);

    const notifiedAt = date(ticket["notify_date" + suffix]);
    if (notifiedAt && Number(statusCode) > 0) {
        parts.push(`уведомлён ${notifiedAt}`);
    }
    return `Ответственный ${index}: ${parts.join(" — ")}`;
}

/**
 * Плоский текст заявки для передачи голосом или в мессенджер.
 * @param {Object} ticket
 * @param {"open"|"close"} scope
 * @returns {string}
 */
export function buildTicketText(ticket, scope = "open") {
    if (!ticket || typeof ticket !== "object") return "";

    const lines = [];
    const offline = isOfflineTicket(ticket);
    const closed = scope === "close" || isClosedTicket(ticket);

    // Заголовок: номер или отметка о локальной заявке.
    if (offline) {
        lines.push("Локальная заявка (не отправлена на сервер)");
    } else {
        const id = text(ticket.id ?? ticket.call_number ?? ticket.call_id);
        lines.push(`Заявка №${id || "—"} (${closed ? "закрыта" : "открыта"})`);
    }

    pushLine(lines, "Адрес", ticket.fullAddress || ticket.address);

    if (closed) {
        // Закрытая: только решение, дата закрытия и кто закрыл.
        pushLine(lines, "Решение", ticket.solution);
        pushDate(lines, "Закрыта", ticket.close_date);
        pushLine(lines, "Кто закрыл", ticket.close_name);
        if (offline || ticket._isOfflineClose === true) {
            lines.push("Закрыта локально, ожидает синхронизации.");
        }
        return lines.join("\n");
    }

    pushDate(lines, "Создана", ticket.date);

    const dicts = [
        text(ticket.department),
        text(ticket.request),
        text(ticket.group),
    ].filter(Boolean);
    if (dicts.length > 0) {
        lines.push(
            [
                text(ticket.department) && `Отдел: ${text(ticket.department)}`,
                text(ticket.request) && `Тип: ${text(ticket.request)}`,
                text(ticket.group) && `Группа: ${text(ticket.group)}`,
            ]
                .filter(Boolean)
                .join(" · "),
        );
    }

    pushDate(lines, "Срок ремонта", ticket.repair_time);
    if (!offline && !ticket.repair_time) {
        lines.push("Срок ремонта: будет назначен при синхронизации");
    }

    pushLine(lines, "Описание", ticket.details);

    const first = staffLine(ticket, 1);
    if (first) lines.push(first);
    else lines.push("Ответственный: не назначен");

    // Граница данных списка: слоты 2–3 недоступны (§17 ⚠️).
    if (!offline) {
        lines.push("Данные по слотам 2–3 доступны в карточке заявки.");
    }

    if (offline) {
        lines.push("Заявка ожидает синхронизации, номер присвоит сервер.");
    }

    return lines.join("\n");
}

/**
 * Запись в буфер обмена. Вызывать строго из обработчика пользовательского
 * жеста: после await жест теряется и браузер откажет.
 * @returns {Promise<{ok:boolean, error?:string}>}
 */
export async function copyToClipboard(value) {
    const payload = String(value ?? "");
    if (!payload) return { ok: false, error: "Нечего копировать" };

    if (navigator.clipboard?.writeText && window.isSecureContext) {
        try {
            await navigator.clipboard.writeText(payload);
            return { ok: true };
        } catch (e) {
            // Safari может отказать даже при жесте — пробуем второй путь.
            console.warn("[ticket-copy] clipboard API отказал:", e);
        }
    }

    return legacyCopy(payload);
}

/** Фолбэк для небезопасного контекста и отказа Clipboard API. */
function legacyCopy(payload) {
    let area = null;
    try {
        area = document.createElement("textarea");
        area.value = payload;
        area.setAttribute("readonly", "");
        area.style.cssText =
            "position:fixed;top:0;left:-9999px;opacity:0;pointer-events:none;";
        document.body.appendChild(area);
        area.select();
        area.setSelectionRange(0, payload.length);
        const ok = document.execCommand("copy");
        return ok
            ? { ok: true }
            : { ok: false, error: "Браузер запретил копирование" };
    } catch (e) {
        return { ok: false, error: e?.message || "Сбой копирования" };
    } finally {
        if (area) area.remove();
    }
}