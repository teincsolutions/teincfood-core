/**
 * Account scope — one identity boundary for every persistent layer in core.
 *
 * A terminal can be used by more than one account over its lifetime (staff
 * change, owner signs out and creates a new business, etc.). Any cache,
 * offline license, cart, or SQLite row that belongs to a person/business must
 * therefore be namespaced by the authenticated account, not stored under a
 * single global key.
 *
 * The host app owns the auth session and calls `switchAccountScope(user.id)`
 * after login/hydration and `switchAccountScope(null)` on logout. Core then:
 *   - scopes KV-backed data (offline licenses/members, POS cart, printer, …)
 *   - makes the host SQLite driver open a per-account database file
 *   - emits a change event so in-memory stores can drop the previous account.
 *
 * Device-level identities (install id, device number, callout sequence) are
 * deliberately NOT scoped: they identify the terminal, not the user.
 */

export type AccountScopeListener = (accountId: string | null) => void;

let activeAccountId: string | null = null;
const listeners = new Set<AccountScopeListener>();

export function getAccountScope(): string | null {
  return activeAccountId;
}

/**
 * Prefix a storage key with the active account. When no account is active we
 * return the key unchanged so pre-login/device-level callers keep working;
 * user-data callers must guard themselves (see cart/offline stores).
 */
export function accountScopedKey(key: string): string {
  if (!activeAccountId) return key;
  return `acct:${encodeURIComponent(activeAccountId)}:${key}`;
}

/** The scoped key for an explicit account (used when clearing old scopes). */
export function accountScopedKeyFor(accountId: string | null, key: string): string {
  if (!accountId) return key;
  return `acct:${encodeURIComponent(accountId)}:${key}`;
}

export function subscribeAccountScope(listener: AccountScopeListener): () => void {
  listeners.add(listener);
  return () => listeners.delete(listener);
}

/**
 * Low-level scope switch. Hosts should normally call `switchAccountScope()`
 * from the lifecycle module so the SQLite connection is closed/reopened too.
 */
export function setAccountScope(accountId: string | null): void {
  const next = accountId ?? null;
  if (activeAccountId === next) return;
  activeAccountId = next;
  for (const listener of [...listeners]) {
    try {
      listener(next);
    } catch {
      // A broken listener must never block the account switch.
    }
  }
}
