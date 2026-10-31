/**
 * Текстовый индикатор состояния API.
 * Отображает текст загрузки в блоке «История».
 * Спиннер убран, так как он уже есть в левом нижнем углу (networkLed).
 */
export const apiStatus = {
    _loadingCount: 0,
    _lastMessage: '',

    _el() {
        return document.getElementById('apiStatusBlock');
    },

    _render() {
        const block = this._el();
        if (!block) return;

        if (this._loadingCount > 0) {
            // Показываем текст, но не меняем поток документа
            block.innerHTML = `<span id="apiStatusText">${this._lastMessage}</span>`;
            block.style.visibility = 'visible';
        } else {
            // Скрываем через visibility, чтобы блок сохранял свое место
            block.style.visibility = 'hidden';
            block.innerHTML = '';
        }
    },

    show(message = 'Обработка...') {
        this._loadingCount += 1;
        this._lastMessage = message;
        this._render();
    },

    hide() {
        this._loadingCount = Math.max(0, this._loadingCount - 1);
        this._render();
    },

    reset() {
        this._loadingCount = 0;
        this._lastMessage = '';
        this._render();
    }
};