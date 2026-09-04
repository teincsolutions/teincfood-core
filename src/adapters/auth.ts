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

export function setAuthProvider(fn: () => string | null): void {
  getAccessToken = fn;
}

export function getAuthToken(): string | null {
  return getAccessToken ? getAccessToken() : null;
}
