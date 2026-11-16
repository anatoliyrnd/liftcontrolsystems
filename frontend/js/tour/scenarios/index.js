import { journalSteps } from "./journal.js";
import { createSteps } from "./create.js";
import { ticketSteps } from "./ticket.js";
import { closedSteps } from "./closed.js";
import { queueSteps } from "./queue.js";
import { profileSteps } from "./profile.js";

/**
 * Реестр сценариев. Добавить экран = дописать модуль и одну строку здесь.
 * Движок (state.js / index.js) про具体内容 сценариев не знает.
 */
const BUILDERS = {
    journal: journalSteps,
    create: createSteps,
    ticket: ticketSteps,
    closed: closedSteps,
    queue: queueSteps,
    profile: profileSteps,
};

export function stepsFor(key) {
    const build = BUILDERS[key];
    return build ? build() : [];
}