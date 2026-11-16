import { SEL } from "../selectors.js";

/**
 * Профиль. Единственное разрешённое программное действие тура —
 * раскрытие <details>: это UI-состояние, данные не меняются.
 */
export function profileSteps() {
    return [
        {
            element: SEL.profileSummary,
            popover: {
                title: "Настройка таблицы",
                description:
                    "Блок свёрнут. Нажмите «Далее» — тур раскроет его и покажет список колонок.",
            },
        },
        {
            element: SEL.profileList,
            popover: {
                title: "Порядок и видимость колонок",
                description:
                    "Галочка слева скрывает колонку, стрелки ↑ и ↓ справа меняют её позицию в журнале. Колонки «№» и «Адрес» закреплены — их нельзя скрыть или сдвинуть. Настройки применяются к тому журналу, из которого вы пришли в профиль.",
            },
        },
        {
            element: SEL.profileSave,
            popover: {
                title: "Сохранение",
                description:
                    "Изменения применяются только после этой кнопки. Порядок и видимость колонок привязываются к аккаунту, ширины и сортировка остаются на этом устройстве.",
            },
        },
    ];
}

/** Раскрыть блок настроек перед показом второго шага. */
export function expandProfileBlock() {
    const details = document
        .querySelector(SEL.profileList)
        ?.closest("details");
    if (details) details.open = true;
}

/** Свернуть при входе в сценарий — чтобы первый шаг был осмысленным. */
export function collapseProfileBlock() {
    const details = document
        .querySelector(SEL.profileList)
        ?.closest("details");
    if (details) details.open = false;
}