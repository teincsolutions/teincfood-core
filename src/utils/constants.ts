/**
 * Application-wide constants — plain config, no expo dependencies.
 * Values can be overridden via createTeincCore config (future).
 */

/** Base URL for the API — set at runtime via createTeincCore({ apiBaseUrl }) from the host app's .env */
export let API_BASE_URL = "http://localhost:4000/api/v1";

/** WebSocket URL for Phoenix Channels — set at runtime via createTeincCore({ wsBaseUrl }) */
export let WS_BASE_URL = "ws://localhost:4000";

export function setApiBaseUrl(url: string | undefined): void {
  if (url) {
    API_BASE_URL = url;
    try {
      console.debug("[core:constants] API_BASE_URL set", url);
    } catch {}
  } else {
    try {
      console.debug("[core:constants] API_BASE_URL using default", API_BASE_URL);
    } catch {}
  }
}

export function setWsBaseUrl(url: string | undefined): void {
  if (url) {
    WS_BASE_URL = url;
    try {
      console.debug("[core:constants] WS_BASE_URL set", url);
    } catch {}
  } else {
    try {
      console.debug("[core:constants] WS_BASE_URL using default", WS_BASE_URL);
    } catch {}
  }
}

/** App metadata */
export const APP_NAME = "Teinc Food Business";
export const APP_VERSION = "1.0.0";

/** Async storage keys */
export const STORAGE_KEYS = {
  AUTH_TOKEN: "auth_token",
  REFRESH_TOKEN: "refresh_token",
  USER_PROFILE: "user_profile",
  HAS_SEEN_ONBOARDING: "has_seen_onboarding",
  THEME_PREFERENCE: "theme_preference",
  BUSINESS_DATA: "business_data",
  FLEET_DATA: "fleet_data",
  LOCAL_NODE_DATA: "local_node_data",
  PRINTER_SETTINGS: "printer_settings",
} as const;

/** Chat storage keys */
export const CHAT_STORAGE_KEYS = {
  MESSAGES: "chat_messages",
  OUTBOX: "chat_outbox",
} as const;

/** Chat configuration */
export const CHAT_CONFIG = {
  HEARTBEAT_INTERVAL_MS: 15_000,
  HEARTBEAT_TIMEOUT_MS: 10_000,
  RECONNECT_BASE_DELAY_MS: 1_000,
  RECONNECT_MAX_DELAY_MS: 30_000,
  RECONNECT_MAX_ATTEMPTS: 10,
  TYPING_TIMEOUT_MS: 3_000,
  MESSAGE_PAGE_SIZE: 50,
} as const;

/** OTP configuration */
export const OTP_LENGTH = 4;
export const OTP_RESEND_DELAY_SECONDS = 60;

/** Pagination defaults */
export const DEFAULT_PAGE_SIZE = 20;

/**
 * Max time the Sync Engine waits for a cloud command before treating the cloud
 * as unreachable and falling back to the Local Node or the offline outbox.
 * Keeps the terminal responsive (fast) even when the internet is slow.
 */
export const CLOUD_COMMAND_TIMEOUT_MS = 2_500;

// Expo version removed; expose static version for now
export const appVersion = APP_VERSION;

/** Default config bundle for createTeincCore overrides */
export const DEFAULTS = {
  API_BASE_URL,
  WS_BASE_URL,
  APP_NAME,
  APP_VERSION,
  STORAGE_KEYS,
  CHAT_STORAGE_KEYS,
  CHAT_CONFIG,
  OTP_LENGTH,
  OTP_RESEND_DELAY_SECONDS,
  DEFAULT_PAGE_SIZE,
  CLOUD_COMMAND_TIMEOUT_MS,
} as const;
