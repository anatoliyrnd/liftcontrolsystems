import { offlineDB } from "../offline-db.js";
import { UI } from "../config.js";
import { escapeHtml } from "../utils/escape-html.js";

export function createAddressPicker(opts = {}) {
  const {
    onChange = () => {},
    initialValue = null,
    mode = "elevator", // 'elevator' | 'house' | 'any'
    readOnly = false,
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

  function normalize(text) {
    let t = text
        .toLowerCase()
        .replace(/[^\wа-яё\s]/gi, " ")
        .replace(/\s+/g, " ")
        .trim();
    const stopWords = [
      "ул", "улица", "пр", "проспект", "пр-т", "пер", "переулок",
      "ш", "шоссе", "б-р", "бульвар", "пл", "площадь",
      "д", "дом", "п", "под", "подъезд", "лифт", "п.", "авеню", "аллея",
    ];
    stopWords.forEach((w) => {
      t = t.replace(new RegExp(`\\b${w}\\b`, "g"), "");
    });
    return t.replace(/\s+/g, " ").trim();
  }

  function highlight(text, query) {
    if (!query) return escapeHtml(text);
    let safeText = escapeHtml(text);
    const tokens = query.split(" ").filter((t) => t.length > 0);

    tokens.forEach((token) => {
      const regex = new RegExp(`(${escapeHtml(token)})`, "gi");
      safeText = safeText.replace(regex, "<b>$1</b>");
    });

    return safeText;
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

  async function loadCities() {
    currentCities = await offlineDB.getCities();
    citySelect.innerHTML = '<option value="">— Выберите город —</option>';
    currentCities.forEach((c) => {
      const opt = document.createElement("option");
      opt.value = String(c.id);
      opt.textContent = c.name;
      citySelect.appendChild(opt);
    });

    if (pendingCityId) {
      citySelect.value = String(pendingCityId);
      pendingCityId = null;
      if (!readOnly) {
        searchWrap.style.display = "block";
      }
    } else {
      const defaultCity = await offlineDB.getConfig("default_city_id");
      if (
          defaultCity &&
          currentCities.some((c) => String(c.id) === String(defaultCity))
      ) {
        citySelect.value = String(defaultCity);
        if (!readOnly) handleCityChange();
      }
    }
  }

  function handleCityChange() {
    const cityId = citySelect.value;
    if (!cityId) {
      searchWrap.style.display = "none";
      selectedData = null;
      onChange(null);
      return;
    }
    if (readOnly) return;

    searchWrap.style.display = "block";
    searchInput.value = "";
    selectedData = null;
    onChange(null);
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

  function renderDropdown(results) {
    dropdown.innerHTML = "";
    focusableElements = [];
    activeIndex = -1;

    const cityId = citySelect.value;
    const rawQuery = searchInput.value.trim();
    const query = normalize(rawQuery);

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

    grouped.forEach((group) => {
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
        pill.innerHTML = highlight(
            elev.object_name || elev.display_name.split(", ").pop(),
            query,
        );

        pill.onclick = () => selectAddress(elev, "elevator");
        focusableElements.push(pill);
        pillsWrap.appendChild(pill);
      });

      groupEl.appendChild(pillsWrap);
      dropdown.appendChild(groupEl);
    });

    if (results.length === 50) {
      const footer = document.createElement("div");
      footer.style.cssText =
          "padding: 8px; font-size: 11px; color: var(--text-secondary); text-align: center; background: var(--bg-primary);";
      footer.textContent = "Показаны первые 50 результатов. Уточните запрос.";
      dropdown.appendChild(footer);
    }

    showDropdown();
  }

  function selectAddress(item, type) {
    const isHouse = type === "house";
    selectedData = {
      city_id: item.city_id,
      street_id: item.street_id,
      home_id: item.home_id,
      object_id: isHouse ? null : item.id,
      address: isHouse ? item.house_display : item.display_name,
    };
    searchInput.value = selectedData.address;
    hideDropdown();
    onChange(selectedData);
  }

  let debounceTimer = null;

  async function triggerSearch(val) {
    const cityId = parseInt(citySelect.value, 10);
    if (!cityId) return;
    const q = normalize(val);
    const results = await offlineDB.searchAddresses(cityId, q);
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
    if (selectedData && val === selectedData.address) {
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
    setValue: (val) => {
      if (!val) return;
      selectedData = val;
      searchInput.value = val.address;
      searchWrap.style.display = "block";

      const stringCityId = String(val.city_id);
      if (citySelect.options.length > 1) {
        citySelect.value = stringCityId;
      } else {
        pendingCityId = stringCityId;
      }
      onChange(selectedData);
    },
    destroy: () => {
      if (debounceTimer) clearTimeout(debounceTimer);

      // Удаляем глобальные слушатели
      window.removeEventListener("resize", onWindowResize);
      window.removeEventListener("scroll", onWindowScroll, true);
      document.removeEventListener("click", onDocClick);

      // Удаляем подложку
      backdrop.removeEventListener("click", onBackdropClick);
      if (backdrop.parentNode) {
        backdrop.parentNode.removeChild(backdrop);
      }
    },
  };
}