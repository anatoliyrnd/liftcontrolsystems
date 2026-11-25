import { offlineDB } from "../offline-db.js";
import { UI } from "../config.js";
import { escapeHtml } from "../utils/escape-html.js";
import { normalizeSearchString } from "../utils/address-normalize.js";

export function createAddressPicker(opts = {}) {
  const {
    onChange = () => {},
    initialValue = null,
    mode = "elevator", // 'elevator' | 'house' | 'any'
    readOnly = false,
    autoOpen = true,
  } = opts;

  const wrap = document.createElement("div");
  wrap.className = "address-picker-wrap";
  wrap.style.cssText =
    "display: flex; flex-direction: column; gap: 10px; position: relative; z-index: 1001;";

  const cityWrap = document.createElement("div");
  const cityLabel = document.createElement("label");
  cityLabel.textContent = "Город";
  cityLabel.style.cssText =
    "font-size: 11px; font-weight: 700; color: var(--text-secondary); text-transform: uppercase;";

  const citySelect = document.createElement("select");
  citySelect.className = "search-input";
  citySelect.style.marginTop = "4px";

  cityWrap.appendChild(cityLabel);
  cityWrap.appendChild(citySelect);

  const searchWrap = document.createElement("div");
  searchWrap.style.display = "none";

  const searchLabel = document.createElement("label");
  searchLabel.textContent =
    mode === "house" ? "Поиск дома / лифта" : "Поиск адреса (Улица, дом, лифт)";
  searchLabel.style.cssText =
    "font-size: 11px; font-weight: 700; color: var(--text-secondary); text-transform: uppercase;";

  const searchInput = document.createElement("input");
  searchInput.type = "text";
  searchInput.className = "search-input editable-field";
  searchInput.placeholder = "Например: Ленина 5";
  searchInput.style.marginTop = "4px";
  searchInput.autocomplete = "off";

  if (readOnly) {
    citySelect.disabled = true;
    citySelect.style.pointerEvents = "none";
    citySelect.style.backgroundColor = "var(--table-row-hover)";
    citySelect.style.cursor = "not-allowed";

    searchInput.readOnly = true;
    searchInput.style.pointerEvents = "none";
    searchInput.style.backgroundColor = "var(--table-row-hover)";
    searchInput.style.cursor = "not-allowed";
    searchInput.classList.remove("editable-field");
  }

  const dropdown = document.createElement("div");

  // === ДИНАМИЧЕСКАЯ ПОДЛОЖКА (без конфликта ID) ===
  const backdrop = document.createElement("div");
  backdrop.className = "filter-backdrop";
  backdrop.style.display = "none";
  document.body.appendChild(backdrop);

  const onBackdropClick = (e) => {
    e.stopPropagation(); // Защита от двойного срабатывания с document
    hideDropdown();
    searchInput.blur();
  };
  backdrop.addEventListener("click", onBackdropClick);

  dropdown.style.cssText =
    "display: none; position: absolute; top: 100%; left: 0; right: 0; z-index: 1000; max-height: 350px; overflow-y: auto; overscroll-behavior: contain; border: 1px solid var(--border-color); border-radius: 8px; background: var(--bg-secondary); box-shadow: 0 4px 12px rgba(0,0,0,0.15); margin-top: 4px; padding-bottom: 8px;";

  searchWrap.appendChild(searchLabel);
  searchWrap.appendChild(searchInput);
  searchWrap.appendChild(dropdown);
  wrap.appendChild(cityWrap);
  wrap.appendChild(searchWrap);

  let selectedData = initialValue;
  let currentCities = [];
  let pendingCityId = null;
  let focusableElements = [];
  let activeIndex = -1;

  // Пагинация отрисовки: поиск в памяти, лимит — только окно DOM.
  let searchResults = [];
  let groupedResults = [];
  let renderedGroups = 0;
  let renderedItems = 0;
  let footerEl = null;
  let currentQuery = "";

  /**
   * R1: «только город» сворачивает поиск снаружи. Флаг живёт здесь,
   * а не в filters-view: видимость searchWrap меняют четыре внутренних
   * места (loadCities, handleCityChange, setValue, reset), и внешний
   * display перезатирался бы первым же из них.
   */
  let searchCollapsed = false;

  const normalize = normalizeSearchString;

  function escapeRegExp(s) {
    return s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  }

  /**
   * Подсветка совпадений.
   *
   * Было два дефекта. Первый: токен уходил в new RegExp без экранирования
   * метасимволов — ввод «ленина (юг» или «п.1\» бросал SyntaxError, и
   * выпадающий список ломался на обычном тексте. escapeHtml экранирует
   * HTML, а не regexp, и от этого не спасал.
   *
   * Второй: сначала escapeHtml, потом replace — запрос «amp» вставлял
   * <b> внутрь сущности & и рвал разметку. Теперь режем СЫРОЙ текст
   * и экранируем каждый кусок отдельно.
   */
  function highlight(text, query) {
    const raw = String(text ?? "");
    if (!query) return escapeHtml(raw);

    const tokens = [...new Set(query.split(" ").filter(Boolean))];
    if (tokens.length === 0) return escapeHtml(raw);

    // Одна capture-группа с альтернацией: split возвращает
    // [текст, совпадение, текст, …], нечётные индексы — совпадения.
    const re = new RegExp("(" + tokens.map(escapeRegExp).join("|") + ")", "gi");

    return raw
      .split(re)
      .map((part, i) =>
        i % 2 === 1 ? "<b>" + escapeHtml(part) + "</b>" : escapeHtml(part),
      )
      .join("");
  }

  function getRecentAddresses(cityId) {
    try {
      const raw = localStorage.getItem("recent_addresses");
      const all = raw ? JSON.parse(raw) : [];
      return all
        .filter((a) => a.city_id === Number(cityId))
        .slice(0, UI.RECENT_ADDRESSES_LIMIT);
    } catch (e) {
      return [];
    }
  }

  /** Единая точка видимости поля поиска: город выбран и поиск не свёрнут. */
  function applySearchVisibility() {
    const visible = !readOnly && !searchCollapsed && !!citySelect.value;
    searchWrap.style.display = visible ? "block" : "none";
    if (!visible) hideDropdown();
    return visible;
  }

  async function loadCities() {
    currentCities = await offlineDB.getCities();
    citySelect.innerHTML = '<option value="">— Выберите город —</option>';
    currentCities.forEach((c) => {
      const opt = document.createElement("option");
      opt.value = String(c.id);
      opt.textContent = c.display || c.name;
      citySelect.appendChild(opt);
    });

    if (pendingCityId) {
      citySelect.value = String(pendingCityId);
      pendingCityId = null;
      applySearchVisibility();
    } else {
      const defaultCity = await offlineDB.getConfig("default_city_id");
      if (
        defaultCity &&
        currentCities.some((c) => String(c.id) === String(defaultCity))
      ) {
        citySelect.value = String(defaultCity);
        if (readOnly) return;
        // autoOpen:false — экран отчётов: город проставлен и поле поиска
        // видно, но без focus() и triggerSearch(""): иначе страница
        // открывалась бы с раскрытым списком и подложкой поверх фильтров,
        // а onChange(null) затирал бы восстановленные фильтры.
        applySearchVisibility();
        if (autoOpen) handleCityChange();
      }
    }
  }

  /**
   * Кнопка «Обновить кэш адресов» меняет справочник под открытым пикером.
   * Без повторного поиска список продолжал бы показывать записи старого
   * кэша до следующего ввода — выглядело бы как «обновление не сработало».
   */
  async function onAddressesUpdated() {
    await loadCities();
    if (dropdown.style.display !== "none" && citySelect.value) {
      triggerSearch(searchInput.value.trim());
    }
  }
  window.addEventListener("addresses:updated", onAddressesUpdated);

  function handleCityChange() {
    const cityId = citySelect.value;
    if (!cityId) {
      searchWrap.style.display = "none";
      selectedData = null;
      onChange(null);
      return;
    }
    if (readOnly) return;

    searchInput.value = "";

    // R1: при свёрнутом поиске город обязан остаться в payload.
    // selectedData = null потерял бы city_id, и city_only=true уехал бы
    // без города — фильтр расширился бы до всего тенанта.
    if (searchCollapsed) {
      selectedData = {
        city_id: Number(cityId),
        street_id: null,
        home_id: null,
        object_id: null,
        address: citySelect.selectedOptions[0]?.textContent || "",
        sort_key: null,
      };
      onChange(selectedData);
      applySearchVisibility();
      return;
    }

    selectedData = null;
    onChange(null);
    if (!applySearchVisibility()) return;
    searchInput.focus();
    triggerSearch("");
  }
  citySelect.onchange = handleCityChange;

  function showDropdown() {
    dropdown.style.display = "block";
    backdrop.style.display = "block";

    const rect = searchInput.getBoundingClientRect();
    const windowHeight = window.innerHeight;
    const padding = 20;
    const minSpace = 250;
    const spaceBelow = windowHeight - rect.bottom - padding;
    const spaceAbove = rect.top - padding;

    dropdown.style.position = "fixed";
    dropdown.style.left = rect.left + "px";
    dropdown.style.width = rect.width + "px";
    dropdown.style.right = "auto";

    if (spaceBelow < minSpace && spaceAbove > spaceBelow) {
      dropdown.style.top = "auto";
      dropdown.style.bottom = windowHeight - rect.top + 5 + "px";
      dropdown.style.marginTop = "0";
      dropdown.style.marginBottom = "0";
      dropdown.style.maxHeight = Math.min(spaceAbove, 350) + "px";
    } else {
      dropdown.style.top = rect.bottom + 5 + "px";
      dropdown.style.bottom = "auto";
      dropdown.style.marginTop = "0";
      dropdown.style.marginBottom = "0";
      dropdown.style.maxHeight = Math.min(spaceBelow, 350) + "px";
    }
  }

  function hideDropdown() {
    dropdown.style.display = "none";
    backdrop.style.display = "none";
  }

  // === СОХРАНЯЕМ ССЫЛКИ НА СЛУШАТЕЛИ ===
  const onWindowResize = () => hideDropdown();
  const onWindowScroll = (e) => {
    if (!dropdown.contains(e.target)) hideDropdown();
  };
  const onDocClick = (e) => {
    if (!searchWrap.contains(e.target)) hideDropdown();
  };

  window.addEventListener("resize", onWindowResize);
  window.addEventListener("scroll", onWindowScroll, true);
  document.addEventListener("click", onDocClick);

  const onDropdownScroll = () => {
    if (dropdown.style.display === "none") return;
    if (renderedGroups >= groupedResults.length) return;
    if (
      dropdown.scrollTop + dropdown.clientHeight >=
      dropdown.scrollHeight - 60
    ) {
      appendPage(renderedItems + PAGE_ITEMS);
    }
  };
  dropdown.addEventListener("scroll", onDropdownScroll);

  function renderGroup(group, query) {
    const groupEl = document.createElement("div");
    groupEl.className = "address-group";
    groupEl.style.cssText =
      "padding: 10px 12px; border-bottom: 1px solid var(--border-color);";

    const houseEl = document.createElement("div");
    houseEl.className = "address-house-header";
    houseEl.style.cssText =
      "font-weight: 600; font-size: 13px; margin-bottom: 8px; color: var(--text-primary);";
    houseEl.innerHTML = highlight(group.house_display, query);

    if (mode === "house" || mode === "any") {
      houseEl.style.cursor = "pointer";
      houseEl.classList.add("selectable-house");
      houseEl.onclick = () => selectAddress(group, "house");
      focusableElements.push(houseEl);
    }
    groupEl.appendChild(houseEl);

    const pillsWrap = document.createElement("div");
    pillsWrap.className = "address-pills-wrap";
    pillsWrap.style.cssText = "display: flex; flex-wrap: wrap; gap: 6px;";

    group.elevators.forEach((elev) => {
      const pill = document.createElement("button");
      pill.type = "button";
      pill.className = "address-pill";
      pill.innerHTML = highlight(elevatorLabel(elev), query);
      pill.onclick = () => selectAddress(elev, "elevator");
      focusableElements.push(pill);
      pillsWrap.appendChild(pill);
    });

    groupEl.appendChild(pillsWrap);
    return groupEl;
  }

  function updateFooter() {
    if (!footerEl) return;
    const total = searchResults.length;
    const capped = total >= SEARCH_LIMIT;

    if (renderedItems >= total && !capped) {
      footerEl.style.display = "none";
      return;
    }
    footerEl.style.display = "block";
    footerEl.textContent = capped
      ? `Показано ${renderedItems} из ${SEARCH_LIMIT}+ совпадений. Уточните запрос.`
      : `Показано ${renderedItems} из ${total}. Прокрутите список, чтобы загрузить ещё.`;
  }

  /** Дорисовывает группы, пока не наберётся targetItems объектов. */
  function appendPage(targetItems) {
    while (
      renderedGroups < groupedResults.length &&
      renderedItems < targetItems
    ) {
      const group = groupedResults[renderedGroups++];
      // Футер всегда последний: группы вставляются перед ним.
      dropdown.insertBefore(renderGroup(group, currentQuery), footerEl);
      renderedItems += group.elevators.length;
    }
    updateFooter();
  }

  function renderDropdown(results) {
    dropdown.innerHTML = "";
    focusableElements = [];
    activeIndex = -1;
    searchResults = results;
    groupedResults = [];
    renderedGroups = 0;
    renderedItems = 0;
    footerEl = null;

    const cityId = citySelect.value;
    const rawQuery = searchInput.value.trim();
    const query = normalize(rawQuery);
    currentQuery = query;

    const recent = !query ? getRecentAddresses(cityId) : [];

    if (recent.length > 0) {
      const title = document.createElement("div");
      title.textContent = "Недавние адреса";
      title.style.cssText =
        "padding: 8px 12px; font-size: 11px; font-weight: 700; color: var(--text-secondary); text-transform: uppercase; border-bottom: 1px solid var(--border-color);";
      dropdown.appendChild(title);

      recent.forEach((item) => {
        const el = document.createElement("div");
        el.className = "recent-address-item";
        el.style.cssText =
          "padding: 10px 12px; font-size: 13px; cursor: pointer; border-bottom: 1px solid var(--border-color);";
        el.textContent = item.display_name;
        el.onclick = () => selectAddress(item, "elevator");
        dropdown.appendChild(el);
      });
    }

    if (results.length === 0 && recent.length === 0) {
      dropdown.innerHTML =
        '<div style="padding: 10px; font-size: 13px; color: var(--text-secondary); text-align: center;">Ничего не найдено</div>';
      showDropdown();
      return;
    }

    if (results.length > 0 && recent.length > 0) {
      const divider = document.createElement("div");
      divider.style.cssText =
        "padding: 8px 12px; font-size: 11px; font-weight: 700; color: var(--text-secondary); text-transform: uppercase; border-bottom: 1px solid var(--border-color);";
      divider.textContent = "Результаты поиска";
      dropdown.appendChild(divider);
    }

    const grouped = new Map();
    results.forEach((item) => {
      if (!grouped.has(item.home_id)) {
        grouped.set(item.home_id, {
          home_id: item.home_id,
          city_id: item.city_id,
          street_id: item.street_id,
          house_display: item.house_display,
          elevators: [],
        });
      }
      grouped.get(item.home_id).elevators.push(item);
    });
    groupedResults = [...grouped.values()];

    footerEl = document.createElement("div");
    footerEl.style.cssText =
      "padding: 8px; font-size: 11px; color: var(--text-secondary); text-align: center; background: var(--bg-primary);";
    dropdown.appendChild(footerEl);

    appendPage(PAGE_ITEMS);
    showDropdown();
  }

  /**
   * Подпись лифта. Отрезаем префикс дома, а не split(", ").pop():
   * имя лифта само может содержать запятую («п.1, пасс.»), и pop()
   * возвращал бы только «пасс.». Фолбэк на случай старого кэша,
   * где object_name ещё нет.
   */
  function elevatorLabel(elev) {
    if (elev.object_name) return String(elev.object_name);
    const full = String(elev.display_name || "");
    const house = String(elev.house_display || "");
    const tail =
      house && full.startsWith(house) ? full.slice(house.length) : full;
    return tail.replace(/^,\s*/, "") || `Лифт №${elev.id}`;
  }

  function selectAddress(item, type) {
    const isHouse = type === "house";
    selectedData = {
      city_id: item.city_id,
      street_id: item.street_id,
      home_id: item.home_id,
      object_id: isHouse ? null : item.id,
      address: isHouse ? item.house_display : item.display_name,
      // Ключ сортировки уезжает в офлайн-заявку: серверного у неё нет
      // до синхронизации, а искать его по кэшу в синхронном рендерере
      // нельзя. Берём из той же записи, что и подпись, — один момент,
      // одно значение, расхождения не будет.
      sort_key: item.sort_key ?? null,
    };
    searchInput.value = selectedData.address;
    hideDropdown();
    onChange(selectedData);
  }

  // Потолок выборки совпадений из локального поиска.
  const SEARCH_LIMIT = 300;
  // Сколько объектов дорисовываем за один шаг пагинации.
  const PAGE_ITEMS = 50;

  let debounceTimer = null;
  let searchSeq = 0;

  async function triggerSearch(val) {
    const cityId = parseInt(citySelect.value, 10);
    if (!cityId) return;
    const seq = ++searchSeq;
    const q = normalize(val);
    const results = await offlineDB.searchAddresses(cityId, q, SEARCH_LIMIT);
    // Ответ устаревшего запроса не перерисовывает список: при быстром
    // вводе порядок разрешения async-вызовов не гарантирован, и медленный
    // ранний поиск затирал бы результат свежего.
    if (seq !== searchSeq) return;
    renderDropdown(results);
  }

  searchInput.oninput = () => {
    const val = searchInput.value.trim();
    if (debounceTimer) clearTimeout(debounceTimer);
    if (selectedData && val !== selectedData.address) {
      selectedData = null;
      onChange(null);
    }
    debounceTimer = setTimeout(() => triggerSearch(val), 200);
  };

  searchInput.onfocus = () => {
    const val = searchInput.value.trim();
    // R2: ранний выход только для выбора ЛИФТА. После выбора дома
    // (object_id == null) фокус обязан открыть список: иначе диспетчер
    // не может дойти до пилюль лифта, не стирая текст вручную.
    // Ветка объекта не тронута: клик по полю с полным адресом по-прежнему
    // выделяет текст, а не раскрывает список поверх выбранного значения.
    if (
      selectedData &&
      selectedData.object_id != null &&
      val === selectedData.address
    ) {
      searchInput.select();
      return;
    }
    triggerSearch(val);
  };

  function updateActiveElement() {
    focusableElements.forEach((el, idx) => {
      if (idx === activeIndex) {
        el.classList.add("keyboard-active");
        el.scrollIntoView({ block: "nearest" });
      } else {
        el.classList.remove("keyboard-active");
      }
    });
  }

  searchInput.onkeydown = (e) => {
    if (dropdown.style.display === "none") return;

    if (e.key === "ArrowDown") {
      e.preventDefault();
      // На последней отрисованной строке стрелка догружает следующую порцию.
      if (
        activeIndex >= focusableElements.length - 1 &&
        renderedGroups < groupedResults.length
      ) {
        appendPage(renderedItems + PAGE_ITEMS);
      }
      if (activeIndex < focusableElements.length - 1) activeIndex++;
      updateActiveElement();
    } else if (e.key === "ArrowUp") {
      e.preventDefault();
      if (activeIndex > 0) activeIndex--;
      updateActiveElement();
    } else if (e.key === "Enter") {
      e.preventDefault();
      if (activeIndex >= 0 && focusableElements[activeIndex]) {
        focusableElements[activeIndex].click();
      }
    } else if (e.key === "Escape") {
      hideDropdown();
    }
  };

  loadCities();

  return {
    element: wrap,
    getValue: () => selectedData,
    isValid: () => selectedData !== null,
    // Снаружи: контроллер гасит список при уходе с вкладки. Подложка
    // лежит в body и переживает display:none родителя.
    closeDropdown: hideDropdown,
    /**
     * R1: сворачивание поиска при «только город». Сбрасываем выбор ниже
     * города, город сохраняем. Один onChange на вызов — без шторма
     * scheduleChange в filters-view. Разворачивание список НЕ раскрывает:
     * на отчётах autoOpen:false, автораскрытие при восстановлении уже
     * ловили как дефект.
     */
    setSearchCollapsed: (flag) => {
      searchCollapsed = flag === true;
      if (searchCollapsed) {
        hideDropdown();
        if (selectedData) {
          selectedData = {
            city_id:
              Number(selectedData.city_id) || Number(citySelect.value) || null,
            street_id: null,
            home_id: null,
            object_id: null,
            address: citySelect.selectedOptions[0]?.textContent || "",
            sort_key: null,
          };
          searchInput.value = "";
          onChange(selectedData);
        }
      }
      applySearchVisibility();
    },
    setValue: (val) => {
      if (!val) return;
      selectedData = val;
      // Черновик из sessionStorage мог сохраниться до появления address.
      searchInput.value = val.address || val.display_name || "";
      const stringCityId = String(val.city_id);
      if (citySelect.options.length > 1) {
        citySelect.value = stringCityId;
      } else {
        pendingCityId = stringCityId;
      }
      applySearchVisibility();
      onChange(selectedData);
    },
    reset: () => {
      selectedData = null;
      searchInput.value = "";
      citySelect.value = "";
      searchWrap.style.display = "none";
      hideDropdown();
      onChange(null);
    },
    destroy: () => {
      if (debounceTimer) clearTimeout(debounceTimer);
      // Удаляем глобальные слушатели
      window.removeEventListener("addresses:updated", onAddressesUpdated);
      window.removeEventListener("resize", onWindowResize);
      window.removeEventListener("scroll", onWindowScroll, true);
      document.removeEventListener("click", onDocClick);
      dropdown.removeEventListener("scroll", onDropdownScroll);
      // Удаляем подложку
      backdrop.removeEventListener("click", onBackdropClick);
      if (backdrop.parentNode) {
        backdrop.parentNode.removeChild(backdrop);
      }
    },
  };
}
