/**
 * Текстовый индикатор состояния API.
 * Отображает текст загрузки в блоке «История».
 * Спиннер убран, так как он уже есть в левом нижнем углу (networkLed).
 */
export const apiStatus = {
  _loadingCount: 0,
  _lastMessage: "",

  _el() {
    return document.getElementById("apiStatusBlock");
  },

  _render() {
    const block = this._el();
    if (!block) return;

    if (this._loadingCount > 0) {
      // Безопасно: createElement + textContent, без innerHTML с интерполяцией
      let span = block.querySelector("#apiStatusText");
      if (!span) {
        span = document.createElement("span");
        span.id = "apiStatusText";
        block.textContent = "";
        block.appendChild(span);
      }
      span.textContent = this._lastMessage;
      block.style.visibility = "visible";
    } else {
      block.style.visibility = "hidden";
      block.textContent = "";
    }
  },

  show(message = "Обработка...") {
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
    this._lastMessage = "";
    this._render();
  },
};
