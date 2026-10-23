/**
 * React hook for startup readiness (seller POS/order surfaces).
 *
 * Runs one bounded catch-up on mount (and whenever the cloud becomes
 * reachable), then exposes the local cache readiness so the app can block the
 * POS with an explicit "preparing offline data" state instead of surprising
 * the seller with a guard failure at order-tap time.
 */

import { useCallback, useEffect, useRef, useState } from "react";
import { useSyncExternalStore } from "react";
import { getActiveBusiness, subscribeBusiness } from "../adapters/business";
import { getConnectivityState, subscribeConnectivity } from "../adapters/connectivity";
import {
  ensureStartupReady,
  type StartupReadiness,
} from "../sync/startup-readiness";

function useActiveBusinessId(): string | undefined {
  const id = useSyncExternalStore(
    subscribeBusiness,
    () => getActiveBusiness()?.id ?? null,
    () => null,
  );
  return id ?? undefined;
}

function useCloudStatus(): string {
  return useSyncExternalStore(
    subscribeConnectivity,
    () => getConnectivityState().isCloudReachable,
    () => "unknown",
  );
}

export interface UseStartupReadinessOptions {
  /** Bound the online catch-up attempt. Defaults to 15000ms. */
  timeoutMs?: number;
  /** Set false to skip automatic checking. */
  enabled?: boolean;
}

export interface UseStartupReadinessResult {
  businessId: string | undefined;
  readiness: StartupReadiness | null;
  /** True while the catch-up check is running (first load only). */
  checking: boolean;
  /** Re-run the readiness check on demand (e.g. a Retry button). */
  recheck: () => Promise<void>;
}

export function useStartupReadiness(
  options: UseStartupReadinessOptions = {},
): UseStartupReadinessResult {
  const { timeoutMs, enabled = true } = options;
  const businessId = useActiveBusinessId();
  const cloudStatus = useCloudStatus();
  const [readiness, setReadiness] = useState<StartupReadiness | null>(null);
  const [checking, setChecking] = useState(false);

  const runRef = useRef(false);
  // Identifies the latest readiness run so a slow catch-up for a previous
  // business can never overwrite the verdict for the active one.
  const tokenRef = useRef(0);
  const businessRef = useRef<string | undefined>(businessId);

  // Switching business invalidates the previous verdict — its cached reference
  // keys and lease belong to the old business.
  useEffect(() => {
    if (businessRef.current === businessId) return;
    businessRef.current = businessId;
    tokenRef.current += 1;
    runRef.current = false;
    setReadiness(null);
    setChecking(false);
  }, [businessId]);

  const check = useCallback(async () => {
    if (!businessId) return;
    if (runRef.current) return;
    runRef.current = true;
    const token = ++tokenRef.current;
    setChecking(true);
    try {
      const result = await ensureStartupReady(businessId, { timeoutMs });
      if (tokenRef.current === token) setReadiness(result);
    } finally {
      runRef.current = false;
      if (tokenRef.current === token) setChecking(false);
    }
  }, [businessId, timeoutMs]);

  // First check when a business is available.
  useEffect(() => {
    if (!enabled || !businessId) return;
    if (readiness) return;
    void check();
  }, [enabled, businessId, readiness, check]);

  // Re-check whenever cloud reachability flips to reachable (data may now sync).
  useEffect(() => {
    if (!enabled || !businessId) return;
    if (cloudStatus !== "reachable") return;
    void check();
  }, [enabled, businessId, cloudStatus, check]);

  return { businessId, readiness, checking, recheck: check };
}
