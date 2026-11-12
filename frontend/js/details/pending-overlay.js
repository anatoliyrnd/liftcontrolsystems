/**
 * Наложение офлайн-команд (outbox) на серверный тикет.
 * Чистая функция: не мутирует вход, не делает await, не ходит в сторы.
 *
 * Оверлей _pendingRepair удалён (п. 1.7): срок ремонта офлайн не задаётся,
 * сервер назначает его сам при синхронизации (API_syncCommands §4.1.1).
 * Оверлеи staff / notify / details / close / comment сохранены.
 */

const OFFLINE_COMMENT_HEADER = "⏳ [Офлайн-комментарии]";
const OFFLINE_COMMENT_LINE_RE = /^\[([^,]+),\s*([^\]]+)\]:\s*(.*)$/;

function toSeconds(value) {
  const n = Number(value);
  if (!Number.isFinite(n) || n <= 0) return null;
  return n > 9999999999 ? Math.floor(n / 1000) : n;
}

function parseRuDateTime(s) {
  const m = String(s || "")
    .trim()
    .match(/^(\d{2})\.(\d{2})\.(\d{4})\s+(\d{2}):(\d{2})$/);
  if (!m) return null;
  const [, dd, mm, yyyy, hh, min] = m;
  const d = new Date(
    Number(yyyy),
    Number(mm) - 1,
    Number(dd),
    Number(hh),
    Number(min),
  );
  return isNaN(d.getTime()) ? null : Math.floor(d.getTime() / 1000);
}

function parseOfflineComments(commentsStr) {
  if (typeof commentsStr !== "string" || !commentsStr.trim()) return [];
  const out = [];
  for (const raw of commentsStr.split("\n")) {
    const line = raw.trim();
    if (!line || line === OFFLINE_COMMENT_HEADER) continue;
    const m = line.match(OFFLINE_COMMENT_LINE_RE);
    if (m) {
      out.push({
        user: m[1].trim(),
        date: parseRuDateTime(m[2]),
        body: m[3].trim(),
      });
    } else {
      out.push({ user: "Офлайн", date: null, body: line });
    }
  }
  return out;
}

/**
 * @param {Object} serverTicket
 * @param {Array}  pendingCommands
 * @param {Array}  staffList [{id, name}]
 * @returns {Object|null}
 */
export function applyPendingOverlay(
  serverTicket,
  pendingCommands = [],
  staffList = [],
) {
  if (!serverTicket) return null;

  const t = {
    ...serverTicket,
    note: Array.isArray(serverTicket.note)
      ? [...serverTicket.note]
      : serverTicket.note && typeof serverTicket.note === "object"
        ? Object.values(serverTicket.note)
        : [],
  };

  const getStaffName = (id) => {
    const staff = staffList.find((s) => String(s.id) === String(id));
    return staff ? staff.name : null;
  };

  for (const cmd of pendingCommands || []) {
    if (!cmd || cmd.status !== "pending") continue;
    const p = cmd.payload || {};
    const createdAt = toSeconds(cmd.created_at);

    if (cmd.command_type === "EditTicket") {
      // Soft Merge: применяем только если поле пустое.
      if (p.staff_id != null && !t.staff_id) {
        t.staff_id = Number(p.staff_id);
        t.staff_name = getStaffName(p.staff_id);
        t._pendingStaff = true;
      }
      if (p.notify_status != null && !t.notify_status) {
        t.notify_status = Number(p.notify_status);
        t.notify_date = createdAt;
        t._pendingNotify = true;
      }
      if (p.details) {
        t.details = (t.details || "") + (t.details ? "\n\n" : "") + p.details;
        t._pendingDetails = true;
      }
    } else if (cmd.command_type === "AddComment") {
      t.note.push({
        id: "pending_" + cmd.command_uuid,
        user: cmd.offline_author_name || "Вы",
        body: p.text || "",
        date: createdAt,
        type: 0,
        is_offline: 1,
        _pending: true,
      });
      t.note_num = (t.note_num || 0) + 1;
    } else if (cmd.command_type === "CloseTicket") {
      t._pendingClose = {
        solution: p.solution || "",
        close_date: toSeconds(p.closed_at) ?? createdAt,
        close_name: cmd.offline_author_name || "—",
        command_uuid: cmd.command_uuid,
      };
    }
  }

  // Офлайн-заявка: разворачиваем payload в отображаемые note / pendingClose.
  if (t.isOffline) {
    if (t.comments) {
      const parsed = parseOfflineComments(t.comments);
      for (const n of parsed) {
        t.note.push({
          id: "offline_" + t.note.length,
          user: n.user,
          body: n.body,
          date: n.date,
          type: 0,
          is_offline: 1,
          _pending: true,
        });
      }
      t.note_num = (t.note_num || 0) + parsed.length;
    }

    if (t.solution) {
      t._pendingClose = {
        solution: t.solution,
        close_date: toSeconds(t.closed_at),
        close_name: t.closed_by_name || "—",
      };
    }

    // Срок офлайн не задаётся никогда.
    t.repair_time = null;
  }

  return t;
}
