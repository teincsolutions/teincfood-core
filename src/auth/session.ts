/**
 * Session lifecycle — single source for access-expired → refresh →
 * refresh-expired → logout across all host apps.
 *
 * Backend contract (verified against TeincFoodBackend):
 * - expired ACCESS token  → 401 + error.code "TOKEN_EXPIRED" (recoverable:
 *   refresh once, retry the call)
 * - expired/invalid REFRESH token → 401 + error.code "REFRESH_FAILED"
 *   ("Token has expired") or sibling session codes (not recoverable:
 *   clear auth → host routes to login)
 *
 * Host HTTP layers (axios interceptors, fetch wrappers) must NOT implement
 * their own refresh: they attach tokens + normalize errors, then delegate
 * classification to isAccessExpired/isSessionDead and recovery to
 * refreshSession()/clearAuth() here. refreshSession is single-flight because
 * the backend rotates refresh tokens — two concurrent refreshes with the
 * same token revoke each other and 401 the session.
 */

import {
  clearAuth,
  getRefreshToken,
  isLocalSessionActive,
  setAuthTokens,
} from "../adapters/auth";
import { getHttpClient } from "../adapters/http";
import { syncLogger } from "../utils/sync-logger";

/** Access token expired — recoverable via one refresh + retry. */
export const ACCESS_EXPIRED_CODE = "TOKEN_EXPIRED";

/**
 * Refresh/session dead — not recoverable, the user must sign in again.
 * Canonical set from the backend auth contract; keep in sync with
 * auth_controller.ex (REFRESH_FAILED) and plugs/auth.ex.
 */
export const SESSION_DEAD_CODES = [
  "REFRESH_FAILED",
  "TOKEN_INVALID",
  "SESSION_EXPIRED",
  "UNAUTHORIZED",
  "ACCOUNT_DISABLED",
] as const;

export interface AuthFailure {
  status?: number;
  code?: string;
  message?: string;
}

interface ErrorLike {
  status?: number;
  code?: unknown;
  message?: unknown;
  response?: {
    status?: number;
    data?: { error?: { code?: unknown; message?: unknown }; message?: unknown };
  };
  data?: { error?: { code?: unknown; message?: unknown }; message?: unknown };
}

/**
 * Transport-layer codes (axios / network stack) are never backend session
 * codes. NOTE: a plain UPPER_SNAKE check is NOT enough — ERR_NETWORK etc.
 * match it. Explicit denylist.
 */
const TRANSPORT_CODE_RE = /^(ERR_|ECONN|ETIMEDOUT|ENOTFOUND|EAI_|EHOST|ENET|EPIPE|OFFLINE)/;

function asString(v: unknown): string | undefined {
  return typeof v === "string" && v.length > 0 ? v : undefined;
}

/**
 * Normalize any error shape into { status, code, message }.
 * Handles: core ApiError ({status, code}), raw axios errors
 * ({response.status, response.data.error.code}), and host ApiError
 * wrappers ({status, data.error.code}). Transport codes (ERR_NETWORK,
 * ECONNABORTED, OFFLINE, …) are never backend codes and are dropped —
 * only UPPER_SNAKE body codes classify.
 */
export function extractAuthFailure(e: unknown): AuthFailure {
  const err = (e ?? {}) as ErrorLike;
  const status =
    typeof err.status === "number"
      ? err.status
      : err.response?.status;
  const bodyCode =
    asString(err.response?.data?.error?.code) ??
    asString(err.data?.error?.code);
  const rawCode = asString(err.code);
  const code =
    bodyCode ??
    (rawCode && !TRANSPORT_CODE_RE.test(rawCode) ? rawCode : undefined);
  const message =
    asString(err.response?.data?.error?.message) ??
    asString(err.response?.data?.message) ??
    asString(err.data?.error?.message) ??
    asString(err.message);
  return { status, code, message };
}

/** 401 + TOKEN_EXPIRED: access token dead, refresh may recover. */
export function isAccessExpired(f: AuthFailure): boolean {
  return f.status === 401 && f.code === ACCESS_EXPIRED_CODE;
}

/**
 * 401/403 + session-dead code: refresh token dead, logout required.
 * A 401 WITHOUT a code (proxy/gateway/HTML) is never session-dead — the
 * app keeps working offline instead of logging the user out mid-shift.
 */
export function isSessionDead(f: AuthFailure): boolean {
  if (f.status !== 401 && f.status !== 403) return false;
  if (!f.code) return false;
  return (SESSION_DEAD_CODES as readonly string[]).includes(f.code);
}

export interface SessionTokens {
  access_token: string;
  refresh_token: string;
}

/**
 * Marker key for the refresh call's request config. Host interceptors MUST
 * honor it (see hasAuthRetrySkip): the refresh request's own 401 must
 * reject immediately, never recurse into session handling.
 */
export const SKIP_AUTH_RETRY = "x-teinc-skip-auth-retry";

export function hasAuthRetrySkip(config: unknown): boolean {
  try {
    return (
      !!config &&
      typeof config === "object" &&
      (config as Record<string, unknown>)[SKIP_AUTH_RETRY] === true
    );
  } catch {
    return false;
  }
}

let inflight: Promise<SessionTokens | null> | null = null;

let offlineRecovery: (() => Promise<SessionTokens | null>) | null = null;

/**
 * Host apps register a device-license exchange here. It lets an offline
 * terminal recover from an expired/rotated refresh token without asking the
 * member to sign in again.
 */
export function setOfflineSessionRecoveryProvider(
  provider: (() => Promise<SessionTokens | null>) | null,
): void {
  offlineRecovery = provider;
}

async function tryOfflineRecovery(): Promise<SessionTokens | null> {
  if (!offlineRecovery) return null;
  try {
    return await offlineRecovery();
  } catch {
    return null;
  }
}

interface RefreshResponseBody {
  access_token?: string;
  refresh_token?: string;
  data?: { access_token?: string; refresh_token?: string };
}

/**
 * Single-flight refresh. Returns fresh tokens (stored via provider) or
 * null. Calls clearAuth() (→ host logout) when the backend reports the
 * refresh token itself expired, or when no refresh token exists.
 * Never throws — callers treat null as "unrecoverable, surface original".
 */
async function doRefresh(): Promise<SessionTokens | null> {
  try {
    const rt = getRefreshToken();
    if (!rt) {
      const recovered = await tryOfflineRecovery();
      if (recovered) return recovered;
      if (!isLocalSessionActive()) clearAuth();
      return null;
    }
    const http = getHttpClient();
    const res = await http.post<RefreshResponseBody>(
      "/auth/refresh",
      { refresh_token: rt },
      { [SKIP_AUTH_RETRY]: true },
    );
    const body = (res?.data ?? {}) as RefreshResponseBody;
    const at = body.access_token ?? body.data?.access_token;
    const nrt = body.refresh_token ?? body.data?.refresh_token;
    if (!at || !nrt) {
      // 200 without tokens: ambiguous (proxy? shape drift?) — do NOT
      // logout on ambiguity; surface as unrecoverable for this call.
      syncLogger.warn("Session", "Refresh returned no tokens", {});
      return null;
    }
    setAuthTokens(at, nrt);
    return { access_token: at, refresh_token: nrt };
  } catch (e) {
    const failure = extractAuthFailure(e);
    if (isSessionDead(failure)) {
      const recovered = await tryOfflineRecovery();
      if (recovered) return recovered;
      syncLogger.warn("Session", "Refresh token expired — logging out", {
        code: failure.code,
      });
      try {
        clearAuth();
      } catch {}
    }
    return null;
  }
}

export async function refreshSession(): Promise<SessionTokens | null> {
  // NOTE: assign via .finally() — assigning the raw IIFE promise leaves a
  // stale settled value in `inflight` whenever the body takes a fully
  // synchronous path (e.g. missing refresh token), pinning every later
  // caller to that stale outcome forever.
  if (!inflight) {
    inflight = doRefresh().finally(() => {
      inflight = null;
    });
  }
  return inflight;
}

/**
 * Run fn; on access-expired, refresh once (single-flight) and retry once.
 * On unrecoverable session death, clearAuth has already run inside
 * refreshSession — the original error is rethrown for the caller to surface.
 */
export async function withAuthRetry<T>(fn: () => Promise<T>): Promise<T> {
  try {
    return await fn();
  } catch (e) {
    if (!isAccessExpired(extractAuthFailure(e))) throw e;
    const tokens = await refreshSession().catch(() => null);
    if (!tokens) throw e;
    return fn();
  }
}
