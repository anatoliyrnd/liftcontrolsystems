/**
 * Сборка одной команды для syncCommands (API_syncCommands.md v5.4).
 *
 * Поштучная отправка (§1): пачки, вес, лимит 20 удалены.
 * Сборщик — последний гейт перед сетью: гарантирует обязательные поля,
 * чтобы команда не ушла заведомо обречённой.
 *
 * Критично: отсутствие opened_at даёт ошибку ВЕРХНЕГО уровня
 * (§4.1.2, §10.2) — команда остаётся pending и, будучи старейшей,
 * блокирует голову FIFO навсегда.
 *
 * Функции чистые: запись outbox не мутируется, повторная попытка
 * собирает команду заново из оригинала — маркер не накапливается.
 */

const MARKER_PREFIX = "[Синхронизировано:";

const MARKER_FIELD = {
  EditTicket: "details",
  CloseTicket: "solution",
  AddComment: "text",
};

function nowSec() {
  return Math.floor(Date.now() / 1000);
}

/** Unix-секунды; миллисекунды легаси-записей приводим. */
function toSeconds(value, fallback) {
  const n = Number(value);
  if (!Number.isFinite(n) || n <= 0) return fallback;
  return n > 9999999999 ? Math.floor(n / 1000) : n;
}

function normalizeTicketId(ticketId) {
  if (ticketId == null || ticketId === "") return null;
  const n = Number(ticketId);
  return Number.isFinite(n) ? n : ticketId;
}

function buildAuthorMarker(syncerUser, authorName, authorId) {
  const syncer = syncerUser?.name
    ? `${syncerUser.name} (ID: ${syncerUser.id ?? "?"})`
    : `ID: ${syncerUser?.id ?? "?"}`;
  const author = authorName
    ? `${authorName} (ID: ${authorId ?? "?"})`
    : `ID: ${authorId ?? "?"}`;
  return `${MARKER_PREFIX} ${syncer}. Автор: ${author}]`;
}

function needsAuthorMarker(cmd, currentUser) {
  if (!currentUser || currentUser.id == null) return false;
  if (cmd.offline_author_id == null) return false;
  if (String(cmd.offline_author_id) === String(currentUser.id)) return false;
  // CreateTicket несёт offline_author_* нативно — маркер не нужен.
  return cmd.command_type !== "CreateTicket";
}

/**
 * Payload с префиксом-маркером (или копия исходного, если маркер не нужен).
 * Идемпотентна: повторный прогон не добавляет второй маркер.
 */
export function applyAuthorMarker(cmd, currentUser) {
  const patched = { ...(cmd.payload || {}) };

  if (!needsAuthorMarker(cmd, currentUser)) return patched;

  const field = MARKER_FIELD[cmd.command_type];
  if (!field) return patched;

  const value = patched[field];
  if (typeof value !== "string" || !value.trim()) return patched;
  if (value.startsWith(MARKER_PREFIX)) return patched;

  patched[field] =
    buildAuthorMarker(
      currentUser,
      cmd.offline_author_name,
      cmd.offline_author_id,
    ) +
    "\n\n" +
    value;

  return patched;
}

/**
 * Автор офлайн-заявки обязателен (§4.1). Пустой → archived, работа потеряна.
 * Фолбэк — синхронизирующий пользователь: лучше атрибуция ему, чем отказ.
 */
function resolveOfflineAuthor(cmd, currentUser) {
  const id = cmd.offline_author_id ?? currentUser?.id ?? null;
  const name =
    cmd.offline_author_name ||
    currentUser?.name ||
    (currentUser?.surname
      ? `${currentUser.surname} ${currentUser.name || ""}`.trim()
      : null);

  if (id == null || !name) {
    console.warn(
      "[CommandBuilder] CreateTicket без автора — сервер отклонит команду:",
      cmd.command_uuid,
    );
  }
  return { id, name };
}

/**
 * Запись outbox → команда syncCommands.
 *
 * @param {Object}  cmd            запись outbox
 * @param {Object}  currentUser    authStore.getUser()
 * @param {Object}  [opts]
 * @param {boolean} [opts.forceCreate] явное подтверждение дубликата
 *                                     (модалка из очереди, п. 2.20)
 */
export function buildCommand(cmd, currentUser, opts = {}) {
  const type = cmd.command_type;
  const payload = applyAuthorMarker(cmd, currentUser);
  const createdAt = toSeconds(cmd.created_at, nowSec());

  // §3.2: force_create только на уровне команды.
  delete payload.force_create;

  // §4.1.1 и §4.2: срок офлайн не задаётся, сервер игнорирует в обоих путях.
  delete payload.repair_time;

  if (type === "CreateTicket") {
    const author = resolveOfflineAuthor(cmd, currentUser);
    payload.offline_author_id = author.id;
    payload.offline_author_name = author.name;

    // Обязательное поле. Без него — ошибка верхнего уровня и вечный pending.
    payload.opened_at = toSeconds(payload.opened_at, createdAt);

    // §4.1: fullAddress обязателен; легаси-записи несут только address.
    if (!payload.fullAddress && payload.address)
      payload.fullAddress = payload.address;
    if (!payload.address && payload.fullAddress)
      payload.address = payload.fullAddress;

    // §4.1.3: закрыта офлайн — closed_at не должен отсутствовать.
    if (payload.solution) {
      payload.closed_at = toSeconds(payload.closed_at, createdAt);
    }
  } else if (type === "CloseTicket") {
    // §4.3: без метки сервер подставит now — хронология поедет.
    payload.closed_at = toSeconds(payload.closed_at, createdAt);
  } else if (type === "AddComment") {
    // §4.4: note_post_date = created_at.
    payload.created_at = toSeconds(payload.created_at, createdAt);
  }

  const command = {
    command_uuid: cmd.command_uuid,
    command_type: type,
    ticket_id: type === "CreateTicket" ? null : normalizeTicketId(cmd.ticket_id),
    offline_uuid: cmd.offline_uuid ?? null,
    payload,
  };

  // Только CreateTicket и только по явному подтверждению пользователя.
  // Значение из payload НЕ читаем: это обход проверки дублей (§3.2).
  if (type === "CreateTicket" && opts.forceCreate === true) {
    command.force_create = true;
  }

  return command;
}