import { SEL } from "../selectors.js";

/**
 * Карточка заявки.
 *
 * Вариант C запрещает изменение данных, но НЕ переключение UI-состояния:
 * открытие формы правки и блока решения — то же, что раскрытие <details>
 * в профиле. Поэтому тур открывает их программно и показывает поля.
 *
 * Клики по слотам, выбор значений и нажатие «Сохранить»/«Закрыть»
 * не выполняются: это меняет данные. Кнопка сохранения дополнительно
 * заблокирована disableActiveInteraction: "clicks".
 */
export function ticketSteps() {
    return [
        {
            element: SEL.ticketHeader,
            popover: {
                title: "Карточка заявки",
                description:
                    "Номер, статус и адрес объекта. Ниже — описание проблемы, справочники, ответственные и история работы. Адрес изменить нельзя: при ошибке в адресе заявку закрывают и создают новую.",
            },
        },
        {
            element: SEL.editBtn,
            popover: {
                title: "Редактирование",
                description:
                    "Ответственный, срок ремонта и описание меняются только через эту кнопку. Нажмите «Далее» — тур откроет форму и покажет её поля. Ничего не сохранится.",
            },
        },
        {
            element: SEL.editDetails,
            popover: {
                title: "Дополнить описание",
                description:
                    "Текст добавляется к исходному описанию, а не заменяет его. Так сохраняется история: что было известно при регистрации и что выяснилось позже.",
            },
        },
        {
            element: SEL.staffSlots,
            popover: {
                title: "Ответственный и уведомление",
                description:
                    "До трёх механиков на заявку. Клик по слоту выбирает механика из списка; рядом ставится канал уведомления — если вы позвонили, выберите «По телефону». Пока статус не отмечен, слот подсвечивается как «Не уведомлён».",
            },
        },
        {
            element: SEL.editRepair,
            popover: {
                title: "Срок ремонта",
                description:
                    "Выберите готовый интервал или нажмите иконку календаря — откроется системный выбор даты. Просроченный срок подсвечивает номер заявки красным в журнале.",
            },
        },
        {
            element: SEL.cardSaveBtn,
            popover: {
                title: "Сохранение изменений",
                description:
                    "Изменения уйдут на сервер только после этой кнопки. Во время обучения она заблокирована. Без связи правки сохранятся локально и отправятся при восстановлении сети.",
            },
        },
        {
            element: SEL.cancelEditBtn,
            popover: {
                title: "Отмена",
                description:
                    "Возвращает исходные значения и закрывает форму. Нажмите «Далее» — тур отменит правку и перейдёт к закрытию заявки.",
            },
        },
        {
            element: SEL.notes,
            popover: {
                title: "Рабочий чат",
                description:
                    "Комментарии по ходу работ: «выехал», «на месте», «нужна запчасть». Минимум 6 символов. Заметки видны всем, кто работает с заявкой, и сохраняются в истории после закрытия.",
            },
        },
        {
            element: SEL.closeBtn,
            popover: {
                title: "Закрытие заявки",
                description:
                    "Нажмите «Далее» — тур откроет блок решения и покажет его поля. Заявка при этом не закроется.",
            },
        },
        {
            element: SEL.solutionInput,
            popover: {
                title: "Решение",
                description:
                    "Опишите, что было сделано: «Заменён предохранитель, кабина освобождена». Минимум 6 символов. Текст попадёт в журнал закрытых и в историю объекта.",
            },
        },
        {
            element: SEL.solutionMic,
            popover: {
                title: "Голосовой ввод",
                description:
                    "Если руки заняты — надиктуйте решение. Браузер запросит разрешение на микрофон при первом использовании. Распознавание идёт средствами браузера, интернет для него нужен.",
            },
        },
        {
            element: SEL.closeAndCreate,
            popover: {
                title: "Закрыть и создать новую",
                description:
                    "Галочка закрывает текущую заявку и сразу открывает форму новой по тому же адресу. Используйте, когда работа выполнена, но объект требует повторного выезда. Закрытие финально — переоткрыть заявку нельзя.",
            },
        },
    ];
}

/** Открыть форму правки перед показом её полей. */
/** Элемент существует И видим (не display:none / не нулевой размер). */
function isVisible(selector) {
    const el = document.querySelector(selector);
    if (!el) return false;
    return el.offsetParent !== null || el.getClientRects().length > 0;
}

/** Открыть форму правки перед показом её полей. */
export function openEditMode() {
    if (isVisible(SEL.editDetails)) return;
    const btn = document.querySelector(SEL.editBtn);
    if (!btn) return;
    // dispatchEvent обходит hit-test оверлея driver.js:
    // событие доставляется прямо в элемент, минуя проверку координат.
    btn.dispatchEvent(new MouseEvent("click", { bubbles: true, cancelable: true }));
}

/** Закрыть форму правки без сохранения. */
export function cancelEditMode() {
    if (!isVisible(SEL.editDetails)) return;
    const btn = document.querySelector(SEL.cancelEditBtn);
    if (btn) btn.dispatchEvent(new MouseEvent("click", { bubbles: true, cancelable: true }));
}

/** Открыть блок решения перед показом его полей. */
export function openCloseBlock() {
    if (isVisible(SEL.solutionInput)) return;
    const btn = document.querySelector(SEL.closeBtn);
    if (btn) btn.dispatchEvent(new MouseEvent("click", { bubbles: true, cancelable: true }));
}