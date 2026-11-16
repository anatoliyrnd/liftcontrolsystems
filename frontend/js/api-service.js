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

// Лок общий для всех вкладок origin: refresh-токен один на браузер
// (httpOnly cookie). Grace-окно сервера закрывает гонку и без лока,
// лок убирает лишние ротации и мусорные строки access.
const REFRESH_LOCK = "lift-auth-refresh";

// Защита от отсутствующего значения: NaN в setTimeout срабатывает
// немедленно и абортит ожидание лока на старте.
const REQUEST_TIMEOUT_MS = Number(API?.REQUEST_TIMEOUT_MS) || 15000;

// Ожидание лока больше границы одного запроса: иначе ожидающий
// абортится, пока держатель легитимно работает.
const LOCK_WAIT_MS = REQUEST_TIMEOUT_MS + 5000;

// Сквозной бюджет цепочки 401 → refresh → retry. Без него сроки
// складываются (T + T+5 + T + T ≈ 50 с спиннера), и пользователь
// видит «загрузку» вместо ошибки.
const CHAIN_BUDGET_MS = REQUEST_TIMEOUT_MS * 2;

// Только эти коды означают потерю сессии. Всё прочее — транспорт:
// разлогин по сетевому чиху выбрасывал бы пользователя без причины.
// invalid_credentials — на будущее: сейчас его отдаёт только login,
// но «пользователь исчез» не должен становиться вечным offline.
const AUTH_FAIL_CODES = new Set([
  "token_expired",
  "token_invalid",
  "missing_token",
  "user_blocked",
  "device_mismatch",
  "invalid_credentials",
]);

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

  /**
   * Обновление сессии: мьютекс вкладки + межвкладочный лок.
   *
   * Возвращает { ok, kind, code }, а не bool: вызывающий обязан
   * отличать отказ авторизации от транспортного сбоя и разлогинивать
   * только по первому.
   *
   * Проверки «не обновил ли кто access, пока ждали» нет намеренно:
   * access лежит в памяти вкладки, чужой refresh её не наполняет.
   */
  async _refreshSession(deadlineAt = null) {
    if (this._refreshPromise) return this._refreshPromise;

    const deadline = deadlineAt ?? Date.now() + CHAIN_BUDGET_MS;

    this._refreshPromise = this._withRefreshLock(
      () => this._doRefresh(deadline),
      deadline,
    ).finally(() => {
      this._refreshPromise = null;
    });

    return this._refreshPromise;
  }

  /**
   * Web Locks в режиме ожидания (не ifAvailable, как в sync-manager):
   * пропустить refresh нельзя — вкладка останется без access.
   *
   * signal ограничивает именно ОЖИДАНИЕ: замороженная браузером
   * вкладка держит лок неограниченно, и без таймаута foreground-
   * вкладка встанет насмерть с чистой консолью.
   *
   * Три исхода отказа различаются сознательно:
   *   тело выполнялось → транспорт, повтора быть не должно;
   *   аборт в ожидании → транспорт, БЕЗ разлокированного повтора
   *                      (иначе таймаут сам создавал бы гонку);
   *   сломан API локов → однократный fn(), это деградация.
   */
  async _withRefreshLock(fn, deadline) {
    if (!navigator.locks?.request) return fn();

    const wait = Math.min(LOCK_WAIT_MS, deadline - Date.now());
    if (wait <= 0) return { ok: false, kind: "transport", code: "aborted" };

    const ac = new AbortController();
    const timer = setTimeout(() => ac.abort(), wait);
    let bodyRan = false;

    try {
      return await navigator.locks.request(
        REFRESH_LOCK,
        { mode: "exclusive", signal: ac.signal },
        async () => {
          // Ожидание кончилось — дальше границу задаёт таймаут fetch.
          clearTimeout(timer);
          bodyRan = true;
          return fn();
        },
      );
    } catch (e) {
      if (bodyRan || ac.signal.aborted) {
        return { ok: false, kind: "transport", code: "aborted" };
      }
      console.warn("[ApiService] Web Locks недоступны:", e);
      return fn();
    } finally {
      clearTimeout(timer);
    }
  }

  /** Тело refresh. Никогда не бросает — вызывающий ждёт { ok, kind, code }. */
  async _doRefresh(deadline) {
    try {
      const resp = await this._sendPostRequest(
        AUTH.LOGIN_URL + "?action=refresh",
        {},
        "Обновление сессии...",
        null,
        /* skipAuthHandling */ true,
        { deadline, isRefresh: true },
      );
      if (resp && resp.status === "ok" && resp.access_token) {
        authStore.setSession(resp.access_token, resp.expires_at, resp.user);
        return { ok: true };
      }
      // skipAuthHandling гасит и rate_limited-ветку, поэтому
      // классифицируем сами: иначе 429 прилетел бы как отказ
      // авторизации и разлогинил.
      const code = resp?.code || resp?.error?.code || "";
      if (AUTH_FAIL_CODES.has(code)) {
        return { ok: false, kind: "auth", code };
      }
      // Неклассифицированный код — аномалия, а не «сеть упала».
      // Молча превращать его в вечный offline нельзя.
      if (code && code !== "network_error" && code !== "aborted") {
        console.warn("[ApiService] Неклассифицированный отказ refresh:", code);
      }
      return { ok: false, kind: "transport", code };
    } catch (e) {
      return { ok: false, kind: "transport", code: "exception" };
    }
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
    internal = null,
  ) {
    // internal = { deadline, isRefresh } — только для внутренних вызовов
    // (refresh и retry), наружный контракт метода не меняется.
    //
    // Дедлайн сквозной: refresh и retry наследуют бюджет родителя,
    // иначе цепочка складывает таймауты в ~50 секунд спиннера.
    const deadline = internal?.deadline ?? Date.now() + CHAIN_BUDGET_MS;
    const remaining = deadline - Date.now();
    if (remaining <= 0) {
      return {
        status: "error",
        code: "aborted",
        reason: "timeout",
        offline: true,
        message: "Превышено время ожидания ответа сервера.",
      };
    }

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
    }, Math.min(REQUEST_TIMEOUT_MS, remaining));
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
          // isRefresh — второй, независимый барьер реентерабельности.
      // Инстансный флаг для этого не годится: он погасил бы обработку
      // 401 у параллельных запросов, которые как раз должны дождаться
      // refresh и повториться. Барьер — на вызов, не на объект.
      if (
        data &&
        data.status === "error" &&
        !skipAuthHandling &&
        internal?.isRefresh !== true
      ) {
        if (AUTH.BYPASS_AUTH) {
          return data;
        }

        const code = data.code || data.error?.code || "";

        if (
          code === "token_expired" ||
          code === "missing_token" ||
          code === "token_invalid"
        ) {
                    // Сетевая фаза оригинала завершена, JSON разобран. Таймер
          // дальше не нужен: иначе он сработает во время ожидания
          // лока и выставит timedOut, размывая семантику флага.
          clearTimeout(timeoutId);

          const refresh = await this._refreshSession(deadline);
          if (refresh.ok) {
            // reportSuccess здесь избыточен: refresh уже отчитался
            // своим запросом, retry отчитается своим. Одна логическая
            // операция не должна давать два события успеха.
            return this._sendPostRequest(
              url,
              payloadData,
              actionComment,
              tag,
              true,
              { deadline },
            );
          }
          if (refresh.kind === "auth") {
            networkLed.reportFailure();
            // Код refresh, а не оригинала: слушатели различают
            // «истекло» и «заблокирован», им нужно реальное основание.
            this._emitAuthLost(refresh.code || code);
            data._authLost = true;
            return data;
          }
          // Транспорт: refresh-токен мог остаться валидным, сессия не
          // потеряна. Отдаём offline-класс — SyncManager поставит
          // cooldown и оставит команду pending вместо разлогина.
          networkLed.reportFailure();
          return {
            status: "error",
            code: "network_error",
            offline: true,
            message: "Не удалось обновить сессию: сервер недоступен.",
          };
        }

        if (code === "device_mismatch" || code === "user_blocked") {
          networkLed.reportFailure();
          this._emitAuthLost(code);
          data._authLost = true;
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
      window.dispatchEvent(new CustomEvent("app:network-success"));
      networkLed.reportSuccess();
      return data;
    } catch (err) {
      if (err.name === "AbortError") {
        if (timedOut) {
          window.dispatchEvent(new CustomEvent("app:network-error"));
        }
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

      window.dispatchEvent(new CustomEvent("app:network-error"));

      return {
        status: "error",
        code: "network_error",
        offline: true, // ← ключевой флаг для SyncManager
        message: "Ошибка сети: " + (err.message || "неизвестная ошибка"),
      };
    } finally {
      // Единственное место снятия таймаута. Раньше он снимался сразу
      // после fetch — по заголовкам, и зависшее тело (.json()) висело
      // бесконечно. Под refresh-локом это deadlock всех вкладок.
      clearTimeout(timeoutId);
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

  /** main.js ждёт bool — внутренний контракт { ok, kind } наружу не отдаём. */
  async tryAutoLogin() {
    const refresh = await this._refreshSession();
    return refresh.ok === true;
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
