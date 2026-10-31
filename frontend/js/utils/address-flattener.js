/**
 * Превращает иерархический JSON адресов в плоский массив для IndexedDB
 */

// Список стоп-слов (синхронизирован с address-picker.js)
const STOP_WORDS = [
    "ул", "улица", "пр", "проспект", "пр-т", "пер", "переулок",
    "ш", "шоссе", "б-р", "бульвар", "пл", "площадь",
    "д", "дом", "п", "под", "подъезд", "лифт", "п.", "авеню", "аллея"
];

function normalizeSearchString(text) {
    if (!text) return '';
    let t = text
        .toLowerCase()
        .replace(/[^\wа-яё\s]/gi, " ")
        .replace(/\s+/g, " ")
        .trim();

    STOP_WORDS.forEach((w) => {
        // Удаляем слово целиком (границы слова \b)
        t = t.replace(new RegExp(`\\b${w}\\b`, "g"), "");
    });

    return t.replace(/\s+/g, " ").trim();
}

export function flattenAddresses(serverResponse) {
    if (!serverResponse || !serverResponse.message) return [];
    const { city = [], street = [], home = [], object = [] } = serverResponse.message;

    const cityMap = new Map(city.map(c => [c.id, c]));
    const streetMap = new Map(street.map(s => [s.id, s]));
    const homeMap = new Map(home.map(h => [h.id, h]));

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
            search_string: searchString
        });
    }

    return flatData;
}