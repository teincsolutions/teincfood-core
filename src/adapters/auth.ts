/**
 * Auth store stub.
 */

export interface AuthUser {
  id: string;
  email?: string;
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

export function setAuthTokens(at: string, rt: string): void {
  if (setTokens) setTokens(at, rt);
  notifyAuth();
}

export function clearAuth(): void {
  if (clearFn) clearFn();
  notifyAuth();
}

export function notifyAuthChanged(): void {
  notifyAuth();
}
