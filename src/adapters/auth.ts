/**
 * Auth store stub.
 */

export interface AuthUser {
  id: string;
  email?: string;
  full_name?: string | null;
  phone?: string | null;
  avatar_url?: string | null;
}

let user: AuthUser | null = null;

export function setAuthUser(u: AuthUser | null): void {
  user = u;
}

export const useAuthStore = {
  getState: () => ({ user }),
};

let getAccessToken: (() => string | null) | null = null;
let getRefresh: (() => string | null) | null = null;
let setTokens: ((at: string, rt: string) => void) | null = null;
let clearFn: (() => void) | null = null;

// Offline member sessions have no cloud access token but are still valid local
// sessions. Cloud HTTP calls must still require a real token; local commands,
// LAN mesh startup and the outbox use `hasSession()`.
let localSessionActive = false;

export function setLocalSessionActive(active: boolean): void {
  localSessionActive = active;
  notifyAuth();
}

export function isLocalSessionActive(): boolean {
  return localSessionActive;
}

const authListeners = new Set<() => void>();
export function subscribeAuth(listener: () => void): () => void {
  authListeners.add(listener);
  return () => authListeners.delete(listener);
}
function notifyAuth(): void {
  authListeners.forEach((l) => l());
}

export function setAuthProvider(fn: () => string | null): void {
  getAccessToken = fn;
}

export function setAuthRefreshProvider(fn: () => string | null): void {
  getRefresh = fn;
}

export function setAuthTokensProvider(fn: (at: string, rt: string) => void): void {
  setTokens = fn;
}

export function setAuthClearProvider(fn: () => void): void {
  clearFn = fn;
}

export function getAuthToken(): string | null {
  return getAccessToken ? getAccessToken() : null;
}

export function getRefreshToken(): string | null {
  return getRefresh ? getRefresh() : null;
}

/** True when either a cloud token or an offline member session exists. */
export function hasSession(): boolean {
  return localSessionActive || !!getAuthToken();
}

export function setAuthTokens(at: string, rt: string): void {
  localSessionActive = false;
  if (setTokens) setTokens(at, rt);
  notifyAuth();
}

export function clearAuth(): void {
  localSessionActive = false;
  if (clearFn) clearFn();
  notifyAuth();
}

export function notifyAuthChanged(): void {
  notifyAuth();
}
