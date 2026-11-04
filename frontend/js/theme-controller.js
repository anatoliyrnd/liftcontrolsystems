/**
 * Класс управления темами оформления (Светлая / Темная)
 *
 * Слушатель клика на кнопке — именованная функция (bound method),
 * чтобы unmount мог его снять. Раньше был анонимный listener —
 * при пересоздании контроллера (смена организации, hot reload)
 * он копился бы на одном и том же DOM-элементе.
 */
export class ThemeController {
  /**
   * @param {string} toggleBtnId - ID кнопки переключения в HTML
   */
  constructor(toggleBtnId) {
    this.toggleBtn = document.getElementById(toggleBtnId);
    this._onToggleClick = this._onToggleClick.bind(this);
    if (!this.toggleBtn) return;
    this.init();
  }

  init() {
    // Считываем сохраненную тему или ставим по умолчанию светлую
    const savedTheme = localStorage.getItem("theme") || "light";
    document.documentElement.setAttribute("data-theme", savedTheme);

    this.toggleBtn.addEventListener("click", this._onToggleClick);
  }

  _onToggleClick() {
    const currentTheme = document.documentElement.getAttribute("data-theme");
    const newTheme = currentTheme === "dark" ? "light" : "dark";

    document.documentElement.setAttribute("data-theme", newTheme);
    localStorage.setItem("theme", newTheme);
  }

  unmount() {
    if (this.toggleBtn) {
      this.toggleBtn.removeEventListener("click", this._onToggleClick);
      this.toggleBtn = null;
    }
  }
}
