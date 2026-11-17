/**
 * Копирование данных заявки в буфер обмена.
 *
 * Вариант C: только поля, которые есть в списке (§17). Слоты 2–3
 * не выводятся — в списках нет staff_id2/3, staff_name2/3,
 * notify_status2/3; дата без имени бессмысленна. Пользователь получает
 * явную пометку о границе данных. Сеть на клик не дёргается: writeText
 * после await теряет пользовательский жест и браузер откажет.
 *
 * Состав зависит от журнала:
 *   open  — описание проблемы, справочники, срок, ответственный;
 *   close — решение, дата закрытия, кто закрыл.
 *
 * Формат — плоский текст с переносами строк: вставляется в блокнот,
 * мессенджер и письмо без разметки.
 */
import { formatTs } from "./date-utils.js";
import { BUSINESS } from "../config.js";
import { isOfflineTicket } from "./ticket-permissions.js";

/** Эмодзи и служебные символы словаря каналов — в плоский текст не берём. */
const EMOJI_RE =
  /[\u{1F000}-\u{1FAFF}\u{2600}-\u{27BF}\u{2B00}-\u{2BFF}\u{FE0F}\u{200D}]/gu;

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

/** «📞 По телефону » → «По телефону»; «— Не уведомлён —» → «Не уведомлён». */
function channelLabel(code) {
  if (code == null || code === "") return null;
  const raw = BUSINESS.NOTIFY_CHANNELS[Number(code)];
  if (!raw) return null;
  const clean = String(raw)
    .replace(EMOJI_RE, "")
    .replace(/—/g, "")
    .replace(/\s+/g, " ")
    .trim();
  return clean || null;
}

/** Строка ответственного: имя + канал + дата уведомления. */
function staffLine(ticket, index) {
  const suffix = index === 1 ? "" : String(index);
  const name = text(ticket["staff_name" + suffix]);
  if (!name) return null;

  const parts = [name];
  const code = ticket["notify_status" + suffix];
  const label = channelLabel(code);
  if (label) parts.push(label);

  const notifiedAt = date(ticket["notify_date" + suffix]);
  if (notifiedAt && Number(code) > 0) {
    parts.push(`уведомлён ${notifiedAt}`);
  }
  return `Ответственный ${index}: ${parts.join(" — ")}`;
}

/**
 * Плоский текст заявки для передачи голосом или в мессенджер.
 * @param {Object} ticket
 * @param {"open"|"close"} scope — журнал-источник, определяет состав полей
 * @returns {string}
 */
export function buildTicketText(ticket, scope = "open") {
  if (!ticket || typeof ticket !== "object") return "";

  const lines = [];
  const offline = isOfflineTicket(ticket);
  // Журнал важнее полей объекта: в открытых копируем описание проблемы,
  // в закрытых — решение. call_status здесь не участвует.
  const closed = scope === "close" || ticket._isOfflineClose === true;

  if (offline) {
    lines.push("Локальная заявка (не отправлена на сервер)");
  } else {
    const id = text(ticket.id ?? ticket.call_number ?? ticket.call_id);
    lines.push(`Заявка №${id || "—"} (${closed ? "закрыта" : "открыта"})`);
  }

  pushLine(lines, "Адрес", ticket.fullAddress || ticket.address);

  if (closed) {
    pushLine(lines, "Решение", ticket.solution);
    pushDate(lines, "Закрыта", ticket.close_date);
    pushLine(lines, "Кто закрыл", ticket.close_name);
    if (ticket._isOfflineClose === true) {
      lines.push("Закрыта локально, ожидает синхронизации.");
    }
    return lines.join("\n");
  }

  pushDate(lines, "Создана", ticket.date);

  const dictParts = [];
  if (text(ticket.department))
    dictParts.push(`Отдел: ${text(ticket.department)}`);
  if (text(ticket.request)) dictParts.push(`Тип: ${text(ticket.request)}`);
  if (text(ticket.group)) dictParts.push(`Группа: ${text(ticket.group)}`);
  if (dictParts.length > 0) lines.push(dictParts.join(" · "));

  const repair = date(ticket.repair_time);
  if (repair) {
    lines.push(`Срок ремонта: ${repair}`);
  } else {
    lines.push(
      offline
        ? "Срок ремонта: будет назначен при синхронизации"
        : "Срок ремонта: не задан",
    );
  }

  pushLine(lines, "Описание проблемы", ticket.details);

  const first = staffLine(ticket, 1);
  lines.push(first || "Ответственный: не назначен");

  if (offline) {
    lines.push("Заявка ожидает синхронизации, номер присвоит сервер.");
  } else {
    // Граница данных списка: слоты 2–3 недоступны (§17 ⚠️).
    lines.push("Данные по слотам 2–3 доступны в карточке заявки.");
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
