/**
 * Превращает иерархический JSON адресов в плоский массив для IndexedDB
 */

//**

import { normalizeSearchString } from "./address-normalize.js";

// STOP_WORDS и normalizeSearchString вынесены в address-normalize.js:
// одна и та же нормализация нужна здесь (данные сервера) и в
// address-picker.js (запрос пользователя). Дублирование приводило
// к рассинхрону: данные очищены, а запрос — нет.

export function flattenAddresses(serverResponse) {
  if (!serverResponse || !serverResponse.message) return [];
  const {
    city = [],
    street = [],
    home = [],
    object = [],
  } = serverResponse.message;

  const cityMap = new Map(city.map((c) => [c.id, c]));
  const streetMap = new Map(street.map((s) => [s.id, s]));
  const homeMap = new Map(home.map((h) => [h.id, h]));

  const flatData = [];

  for (const obj of object) {
    if (!obj.home_id || obj.home_id === 0) continue;

    const h = homeMap.get(obj.home_id);
    if (!h) continue;
    const s = streetMap.get(h.street_id);
    if (!s) continue;
    const c = cityMap.get(s.city_id);
    if (!c) continue;

    const cName = c.city_name.trim();
    const sName = s.street_name.trim();
    const hName = h.home_name.trim();
    const oName = obj.object_name.trim();

    const houseDisplay = `${cName}, ${sName}, д. ${hName}`;
    const displayName = `${houseDisplay}, ${oName}`;

    // ИСПОЛЬЗУЕМ ОЧИЩЕННУЮ СТРОКУ ДЛЯ ПОИСКА
    const rawSearch = `${cName} ${sName} ${hName} ${oName}`;
    const searchString = normalizeSearchString(rawSearch);

    flatData.push({
      id: obj.id,
      city_id: c.id,
      city_name: cName,
      street_id: s.id,
      home_id: h.id,
      home_name: hName,
      display_name: displayName,
      house_display: houseDisplay,
      search_string: searchString,
    });
  }

  return flatData;
}
