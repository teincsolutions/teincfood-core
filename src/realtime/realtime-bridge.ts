/**
 * Global realtime bridge — ONE Phoenix subscription for the whole app.
 *
 * Before this module existed, cloud events were only processed by screens
 * that mounted `useOrderRealtimeUpdates` (POS, Orders, Kitchen, Display).
 * Any other screen — the Dashboard, Settings, the business switcher — never
 * saw another terminal's order, and every mounted screen duplicated the
 * same handling (one persist + publish + invalidate per screen).
 *
 * The bridge is the single owner of the cloud → local event path:
 *
 *   Phoenix frame
 *     → orderEventsService (typed event fan-out)
 *       → business filter (active business only)
 *         → syncEngine.publish(domainEvent)
 *             → useSyncReconciliation: journal + read-model patch +
 *               debounced query invalidation (+ LAN relay for mesh peers)
 *         → unknown `order.created` → fetch THAT order only
 *
 * Mounting it from several hooks is safe: the underlying subscription is
 * created once and torn down when the last consumer unmounts.
 */

import { useEffect } from "react";
import { orderEventsService } from "./order-events.service";
import { syncEngine } from "../sync/engine";
import { getActiveBusiness } from "../adapters/business";
import { getAppInstanceId } from "../adapters/devices";
import { generateEventId } from "../utils/uuid";
import { openSyncDatabase } from "../db/connection";
import { getOrderById } from "../db/operations";
import { fetchRemoteOrderByNumber } from "../sync/sync-jobs.service";
import { syncLogger } from "../utils/sync-logger";
import type { DomainEvent } from "../sync/types";

/** Coalesce bursts of `order.created` events into one fetch per order. */
const UNKNOWN_ORDER_FETCH_DEBOUNCE_MS = 400;

let consumerCount = 0;
let detach: (() => void) | null = null;

/**
 * Subscribe to the global realtime bridge.
 * Safe to call from multiple hooks — the underlying socket listener is
 * created once and disposed when the last caller releases it.
 */
export function subscribeGlobalRealtime(): () => void {
  consumerCount += 1;
  if (!detach) detach = attachBridge();

  let released = false;
  return () => {
    if (released) return;
    released = true;
    consumerCount -= 1;
    if (consumerCount <= 0) {
      consumerCount = 0;
      try {
        detach?.();
      } catch {}
      detach = null;
    }
  };
}

/** React hook wrapper around `subscribeGlobalRealtime`. */
export function useGlobalRealtimeBridge(): void {
  useEffect(() => subscribeGlobalRealtime(), []);
}

function attachBridge(): () => void {
  const pendingFetches = new Map<string, ReturnType<typeof setTimeout>>();

  const scheduleUnknownOrderFetch = (
    businessId: string,
    orderNumber: string | undefined,
    orderId: string | undefined,
  ) => {
    if (!businessId || (!orderNumber && !orderId)) return;
    const key = `${businessId}:${orderNumber ?? orderId}`;
    if (pendingFetches.has(key)) return;
    const timer = setTimeout(() => {
      pendingFetches.delete(key);
      void (async () => {
        try {
          // Only fetch when this device has never seen the order — the
          // realtime payload is summary-only, so a known order needs no
          // network call at all.
          if (orderId) {
            const db = await openSyncDatabase();
            const known = await getOrderById(db, businessId, orderId);
            if (known) return;
          }
          if (!orderNumber) return;
          await fetchRemoteOrderByNumber(businessId, orderNumber);
        } catch {}
      })();
    }, UNKNOWN_ORDER_FETCH_DEBOUNCE_MS);
    pendingFetches.set(key, timer);
  };

  const unsubscribe = orderEventsService.onOrderUpdates((event) => {
    try {
      const payload = { ...event } as Record<string, unknown>;
      const activeBusinessId = getActiveBusiness()?.id;
      let businessId =
        (payload.business_id as string | undefined) ??
        (payload.businessId as string | undefined);

      // Delivery events carry no business id — the socket already filtered by
      // business, so stamp the active one for read-model patching.
      if (!businessId && activeBusinessId) {
        businessId = activeBusinessId;
        payload.business_id = activeBusinessId;
      }
      if (!businessId) return;
      // Never let another business' event touch this device.
      if (activeBusinessId && businessId !== activeBusinessId) return;

      const ownDeviceId = getAppInstanceId();
      const domainEvent: DomainEvent = {
        event_id: (payload.event_id as string) ?? generateEventId(),
        event_type: event.type,
        event_version: (payload.event_version as string) ?? "1.0",
        timestamp: (payload.timestamp as string) ?? new Date().toISOString(),
        device_id: (payload.device_id as string) ?? ownDeviceId,
        user_id: (payload.user_id as string) ?? "system",
        entity_id: event.order_id ?? "",
        payload,
        origin: "cloud",
      };

      // Publish through the Sync Engine: the reconciliation bridge journals
      // the event, patches the offline read model, invalidates the caches and
      // relays the event to LAN peers.
      syncEngine.publish(domainEvent);

      // An order created on another terminal arrives as a summary only, so
      // this device has no row for it — fetch that single order (not the
      // whole list) so the board fills in.
      if (event.type === "order.created") {
        scheduleUnknownOrderFetch(
          businessId,
          (payload.order_number as string | undefined) ??
            (payload.local_order_number as string | undefined),
          event.order_id,
        );
      }
    } catch (error) {
      syncLogger.warn("RealtimeBridge", "Failed to handle cloud event", {
        error: String(error),
      });
    }
  });

  return () => {
    for (const timer of pendingFetches.values()) clearTimeout(timer);
    pendingFetches.clear();
    unsubscribe();
  };
}
