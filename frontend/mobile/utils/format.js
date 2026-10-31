/**
 * Форматирование timestamp.
 * API_PROTOCOL v4.0: даты приходят как Unix timestamp в СЕКУНДАХ.
 * Защищаемся от миллисекунд (если сервер вдруг пришлёт ms).
 */

export function toTimestamp(raw) {
  if (raw === null || raw === undefined) return null;
  const ts = Number(raw);
  if (!Number.isFinite(ts) || ts <= 0) return null;
  return ts > 10000000000 ? Math.floor(ts / 1000) : ts;
}

export function toDate(raw) {
  const ts = toTimestamp(raw);
  if (!ts) return null;
  const d = new Date(ts * 1000);
  return Number.isNaN(d.getTime()) ? null : d;
}

export function formatTime(raw) {
  const d = toDate(raw);
  if (!d) return "—";
  return d.toLocaleTimeString("ru-RU", { hour: "2-digit", minute: "2-digit" });
}

export function formatDate(raw) {
  const d = toDate(raw);
  if (!d) return "—";
  return d.toLocaleDateString("ru-RU");
}

export function formatDateTime(raw) {
  const d = toDate(raw);
  if (!d) return "—";
  return (
    d.toLocaleDateString("ru-RU") +
    " " +
    d.toLocaleTimeString("ru-RU", { hour: "2-digit", minute: "2-digit" })
  );
}

export function formatShortDate(raw) {
  const d = toDate(raw);
  if (!d) return "—";
  return d.toLocaleDateString("ru-RU", { day: "2-digit", month: "2-digit" });
}
