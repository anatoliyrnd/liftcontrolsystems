import { REPORTS } from "../config.js";

/**
 * Односторонний канал «фильтры → таблица» между вкладками браузера.
 *
 * Транспорт — localStorage + событие storage, а не BroadcastChannel:
 * событие приходит и в уже открытую вкладку, и переживает её
 * перезагрузку (свежая вкладка читает ключ сама). BroadcastChannel
 * не дал бы второго, а поддержка у него уже́.
 *
 * seq обязателен: storage-событие не возникает, если значение не
 * изменилось. Повторный «Найти» с теми же фильтрами иначе молча
 * не обновлял бы таблицу.
 *
 * Ключ содержит user_id: запрос одного пользователя не должен
 * прилететь в таблицу, открытую под другим аккаунтом.
 */
function requestKey(userId) {
  return `lift:reports:result:${userId ?? "anon"}:request`;
}

/** URL вкладки таблицы — от текущего пути, работает на любом тенанте. */
export function resultsUrl() {
  return location.pathname + location.search + REPORTS.RESULTS_HASH;
}

export function publishResultRequest(userId, payload) {
  const req = {
    seq: Date.now(),
    userId: userId ?? null,
    payload,
    ts: Math.floor(Date.now() / 1000),
  };
  try {
    localStorage.setItem(requestKey(userId), JSON.stringify(req));
  } catch (e) {
    console.warn("[resultChannel] не удалось записать запрос:", e);
    return null;
  }
  return req;
}

export function readResultRequest(userId) {
  try {
    const raw = localStorage.getItem(requestKey(userId));
    if (!raw) return null;
    const parsed = JSON.parse(raw);
    return parsed && typeof parsed === "object" ? parsed : null;
  } catch (e) {
    return null;
  }
}

/** Подписка на новые запросы. Возвращает функцию отписки. */
export function subscribeResultRequests(userId, handler) {
  const key = requestKey(userId);
  const onStorage = (e) => {
    if (e.key !== key || !e.newValue) return;
    try {
      const req = JSON.parse(e.newValue);
      if (req && typeof req === "object") handler(req);
    } catch (err) {
      console.warn("[resultChannel] битый запрос:", err);
    }
  };
  window.addEventListener("storage", onStorage);
  return () => window.removeEventListener("storage", onStorage);
}
