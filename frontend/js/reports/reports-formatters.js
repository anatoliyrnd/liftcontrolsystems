import { REPORTS } from "../config.js";
import { formatTs } from "../utils/date-utils.js";

/**
 * Сборка текста-ячеек. Чистые функции: строка заявки → строка
 * с \n. Никакого HTML — рендер идёт через textContent, перенос
 * даёт CSS white-space: pre-line (правило 1: DOM без innerHTML).
 *
 * why не в body-render: он общий с журналами и рисует «одна колонка =
 * одно поле». Править его ради отчёта значило бы менять журналы.
 * Новые id колонок не попадают в его спец-случаи, поэтому собранный
 * текст уходит в ячейку как есть, без двойного форматирования.
 *
 * Дата — formatTs (локальная зона), как в журналах: dispatcher видит
 * те же wall-clock, что и в списке заявок. МСК остаётся у границ
 * периода и CSV.
 */
const DASH = "—";

function line(...parts) {
  return parts.filter((p) => p != null && String(p).trim() !== "").join(" · ");
}
function orDash(v) {
  const s = v == null ? "" : String(v).trim();
  return s === "" ? DASH : s;
}
function ts(v) {
  const n = Number(v);
  return Number.isFinite(n) && n > 0 ? formatTs(n) : DASH;
}

/** № и адрес — двумя строками. */
export function ticketCell(item) {
  const num = item.call_number ?? item.id ?? item.call_id ?? DASH;
  return `№ ${num}\n${orDash(item.fullAddress ?? item.address)}`;
}

/**
 * Кто открыл, когда, описание, срок ремонта.
 * Срок живёт здесь же: отдельной колонки под него в новом наборе нет,
 * а терять его нельзя — по нему считается просрочка.
 */
export function openingCell(item) {
  const head = line(ts(item.date), orDash(item.created_by));
  const details = orDash(item.details);
  const repair =
    Number(item.repair_time) > 0
      ? `Срок: ${formatTs(item.repair_time)}`
      : "Срок: не задан";
  return `${head}\n${details}\n${repair}`;
}

/** Имя, канал, дата уведомления. Пустой слот — прочерк или «Не назначен». */
export function responsibleCell(item, slot) {
  const suffix = slot === 1 ? "" : String(slot);
  const id = Number(item[`staff_id${suffix}`] ?? 0);
  const name = String(item[`staff_name${suffix}`] ?? "").trim();
  if (id <= 0 || name === "") {
    return slot === 1 ? "Не назначен" : DASH;
  }
  const status = Number(item[`notify_status${suffix}`] ?? 0);
  const date = Number(item[`notify_date${suffix}`] ?? 0);
  if (status <= 0) {
    return `${name}\nНе уведомлен`;
  }
  const channel = REPORTS.NOTIFY_SUFFIXES[status] ?? `канал ${status}`;
  return date > 0
    ? `${name}\n${channel}\n${formatTs(date)}`
    : `${name}\n${channel}`;
}

/** Отдел, группа, тип запроса — с подписями: три разные сущности. */
export function classificationCell(item) {
  return [
    `Отдел: ${orDash(item.department)}`,
    `Группа: ${orDash(item.group)}`,
    `Тип: ${orDash(item.request)}`,
  ].join("\n");
}

/** Кто закрыл, когда, решение. Открытая заявка — прочерк. */
export function closureCell(item) {
  if (item.type !== "close") return DASH;
  const head = line(ts(item.close_date), orDash(item.close_name));
  return `${head}\n${orDash(item.solution)}`;
}

/** Строка для body-render:复合-поля плюс исходные для подсветки. */
export function toTableRow(item) {
  return {
    ...item,
    ticket: ticketCell(item),
    opening: openingCell(item),
    resp1: responsibleCell(item, 1),
    resp2: responsibleCell(item, 2),
    resp3: responsibleCell(item, 3),
    classification: classificationCell(item),
    closure: closureCell(item),
  };
}

/** Просрочка — то же определение, что в body-render и в сводке. */
export function isOverdue(item, nowSec) {
  return (
    item.type !== "close" &&
    Number(item.repair_time) > 0 &&
    Number(item.repair_time) < nowSec
  );
}

/** Класс тревоги для первой ячейки — зеркалит логику журналов. */
export function alertClass(item, nowSec) {
  const unassigned = !Number(item.staff_id);
  const unnotified =
    !unassigned && (!Number(item.notify_status) || !Number(item.notify_date));
  if (Number(item.alert_level) === 3 || isOverdue(item, nowSec)) {
    return "cell-alert-danger";
  }
  if (Number(item.alert_level) === 2 || unassigned) return "cell-alert-warning";
  if (unnotified) return "cell-alert-info";
  return "";
}
