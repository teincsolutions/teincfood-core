/**
 * Startup readiness for the POS/order surfaces.
 *
 * The offline-first guards intentionally fail closed (HOURS_NOT_SYNCED,
 * SUBSCRIPTION_REQUIRED, "no device leased"), which is correct — but if the
 * required reference data was never loaded, those guards fire at order-tap
 * time as a surprise. This module lets the app discover the same conditions at
 * launch: it evaluates the local cache (no network) and, when online, performs
 * one bounded catch-up sync so a freshly-launched terminal can satisfy the
 * guards before the seller starts taking orders.
 *
 * Seller-only. Fleet/rider surfaces are fully online and never gate here.
 */

import { openSyncDatabase } from "../db/connection";
import { getReferenceData } from "../reference/operations";
import { referenceSyncService } from "../reference/service";
import { evaluateBusinessEntitlements } from "../reference/entitlement-guard";
import { ensureLease } from "./device-lease.service";
import { getConnectivityState } from "../adapters/connectivity";
import { syncLogger } from "../utils/sync-logger";
import type { ReferenceDataKey } from "../reference/types";

/**
 * Reference keys required before the app presents itself as ready to take
 * orders: menu to sell, taxes to price, hours to open, profile/capabilities
 * for routing + guards, and the signed entitlement proof for gated commands.
 */
export const REQUIRED_ORDER_KEYS: readonly ReferenceDataKey[] = [
  "subscription:entitlements",
  "capabilities",
  "menu:categories",
  "menu:items",
  "tax-rules",
  "business:profile",
  "operating-hours",
];

export interface StartupReadiness {
  /** True when every required key is cached and a device number is leased. */
  ready: boolean;
  /** Required keys with no cached payload. */
  missingKeys: ReferenceDataKey[];
  /** True when no DD-RRR-CCC device number is available (needs one online lease). */
  needsLease: boolean;
  /**
   * True when an entitlement envelope is absent or does not evaluate as
   * entitled. Informational: cash orders still queue offline, so this does not
   * by itself block readiness.
   */
  entitlementUnverified: boolean;
}

/** Evaluate the local cache only (no network). */
export async function getStartupReadiness(businessId: string): Promise<StartupReadiness> {
  const db = await openSyncDatabase();
  const records = await Promise.all(
    REQUIRED_ORDER_KEYS.map(async (key) => ({
      key,
      rec: await getReferenceData(db, businessId, key),
    })),
  );
  const missingKeys = records
    .filter((r) => !r.rec || r.rec.payload == null)
    .map((r) => r.key);

  // ensureLease() hydrates the sync KV from async KV and leases online when
  // possible; offline with no cache it returns null (caller blocks POS).
  let deviceNumber: string | null = null;
  try {
    deviceNumber = await ensureLease(businessId);
  } catch (e) {
    syncLogger.warn("StartupReadiness", "lease check failed", { err: String(e) });
  }
  const needsLease = !deviceNumber;

  let entitlementUnverified = missingKeys.includes("subscription:entitlements");
  if (!entitlementUnverified) {
    try {
      const { evaluation } = await evaluateBusinessEntitlements(businessId);
      entitlementUnverified = !evaluation.entitled;
    } catch {
      entitlementUnverified = true;
    }
  }

  return {
    ready: missingKeys.length === 0 && !needsLease,
    missingKeys,
    needsLease,
    entitlementUnverified,
  };
}

/**
 * One bounded catch-up attempt, then evaluate the cache. When offline (or the
 * cloud is unreachable) this performs no network work and simply reports what
 * is cached. Never throws.
 */
export async function ensureStartupReady(
  businessId: string,
  opts?: { timeoutMs?: number },
): Promise<StartupReadiness> {
  const timeoutMs = opts?.timeoutMs ?? 15_000;
  const { isOnline, isCloudReachable } = getConnectivityState();
  if (isOnline && isCloudReachable !== "unreachable") {
    const catchUp = (async () => {
      try {
        await referenceSyncService.sync({ businessId, keys: [...REQUIRED_ORDER_KEYS] });
      } catch (e) {
        syncLogger.warn("StartupReadiness", "reference catch-up failed", { err: String(e) });
      }
      try {
        await ensureLease(businessId);
      } catch (e) {
        syncLogger.warn("StartupReadiness", "lease catch-up failed", { err: String(e) });
      }
    })();
    await raceWithTimeout(catchUp, timeoutMs);
  }
  return getStartupReadiness(businessId);
}

/** Resolve after either the promise settles or the timeout elapses. */
async function raceWithTimeout(promise: Promise<unknown>, ms: number): Promise<void> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  const timeout = new Promise<void>((resolve) => {
    timer = setTimeout(resolve, ms);
  });
  try {
    await Promise.race([
      promise.then(
        () => undefined,
        () => undefined,
      ),
      timeout,
    ]);
  } finally {
    if (timer) clearTimeout(timer);
  }
}
