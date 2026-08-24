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
