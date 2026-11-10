/**
 * Account lifecycle — switches the whole core persistence boundary.
 *
 * Called by host apps after auth hydration/login and on logout. It closes the
 * current SQLite connection before changing scope so no in-flight query can
 * write the previous account's data into the next account's database.
 */

import { closeSyncDatabase } from "../db/connection";
import { getAccountScope, setAccountScope } from "./account-scope";

let switchChain: Promise<void> = Promise.resolve();

export function switchAccountScope(accountId: string | null): Promise<void> {
  const next = accountId ?? null;
  if (getAccountScope() === next) return switchChain;

  // Serialize switches: a fast logout→login must not let the login open the
  // new DB before the logout close finishes.
  switchChain = switchChain
    .catch(() => undefined)
    .then(async () => {
      if (getAccountScope() === next) return;
      try {
        await closeSyncDatabase();
      } catch {
        // Closing a never-opened/failed DB must not block the switch.
      }
      setAccountScope(next);
    });

  return switchChain;
}
