/**
 * Класс управления темами оформления (Светлая / Темная)
 */
export class ThemeController {
    /**
     * @param {string} toggleBtnId - ID кнопки переключения в HTML
     */
    constructor(toggleBtnId) {
        this.toggleBtn = document.getElementById(toggleBtnId);
        if (!this.toggleBtn) return;

        this.init();
    }

    init() {
        // Считываем сохраненную тему или ставим по умолчанию светлую
        const savedTheme = localStorage.getItem('theme') || 'light';
        document.documentElement.setAttribute('data-theme', savedTheme);

        this.toggleBtn.addEventListener('click', () => {
            const currentTheme = document.documentElement.getAttribute('data-theme');
            const newTheme = currentTheme === 'dark' ? 'light' : 'dark';

            document.documentElement.setAttribute('data-theme', newTheme);
            localStorage.setItem('theme', newTheme);
        });
    }
}
