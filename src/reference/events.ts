/**
 * Reference data change events.
 *
 * Bridges reference-data mutations into the Sync Engine event bus so that
 * every device stays in sync:
 *
 *   - The device that mutates a reference-backed entity (e.g. a menu item)
 *     publishes `reference_data.changed` via the Sync Engine.
 *   - The reconciliation bridge relays that event to LAN clients when this
 *     device is the Local Node.
 *   - Any device that receives the event (locally or over the LAN) re-syncs
 *     the affected reference keys and invalidates its React Query caches.
 *
 * This module intentionally does not import the Sync Engine at runtime (only
 * as a type). The engine is registered via `registerReferenceEventEngine`, so
 * `local-node/service.ts` can depend on this module without creating an
 * import cycle (engine → transport → local-node/service → reference/events).
 */

import type { DomainEvent } from "../sync/types";
import type { SyncEngine } from "../sync/engine";
import { useAuthStore } from "../adapters/auth";
import { useBusinessStore } from "../adapters/business";
import { getAppInstanceId } from "../adapters/devices";
import { generateEventId } from "../utils/uuid";
import { syncLogger } from "../utils/sync-logger";
import { referenceSyncService } from "./service";
import type { ReferenceDataKey } from "./types";

export const REFERENCE_CHANGED_EVENT_TYPE = "reference_data.changed";

export interface ReferenceChangedEventPayload {
  business_id: string;
  keys: ReferenceDataKey[];
}

/** Injected Sync Engine singleton (set by the reconciliation bridge). */
let engine: SyncEngine | null = null;

/** Register the Sync Engine used to publish reference change events. */
export function registerReferenceEventEngine(syncEngine: SyncEngine): void {
  engine = syncEngine;
}

/** Invalidate TanStack Query caches after reference data is re-synced. */
let invalidator: (() => void) | null = null;

/**
 * Register a callback used to invalidate React Query caches when reference
 * data changes. Returns an unregister function. Mirrors
 * `registerPendingOrdersInvalidator`.
 */
export function registerReferenceInvalidator(fn: () => void): () => void {
  invalidator = fn;
  return () => {
    if (invalidator === fn) invalidator = null;
  };
}

/**
 * Publish a `reference_data.changed` event so every device (including this
 * one) re-syncs the affected keys. Called after a successful mutation of a
 * reference-backed entity.
 */
export function emitReferenceChanged(
  businessId: string,
  keys: ReferenceDataKey[],
): void {
  if (!businessId || keys.length === 0) return;
  if (!engine) return;

  const user = useAuthStore.getState().user;
  const event: DomainEvent<ReferenceChangedEventPayload> = {
    event_id: generateEventId(),
    event_type: REFERENCE_CHANGED_EVENT_TYPE,
    event_version: "1.0",
    timestamp: new Date().toISOString(),
    device_id: getAppInstanceId(),
    user_id: user?.id ?? "anonymous",
    entity_id: businessId,
    payload: { business_id: businessId, keys },
  };

  engine.publish(event);
}

/**
 * Apply a `reference_data.changed` event: re-sync the affected keys and
 * invalidate caches. Idempotent — duplicate deliveries (local broadcast + LAN
 * broadcast) are safe because the reference sync is version-aware and guarded
 * by a single-flight flag. Errors are logged, never thrown, so a failed
 * reference sync can never crash the LAN event loop.
 */
export async function applyReferenceChangeEvent(
  event: DomainEvent,
  origin: "local" | "lan" = "local",
): Promise<void> {
  try {
    if (event.event_type !== REFERENCE_CHANGED_EVENT_TYPE) return;

    const payload = event.payload as ReferenceChangedEventPayload | undefined;
    const businessId = payload?.business_id;
    const keys = payload?.keys;
    if (!businessId || !keys || keys.length === 0) return;

    syncLogger.info("ReferenceChange", "Reference data changed", {
      origin,
      business_id: businessId,
      keys,
    });

    const result = await referenceSyncService.sync({
      businessId,
      keys,
      incremental: true,
    });

    if (result.failed.length > 0) {
      syncLogger.warn("ReferenceChange", "Reference sync had failures", {
        origin,
        failed: result.failed,
        errors: result.errors,
      });
    }

    invalidator?.();
  } catch (error) {
    syncLogger.error("ReferenceChange", "Failed to apply reference change event", {
      error: String(error),
      event_type: event.event_type,
    });
  }
}

/**
 * Best-effort reference data sync when connectivity recovers. Covers devices
 * that missed the change event (offline, not on the LAN) — the next time they
 * get internet they attempt to re-sync all default reference keys.
 */
export async function syncReferenceDataOnReconnect(): Promise<void> {
  const businessId = useBusinessStore.getState().activeBusiness?.id;
  if (!businessId) return;

  try {
    const result = await referenceSyncService.sync({
      businessId,
      incremental: true,
    });
    if (result.failed.length > 0) {
      syncLogger.warn("ReferenceChange", "Reconnect sync had failures", {
        failed: result.failed,
      });
    }
  } catch (error) {
    syncLogger.error("ReferenceChange", "Reconnect sync failed", {
      error: String(error),
    });
  }
}
