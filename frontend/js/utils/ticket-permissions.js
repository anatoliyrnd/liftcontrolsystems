/**
 * Единый источник истины по правам на заявку.
 *
 * Используется карточкой (details-controller._renderCard) и провайдером
 * контекстного меню журнала. Дублирование логики запрещено: два гейта
 * неизбежно разойдутся.
 *
 * Приоритет: серверные can_* → клиентский расчёт по роли и назначенности.
 * В списках can_* не приходят (§17 ⚠️), поэтому журнал всегда идёт
 * по клиентской ветке. В online-пути серверной проверки прав нет (§20) —
 * скрытие элементов это UX, а не защита.
 *
 * Известное ограничение: в списках нет staff_id2 / staff_id3 (§17 ⚠️).
 * Механик во втором или третьем слоте получит isAssigned = false.
 * Тот же баг действует для кнопок карточки; лечится на бэкенде.
 */
import { userStore } from "../user-store.js";

/** Заявка закрыта локально (ожидает синхронизации) или на сервере. */
function isClosedTicket(ticket) {
    return (
        ticket.type === "close" ||
        Number(ticket.call_status) === 1 ||
        ticket._isOfflineClose === true
    );
}

/** Локальная заявка, ещё не отправленная на сервер. */
function isOfflineTicket(ticket) {
    if (ticket.isOffline === true) return true;
    const id = ticket.id ?? ticket.call_number ?? "";
    return typeof id === "string" && id.startsWith("offline_");
}

/**
 * @param {Object} ticket — объект заявки из списка или карточки
 * @param {Object} [options]
 * @param {boolean} [options.pendingClose] — есть pending CloseTicket в outbox
 * @returns {{canView:boolean, canEdit:boolean, canClose:boolean, canComment:boolean}}
 */
export function resolveTicketPermissions(ticket, options = {}) {
    const denied = {
        canView: false,
        canEdit: false,
        canClose: false,
        canComment: false,
    };
    if (!ticket || typeof ticket !== "object") return denied;

    const isOffline = isOfflineTicket(ticket);
    // pendingClose делает заявку «закрытой» для UI: комментарий и правка
    // скрываются, как в карточке.
    const pendingClose = options.pendingClose === true;
    const isClosed = isClosedTicket(ticket) || pendingClose;
    const isOpen = !isClosed;

    const isAssigned = userStore.isAssignedTo(ticket, userStore.userId);

    // --- can_edit ---
    let canEdit;
    if (ticket.can_edit !== undefined) {
        canEdit = ticket.can_edit === true;
    } else {
        canEdit = userStore.can("add_details", { isAssigned });
    }
    canEdit = isOpen && !isOffline && !pendingClose && canEdit;

    // --- can_close ---
    let canClose;
    if (ticket.can_close !== undefined) {
        canClose = ticket.can_close === true;
    } else {
        // closureallowed захардкожен в 0 (§5.4), ветка почти мёртвая,
        // но паритет с карточкой держим.
        canClose =
            userStore.can("close_ticket", { isAssigned }) ||
            Number(ticket.closureallowed) === 1;
    }
    canClose = isOpen && !isOffline && !pendingClose && canClose;

    // --- can_comment ---
    // Без гейта !isOffline: офлайн-заявка комментарий получает,
    // enqueueComment сворачивает его в CreateTicket.payload (§9.2).
    let canComment;
    if (ticket.can_comment !== undefined) {
        canComment = ticket.can_comment === true;
    } else {
        canComment = true;
    }
    canComment = !isClosed && canComment;

    return {
        canView: true,
        canEdit,
        canClose,
        canComment,
    };
}

/** Экспорт предикатов для провайдера меню и копирования. */
export { isOfflineTicket, isClosedTicket };