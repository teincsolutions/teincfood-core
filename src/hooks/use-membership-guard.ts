/**
 * Online-only membership guard.
 *
 * Keeps the 30-day offline session untouched: membership is re-validated only
 * while the device is online, on an interval and whenever the host app calls
 * `checkNow()` (reconnect / foreground). Explicit revocation is handed to the
 * host app so it can log the user out and wipe local access.
 */

import { useCallback, useEffect, useRef } from "react";
import {
  MembershipRevokedError,
  validateBusinessMembership,
  type BusinessMembershipValidation,
} from "../membership/validation";
import { syncLogger } from "../utils/sync-logger";

export interface UseMembershipGuardOptions {
  businessId?: string | null;
  userId?: string | null;
  /** Gate this on cloud reachability in the host app (never check offline). */
  enabled?: boolean;
  intervalMs?: number;
  onRevoked: (businessId: string, error: MembershipRevokedError) => void | Promise<void>;
  onValid?: (membership: BusinessMembershipValidation) => void | Promise<void>;
}

export function useMembershipGuard({
  businessId,
  userId,
  enabled = true,
  intervalMs = 60_000,
  onRevoked,
  onValid,
}: UseMembershipGuardOptions): { checkNow: () => Promise<void> } {
  const onRevokedRef = useRef(onRevoked);
  const onValidRef = useRef(onValid);
  onRevokedRef.current = onRevoked;
  onValidRef.current = onValid;

  const inFlight = useRef(false);
  const revokedBusinesses = useRef<Set<string>>(new Set());

  const checkNow = useCallback(async () => {
    if (!enabled || !businessId || !userId || inFlight.current) return;
    if (revokedBusinesses.current.has(businessId)) return;

    inFlight.current = true;
    try {
      const membership = await validateBusinessMembership(businessId);
      await onValidRef.current?.(membership);
    } catch (error) {
      if (error instanceof MembershipRevokedError) {
        revokedBusinesses.current.add(businessId);
        syncLogger.warn("Membership", "Membership revoked while online", {
          businessId,
          error: String(error.cause ?? error),
        });
        await onRevokedRef.current(businessId, error);
      } else {
        // Transient network/server failures must not log anyone out.
        syncLogger.debug("Membership", "Membership check skipped", {
          businessId,
          error: String(error),
        });
      }
    } finally {
      inFlight.current = false;
    }
  }, [enabled, businessId, userId]);

  useEffect(() => {
    if (!enabled || !businessId || !userId) return;
    void checkNow();
    const timer = setInterval(() => void checkNow(), intervalMs);
    return () => clearInterval(timer);
  }, [enabled, businessId, userId, intervalMs, checkNow]);

  return { checkNow };
}
