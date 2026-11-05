const OFFLINE_COMMENT_HEADER = "⏳ [Офлайн-комментарии]";
const OFFLINE_COMMENT_LINE_RE = /^\[([^,]+),\s*([^\]]+)\]:\s*(.*)$/;

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
      // fallback: не распарсили — показываем как есть
      out.push({ user: "Офлайн", date: null, body: line });
    }
  }
  return out;
}

/**
 * Чистая функция наложения офлайн-команд (outbox) на серверный тикет.
 *
 * Не мутирует входные данные. Возвращает новый объект.
 * Не делает await. Не обращается к глобальным сторам (staffStore передается аргументом).
 *
 * @param {Object} serverTicket - заявка с сервера
 * @param {Array} pendingCommands - массив команд из outbox
 * @param {Array} staffList - справочник механиков [{id, name}] для подстановки имен
 * @returns {Object} новый тикет с наложенным оверлеем
 */
export function applyPendingOverlay(
  serverTicket,
  pendingCommands,
  staffList = [],
) {
  if (!serverTicket) return null;

  // 1. Создаем копию тикета, чтобы не мутировать оригинал (важно для combinedTicketsArray)
  const t = {
    ...serverTicket,
    note: Array.isArray(serverTicket.note)
      ? [...serverTicket.note]
      : serverTicket.note && typeof serverTicket.note === "object"
        ? Object.values(serverTicket.note)
        : [],
  };

  // Хелпер для поиска имени механика
  const getStaffName = (id) => {
    const staff = staffList.find((s) => String(s.id) === String(id));
    return staff ? staff.name : null;
  };

  // 2. Применяем команды
  for (const cmd of pendingCommands) {
    if (cmd.status !== "pending") continue;
    const p = cmd.payload || {};

    if (cmd.command_type === "EditTicket") {
      // Применяем только если поле пустое (Soft Merge логика)
      if (p.staff_id != null && !t.staff_id) {
        t.staff_id = Number(p.staff_id);
        t.staff_name = getStaffName(p.staff_id);
        t._pendingStaff = true;
      }
      if (p.notify_status != null && !t.notify_status) {
        t.notify_status = Number(p.notify_status);
        t.notify_date = cmd.created_at;
        t._pendingNotify = true;
      }
      if (p.repair_time != null && !t.repair_time) {
        t.repair_time = Number(p.repair_time);
        t._pendingRepair = true;
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
        date: cmd.created_at,
        type: 0,
        _pending: true,
      });
      t.note_num = (t.note_num || 0) + 1;
    } else if (cmd.command_type === "CloseTicket") {
      t._pendingClose = {
        solution: p.solution || "",
        close_date: cmd.created_at,
        close_name: cmd.offline_author_name || "—",
        command_uuid: cmd.command_uuid,
      };
    }
  }
  // #8: офлайн-заявка — разворачиваем поля payload в отображаемые
  // note / _pendingClose (payload.comments/solution/closed_at/closed_by_name).
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
          _pending: true,
        });
      }
      t.note_num = (t.note_num || 0) + parsed.length;
    }
    if (t.solution) {
      t._pendingClose = {
        solution: t.solution,
        close_date: t.closed_at || null,
        close_name: t.closed_by_name || "—",
      };
    }
  }
  return t;
}
