/**
 * Sync Guard — single predicate for business-scoped sync.
 *
 * Option C (Hybrid): health probe stays `isOnline`-only (connectivity UX
 * while logged-out). Every *business* sync path gates on both auth *and*
 * active business: no drain, pull, replay, or reference fetch fires until
 * the user has logged in and a business is selected. User-scoped queries
 * (invitations, fleet) gate on auth only.
 */

import { getAuthToken } from "../adapters/auth";
import { getActiveBusiness } from "../adapters/business";

export function isAuthenticated(): boolean {
  return !!getAuthToken();
}

export function hasActiveBusiness(): boolean {
  return !!getActiveBusiness()?.id;
}

/**
 * Business sync may run only when both authenticated and a business is selected.
 * Pass an explicit `businessId` to test that specific id; otherwise reads
 * the active business store.
 */
export function canBusinessSync(businessId?: string | null): boolean {
  const bid = businessId ?? getActiveBusiness()?.id;
  return !!bid && !!getAuthToken();
}
