/**
 * Обучающий тур по интерфейсу (driver.js).
 *
 * Запуск — только ручной, из меню пользователя. Автоматического показа
 * при первом входе нет: пользователь контролирует, когда начать обучение.
 *
 * Сценарии: #/ (журнал), #/closed, #/create, #/ticket/:id, #/profile.
 * Остальные экраны (#/queue, #/settings, #/login) — info-тост.
 *
 * Шаги без найденного элемента пропускаются молча: пользователь мог
 * скрыть колонку в настройках, и это не должно ломать весь тур.
 * Если после фильтрации не осталось ни одного шага — тост об отсутствии
 * тура для текущего экрана.
 *
 * driver.js и driver.css загружаются лениво из vendor/ при первом запуске
 * и не попадают в основной бандл.
 */

/** Активный инстанс driver.js. null — тур не запущен. */
let driverObj = null;
let driverLib = null;
let cssLoaded = false;

/** Слушатель hashchange, снимаемый при закрытии тура. */
let hashChangeListener = null;

// =========================================================================
// СЦЕНАРИИ
// =========================================================================

const tourHome = [
  {
    element: '[data-tour="create-btn"]',
    popover: {
      title: "Новая заявка",
      description: "Нажмите сюда, чтобы создать заявку.",
      side: "bottom",
      align: "center",
    },
  },
  {
    element: "#searchInput",
    popover: {
      title: "Быстрый поиск",
      description: "Ищите заявки по номеру, адресу или имени ответственного.",
    },
  },
  {
    element: "#openOnlyFilters",
    popover: {
      title: "Фильтрация",
      description:
        "Оставьте только нужные города или скройте долгосрочные заявки. Настройки сохраняются лично для вас.",
    },
  },
  // data-tour="table-sort" вешается в header-render.js на первый
  // сортируемый th — работает даже если пользователь скрыл «Дату».
  {
    element: '[data-tour="table-sort"]',
    popover: {
      title: "Сортировка",
      description:
        "Кликните по названию колонки, чтобы отсортировать заявки. Например, так можно вывести самые новые наверх.",
    },
  },
  // data-tour="table-resizer" — на ресайзере «Адреса», всегда виден.
  {
    element: '[data-tour="table-resizer"]',
    popover: {
      title: "Изменение ширины",
      description:
        "Нажмите и удерживайте границу заголовка, затем потяните влево или вправо.",
    },
  },
  {
    element: "#dataTable",
    popover: {
      title: "Журнал",
      description:
        "Красный — авария или просрочен срок. Жёлтый — нет механика. Оранжевый ⏳ — действие ждёт синхронизации. Кликните по строке, чтобы открыть карточку.",
    },
  },
];

const tourProfile = [
  {
    element: "#columnsSettingsList",
    popover: {
      title: "Настройка таблиц",
      description:
        "Скрывайте ненужные колонки галочками и меняйте их порядок стрелками.",
    },
  },
  {
    element: "#saveSettingsBtn",
    popover: {
      title: "Применение настроек",
      description:
        "Не забудьте нажать «Сохранить». Ваши настройки привяжутся к аккаунту и применятся при следующем входе.",
    },
  },
];

const tourCreate = [
  {
    element: "#formAddressSlot",
    popover: {
      title: "Выбор адреса",
      description:
        "Начните вводить улицу и дом. Обязательно выберите объект из выпадающего списка.",
    },
  },
  {
    element: "#formDetails",
    popover: {
      title: "Суть проблемы",
      description: "Опишите, что случилось.",
    },
  },
  {
    // createGroupSlot — первый из трёх селектов; parentElement — блок.
    element: "#createGroupSlot",
    popover: {
      title: "Категории",
      description:
        "Обязательно укажите Группу, Тип и Отдел. От этого зависит приоритет заявки.",
    },
  },
  {
    element: "#saveTicketBtn",
    popover: {
      title: "Создание",
      description:
        "После заполнения нажмите сюда. Если нет сети — заявка сохранится на устройстве и уйдёт на сервер позже.",
    },
  },
];

const tourTicket = [
  {
    element: '[data-tour="ticket-header"]',
    popover: {
      title: "Номер и статус",
      description: "Здесь виден номер, текущий статус и адрес объекта.",
    },
  },
  {
    element: "#staffSlotsContainer",
    popover: {
      title: "Назначение механика",
      description:
        "Нажмите на слот, чтобы назначить ответственного и отметить, что он уведомлён.",
    },
  },
  {
    element: "#noteComposer",
    popover: {
      title: "Рабочий чат",
      description: "Пишите сюда, когда механик выехал или прибыл на место.",
    },
  },
  {
    element: "#closeBtn",
    popover: {
      title: "Завершение работы",
      description:
        "Нажмите сюда, чтобы ввести решение. Пока заявка не закрыта — она висит в работе.",
    },
  },
];

// =========================================================================
// ИНФРАСТРУКТУРА
// =========================================================================

/**
 * Ленивая загрузка driver.js и CSS из vendor/.
 * При неудаче — выбрасывает ошибку, которую обработает startTour.
 */
async function loadDriver() {
    if (!driverLib) {
        const mod = await import('driver.js');
        driverLib = mod.driver;
    }
    if (!cssLoaded) {
        await import('driver.js/dist/driver.css');
        cssLoaded = true;
    }
    return driverLib;
}

/**
 * Пропускаем шаги, чьих элементов нет в DOM. Пользователь мог скрыть
 * колонку, форма могла ещё не отрисовать блок — тур не должен из-за
 * этого отменяться целиком.
 */
function filterAvailableSteps(steps) {
  return steps.filter((step) => {
    if (!step.element) return true;
    return document.querySelector(step.element) !== null;
  });
}

/** Принудительно закрыть активный тур. Вызывается из leaveAll(). */
export function stopTour() {
  if (driverObj) {
    try {
      driverObj.destroy();
    } catch (e) {
      /* driver.js уже уничтожен */
    }
    driverObj = null;
  }
  if (hashChangeListener) {
    window.removeEventListener("hashchange", hashChangeListener);
    hashChangeListener = null;
  }
}

// =========================================================================
// ПУБЛИЧНЫЙ API
// =========================================================================

/**
 * Запуск тура по текущему hash. Только ручной вызов — из меню пользователя.
 * Повторный клик во время тура — перезапускает (не плодит инстансы).
 */
export async function startTour() {
  // Динамический импорт notify, чтобы не тянуть его в чанк тура.
  const { notify } = await import("./components/notify.js");

  if (driverObj) stopTour();

  const currentHash = window.location.hash || "#/";
  let steps = [];

  if (currentHash.startsWith("#/ticket/")) {
    steps = tourTicket;
  } else if (currentHash === "#/create") {
    steps = tourCreate;
  } else if (currentHash === "#/profile") {
    steps = tourProfile;
  } else if (currentHash === "#/" || currentHash === "#/closed") {
    steps = tourHome;
  } else {
    notify.info(
      "Для этого экрана обучающий тур пока не разработан. Перейдите в Журнал заявок.",
    );
    return;
  }

  const available = filterAvailableSteps(steps);
  if (available.length === 0) {
    notify.info(
      "Интерфейс ещё загружается или для этого экрана нет доступных шагов.",
    );
    return;
  }

  const skipped = steps.length - available.length;
  if (skipped > 0) {
    console.log(`[tour] Пропущено ${skipped} шагов (элементы отсутствуют)`);
  }

  let driverFn;
  try {
    driverFn = await loadDriver();
  } catch (e) {
    console.error("[tour] Не удалось загрузить driver.js:", e);
    notify.error("Обучающий тур недоступен. Проверьте файлы приложения.");
    return;
  }

  driverObj = driverFn({
    showProgress: true,
    allowClose: true,
    overlayOpacity: 0.6,
    stagePadding: 6,
    popoverClass: "driver-tour-popover",
    nextBtnText: "Далее →",
    prevBtnText: "← Назад",
    doneBtnText: "Завершить",
    steps: available,
    onDestroyed: () => {
      driverObj = null;
      if (hashChangeListener) {
        window.removeEventListener("hashchange", hashChangeListener);
        hashChangeListener = null;
      }
    },
  });

  driverObj.drive();

  // Смена страницы во время тура — закрываем, чтобы не висел над новым DOM.
  hashChangeListener = () => stopTour();
  window.addEventListener("hashchange", hashChangeListener, { once: true });
}
