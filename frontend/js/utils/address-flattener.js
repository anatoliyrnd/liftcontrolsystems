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

    const cName = String(c.city_name ?? "").trim();
    const sName = String(s.street_name ?? "").trim();
    const hName = String(h.home_name ?? "").trim();
    const oName = String(obj.object_name ?? "").trim();

    // Подпись собирает СЕРВЕР (Address::formatStreet / formatHome).
    // Здесь был четвёртый форматировщик: он приклеивал «д.» к home_name
    // безусловно и терял тип улицы, которого в street_name больше нет.
    //
    // Фолбэк на сырое имя нужен для старого кэша в IndexedDB и для
    // ответа, пришедшего до выкатки серверной правки: без него пустой
    // *_display обнулил бы адрес в пикере.
    const sDisplay = String(s.street_display ?? "").trim() || sName;
    const hDisplay = String(h.home_display ?? "").trim() || hName;
    // Тип населённого пункта — данные сервера (city_type → city_display).
    // Клиент префикс НЕ выдумывает: посёлки, станицы и хутора иначе
    // получили бы ложное «г.'. Фолбэк на чистое имя — старый кэш и
    // ответ до выкатки серверной правки; лечится bump версии addresses.
    const cDisplay = String(c.city_display ?? "").trim() || cName;

    // filter(Boolean), а не шаблон через запятую: при пустом компоненте
    // шаблон давал «…, , д. » — висящие разделители в подписи.
    const houseDisplay = [cDisplay, sDisplay, hDisplay]
      .filter(Boolean)
      .join(", ");
    const displayName = [houseDisplay, oName].filter(Boolean).join(", ");

    // Ключ сортировки — из ЧИСТЫХ имён, без маркеров. Сортировать по
    // display_name нельзя: «ул.» и «пр-кт» в начале снова соберут все
    // улицы под «у» и «п», и вынос типа в street_type потеряет смысл.
    // Паритет с Address::sortKey: пустой компонент не даёт висящего
    // пробела, иначе офлайн- и серверный ключ одного адреса разойдутся.
    const sortKey = [cName, sName, hName, oName]
      .map((p) => String(p ?? "").trim())
      .filter(Boolean)
      .join(" ")
      .toLowerCase();

    // Поиск — по сырым именам, как раньше: normalizeSearchString сам
    // снимает маркеры своим словарём стоп-слов. Менять источник здесь
    // значит смешать две нормализации.
    const rawSearch = `${cName} ${sName} ${hName} ${oName}`;
    const searchString = normalizeSearchString(rawSearch);

    flatData.push({
      id: obj.id,
      city_id: c.id,
      city_name: cName,
      street_id: s.id,
      home_id: h.id,
      home_name: hName,
      // Пикер читает elev.object_name для подписи пилюли. Поля не было,
      // и он всегда падал на display_name.split(", ").pop() — имя лифта
      // с запятой («п.1, пасс.») теряло первую половину.
      object_name: oName,
      display_name: displayName,
      house_display: houseDisplay,
      sort_key: sortKey,
      search_string: searchString,
    });
  }

  return flatData;
}
