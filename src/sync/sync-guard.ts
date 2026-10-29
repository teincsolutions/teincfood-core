/**
 * Sync Guard — single predicate for business-scoped sync.
 *
 * Option C (Hybrid): health probe stays `isOnline`-only (connectivity UX
 * while logged-out). Every *business* sync path gates on both auth *and*
 * active business: no drain, pull, replay, or reference fetch fires until
 * the user has logged in and a business is selected. User-scoped queries
 * (invitations, fleet) gate on auth only.
 */

import { hasSession } from "../adapters/auth";
import { getActiveBusiness } from "../adapters/business";

// Offline machinery (reference sync, drains, pulls, leases) runs for the
// seller role only. Fleet managers and riders are fully online: the app
// disables this flag on role change, which funnels through canBusinessSync
// and stops every business sync path at once.
let offlineSyncEnabled = true;

export function setOfflineSyncEnabled(enabled: boolean): void {
  offlineSyncEnabled = enabled;
}

export function isOfflineSyncEnabled(): boolean {
  return offlineSyncEnabled;
}

export function isAuthenticated(): boolean {
  return hasSession();
}

export function hasActiveBusiness(): boolean {
  return !!getActiveBusiness()?.id;
}

/**
 * Business sync may run only when offline sync is enabled for the role,
 * authenticated and a business is selected.
 * Pass an explicit `businessId` to test that specific id; otherwise reads
 * the active business store.
 */
export function canBusinessSync(businessId?: string | null): boolean {
  if (!offlineSyncEnabled) return false;
  const bid = businessId ?? getActiveBusiness()?.id;
  return !!bid && hasSession();
}
