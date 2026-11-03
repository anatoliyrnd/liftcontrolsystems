/**
 * Сетевой сервис SPA.
 *
 * Особенности:
 *   - Авто-заголовок Authorization, если токен установлен.
 *   - Все ответы приходят с HTTP 200 — код ошибки в data.code.
 *   - Перехват token_expired / missing_token → refresh → retry.
 *   - Mutex на refresh (один Promise для параллельных 401).
 *   - Отмена запросов по тегу (abortTag).
 */
import { API, AUTH } from "./config.js";
import { authStore } from "./auth-store.js";
import { networkLed } from "./components/network-led.js";
import { apiStatus } from "./components/api-status.js";
import { getWebGLFingerprint } from "./utils/webgl-fingerprint.js";

const AUTH_LOST_EVENT = "auth:lost";

export class ApiService {
  constructor(baseUrl = "", options = { local: false }) {
    this.baseUrl = baseUrl;
    this.isLocalMode = options.local || false;
    this._activeByTag = new Map();
    this._refreshPromise = null;
  }

  /** Установить access-токен. */
  setToken(token) {
    authStore.setAccess(token, authStore.getExpiresAt());
  }

  /** Событие потери сессии — на него подписывается main.js. */
  static get AUTH_LOST_EVENT() {
    return AUTH_LOST_EVENT;
  }

  _translateHttpCode(code) {
    switch (code) {
      case 404:
        return " - Страница не найдена! ";
      case 403:
        return " - Доступ запрещен! ";
      case 408:
        return " - Превышено время ожидания! ";
      case 500:
        return " - Ошибка сервера! ";
      case 502:
        return " - Ошибка шлюза! ";
      case 429:
        return " - Слишком много запросов! ";
      default:
        return " - Неизвестная ошибка ";
    }
  }

  _emitAuthLost(reason) {
    try {
      window.dispatchEvent(
        new CustomEvent(AUTH_LOST_EVENT, { detail: { reason } }),
      );
    } catch (e) {}
  }

  // ------------------------------------------------------------------
  // Refresh + mutex
  // ------------------------------------------------------------------
  async _refreshSession() {
    // Mutex: если refresh уже идёт — ждём тот же Promise
    if (this._refreshPromise) return this._refreshPromise;

    this._refreshPromise = (async () => {
      try {
        const resp = await this._sendPostRequest(
          AUTH.LOGIN_URL + "?action=refresh",
          {},
          "Обновление сессии...",
          null,
          /* skipAuthHandling */ true,
        );

        if (resp && resp.status === "ok" && resp.access_token) {
          authStore.setSession(resp.access_token, resp.expires_at, resp.user);
          return true;
        }
        return false;
      } catch (e) {
        return false;
      } finally {
        this._refreshPromise = null;
      }
    })();

    return this._refreshPromise;
  }

  // ------------------------------------------------------------------
  // Низкоуровневый POST
  // ------------------------------------------------------------------
  async _sendPostRequest(
    url,
    payloadData,
    actionComment = "",
    tag = null,
    skipAuthHandling = false,
  ) {
    networkLed.requestStarted();

    // actionComment === null → silent-запрос: не трогаем статус-бар вообще.
    const showStatus = actionComment !== null && actionComment !== undefined;
    if (showStatus) {
      apiStatus.show(actionComment || "Обработка...");
    }

    const controller = new AbortController();
    // Q8: флаг «наш abort был из-за таймаута».
    // Нужен, чтобы в catch отличить таймаут (offline: true → SyncManager
    // ставит cooldown) от ручного abort'а через abortTag (AUTH_LOST,
    // отмена по кнопке — offline: false, без cooldown).
    let timedOut = false;
    const timeoutId = setTimeout(() => {
      timedOut = true;
      controller.abort();
    }, API.REQUEST_TIMEOUT_MS);
    if (tag) {
      if (!this._activeByTag.has(tag)) this._activeByTag.set(tag, new Set());
      this._activeByTag.get(tag).add(controller);
    }

    const headers = {
      Accept: "application/json",
      "Content-Type": "application/json",
    };
    // Не отправляем токен, если включен режим тестирования
    if (!AUTH.BYPASS_AUTH) {
      const access = authStore.getAccess();
      if (access) headers["Authorization"] = "Bearer " + access;
    }
    try {
      const response = await fetch(url, {
        method: "POST",
        headers,
        credentials: "include", // для httpOnly cookie refresh
        body: JSON.stringify(payloadData),
        signal: controller.signal,
      });

      clearTimeout(timeoutId);

      // HTTP-ошибка на уровне сети
      if (!response.ok) {
        networkLed.reportFailure();
        return {
          status: "error",
          code: "http_" + response.status,
          message: response.status + this._translateHttpCode(response.status),
        };
      }
      // Q9: проверка Content-Type перед .json().
      // Если сервер вернул HTML (PHP-ошибка, error_handler вывел
      // warning в обход JSON), .json() бросит SyntaxError → catch
      // посчитал бы это network_error + offline: true → SyncManager
      // ушёл бы в cooldown, хотя сервер жив. Ошибка invalid_response
      // с offline: true — семантически «сервер недоступен, попробуем
      // позже», но без путаницы с «сеть упала».
      const contentType = (
        response.headers.get("Content-Type") || ""
      ).toLowerCase();
      if (!contentType.includes("application/json")) {
        networkLed.reportFailure();
        return {
          status: "error",
          code: "invalid_response",
          offline: true,
          message:
            "Сервер вернул не-JSON: " +
            response.status +
            " " +
            (response.statusText || "no status text"),
        };
      }

      const data = await response.json();

      // Ошибка внутри JSON
      if (data && data.status === "error" && !skipAuthHandling) {
        if (AUTH.BYPASS_AUTH) {
          return data;
        }

        const code = data.code || data.error?.code || "";

        if (
          code === "token_expired" ||
          code === "missing_token" ||
          code === "token_invalid"
        ) {
          const okRefresh = await this._refreshSession();
          if (okRefresh) {
            networkLed.reportSuccess();
            return this._sendPostRequest(
              url,
              payloadData,
              actionComment,
              tag,
              true,
            );
          } else {
            networkLed.reportFailure();
            this._emitAuthLost(code);
            return data;
          }
        }

        if (code === "device_mismatch" || code === "user_blocked") {
          networkLed.reportFailure();
          this._emitAuthLost(code);
          return data;
        }

        // Rate-limit: извлекаем retry_after, чтобы SyncManager мог
        // поставить cooldown на нужное время (API_PROTOCOL.md v4.2, разд. 11.3).
        if (code === "rate_limited") {
          const rawRetry =
            data.retry_after ??
            data.error?.details?.retry_after ??
            data.details?.retry_after ??
            60;
          const retryAfterSec = Math.max(1, parseInt(rawRetry, 10) || 60);
          data.retryAfterSec = retryAfterSec; // мутируем — вернётся вместе с data
          networkLed.reportFailure();
          return data;
        }
      }
      networkLed.reportSuccess();
      return data;
    } catch (err) {
      clearTimeout(timeoutId);

      if (err.name === "AbortError") {
        networkLed.reportAborted();
        if (timedOut) {
          return {
            status: "error",
            code: "aborted",
            reason: "timeout",
            offline: true,
            message: "Превышено время ожидания ответа сервера.",
          };
        }
        return { status: "error", code: "aborted", message: "Запрос отменён." };
      }

      networkLed.reportFailure();
      return {
        status: "error",
        code: "network_error",
        offline: true, // ← ключевой флаг для SyncManager
        message: "Ошибка сети: " + (err.message || "неизвестная ошибка"),
      };
    } finally {
      if (showStatus) {
        apiStatus.hide();
      }
      networkLed.requestFinished();

      if (tag) {
        const set = this._activeByTag.get(tag);
        if (set) {
          set.delete(controller);
          if (set.size === 0) this._activeByTag.delete(tag);
        }
      }
    }
  }

  abortTag(tag) {
    const set = this._activeByTag.get(tag);
    if (!set || set.size === 0) return;
    set.forEach((c) => c.abort());
    this._activeByTag.delete(tag);
  }

  async get(queryParams = null, actionComment = "", tag = null) {
    return this._sendPostRequest(
      this.baseUrl,
      queryParams || {},
      actionComment,
      tag,
    );
  }

  async post(body = {}, actionComment = "", tag = null) {
    return this._sendPostRequest(this.baseUrl, body, actionComment, tag);
  }

  // ------------------------------------------------------------------
  // Специальные методы авторизации
  // ------------------------------------------------------------------
  async login(name, password, autoLogin) {
    return this._sendPostRequest(
      AUTH.LOGIN_URL + "?action=login",
      {
        name,
        pname: password,
        webGL: getWebGLFingerprint(),
        autoLogin: !!autoLogin,
      },
      "Вход...",
      null,
      true,
    );
  }

  async loginById(userId, password, autoLogin) {
    return this._sendPostRequest(
      AUTH.LOGIN_URL + "?action=login",
      {
        user_id: userId,
        pname: password,
        webGL: getWebGLFingerprint(),
        autoLogin: !!autoLogin,
      },
      "Вход...",
      null,
      true,
    );
  }

  async tryAutoLogin() {
    return this._refreshSession();
  }

  async logout() {
    return this._sendPostRequest(
      AUTH.LOGIN_URL + "?action=logout",
      {},
      "Выход...",
      null,
      true,
    );
  }
}
