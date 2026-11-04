import { createValidatedTextarea } from "../../components/validated-textarea.js";
import { VALIDATION } from "../../config.js";

/**
 * Управляет формой закрытия заявки.
 * Заменяет обычный textarea на validated-компонент с голосовым вводом
 * и встроенной проверкой на капс и минимальную длину.
 */
export function createCloseForm({ onChange }) {
  const container = document.getElementById("closeBlock");
  const originalTextarea = document.getElementById("solutionInput");
  const check = document.getElementById("closeAndCreateCheck");

  if (!container || !originalTextarea || !check) {
    return { destroy: () => {} };
  }

  // Убираем старый блок с предупреждением о капсе,
  // так как createValidatedTextarea создает свой собственный.
  const oldWarn = document.getElementById("capsWarnSolution");
  if (oldWarn) oldWarn.remove();

  const textarea = createValidatedTextarea({
    placeholder: `Опишите, что было сделано (минимум ${VALIDATION.MIN_SOLUTION_LEN} символов)...`,
    rows: 3,
    minLength: VALIDATION.MIN_SOLUTION_LEN,
    voice: true,
    onChange: () => onChange(),
  });

  // Заменяем старый textarea на новый компонент
  originalTextarea.parentNode.replaceChild(textarea.element, originalTextarea);

  return {
    getValue: () => ({
      solution: textarea.getValue(),
      shouldCreateNew: check.checked,
    }),
    isValid: () => textarea.isValid(),
    focus: () => textarea.focus(),
    destroy: () => {
      textarea.destroy();
    },
  };
}
