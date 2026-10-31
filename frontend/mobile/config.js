/**
 * Глобальные константы проекта.
 */
export const API = {
  URL: "../test_calls.php",
  REQUEST_TIMEOUT_MS: 15000,
  TICKETS_REFRESH_MS: 5 * 60 * 1000, // 5 минут
};

export const AUTH = {
  BYPASS_AUTH: true, // <--- ВЫКЛЮЧИТЬ (false) ДЛЯ ПРОДА
  USE_STUB: true,
  LOGIN_URL: "../auth_stub.php",
  USER_STORAGE_KEY: "lift_auth_user",
  ROLES: {
    ADMIN: "administrator",
    DISPATCHER: "dispatcher",
    ENGINEER: "engineer",
    GUEST: "guest",
    RESERVED: "reserved",
  },
};

export const PHOTO = {
  MAX_BYTES: 5 * 1024 * 1024, // 5 МБ
  MAX_WIDTH: 800,
  QUALITY: 0.6,
  COMPRESS_TIMEOUT_MS: 20000,
};
