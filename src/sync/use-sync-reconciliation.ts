/**
 * Sync reconciliation bridge.
 *
 * Subscribes to domain events produced by the Sync Engine and:
 *   - Applies order events to the pending-orders store (queued orders stay
 *     visible until the cloud confirms them).
 *   - Marks reconciled optimistic events as synced to cloud.
 *   - Invalidates TanStack Query caches for affected entities.
 */

import { useEffect } from "react";
import { useQueryClient } from "@tanstack/react-query";
import { syncEngine } from "./engine";
import { getActiveBusiness } from "../adapters/business";
import { useGlobalRealtimeBridge } from "../realtime/realtime-bridge";
import {
  applyPendingOrderEvent,
  applyOrderStateChangeEvent,
  registerPendingOrdersInvalidator,
} from "./pending-orders.service";
import { localNodeService } from "../adapters/local-node";
import { getSyncDatabase } from "../db/connection";
import { markEventsSynced } from "../db/operations";
import { syncLogger } from "../utils/sync-logger";
import { subscribeDbChanges } from "../db/operations";
import {
  POS_KEYS,
  SELLER_KEYS,
  KIOSK_KEYS,
  SELLER_ORDERS_KEYS,
  BUSINESS_DELIVERIES_KEYS,
  MENU_KEYS,
  REFERENCE_KEYS,
  SELLER_DASHBOARD_KEYS,
} from "../adapters/query-keys";
import {
  applyReferenceChangeEvent,
  registerReferenceInvalidator,
  registerReferenceEventEngine,
  REFERENCE_CHANGED_EVENT_TYPE,
} from "../reference/events";
import type { DomainEvent } from "./types";

function isLocalOrderEvent(event: DomainEvent): boolean {
  const payload = event.payload as Record<string, unknown> | undefined;
  if (!payload) return false;
  const localOrderNumber = payload.local_order_number;
  return typeof localOrderNumber === "string" && /^[0-9]{2}-[0-9]{3}-[0-9]{3}$/.test(localOrderNumber);
}

const RECONCILE_DEBOUNCE_MS = 400;

export function useSyncReconciliation(): void {
  const queryClient = useQueryClient();

  // Single app-wide Phoenix subscription. Mounting it here means one root
  // `useSyncReconciliation` is enough for the whole app — screens no longer
  // need their own realtime subscription.
  useGlobalRealtimeBridge();

  useEffect(() => {
    let timer: ReturnType<typeof setTimeout> | undefined;
    const pending = new Set<string>();

    const flush = () => {
      timer = undefined;
      if (pending.has("reference")) {
        queryClient.invalidateQueries({ queryKey: MENU_KEYS.all });
        queryClient.invalidateQueries({ queryKey: REFERENCE_KEYS.all });
        queryClient.invalidateQueries({ queryKey: POS_KEYS.all });
        queryClient.invalidateQueries({ queryKey: SELLER_KEYS.all });
        queryClient.invalidateQueries({ queryKey: SELLER_DASHBOARD_KEYS.all });
      }
      if (pending.has("pending")) {
        queryClient.invalidateQueries({ queryKey: POS_KEYS.all });
        queryClient.invalidateQueries({ queryKey: SELLER_KEYS.all });
        queryClient.invalidateQueries({ queryKey: KIOSK_KEYS.all });
        queryClient.invalidateQueries({ queryKey: SELLER_ORDERS_KEYS.all });
        queryClient.invalidateQueries({ queryKey: BUSINESS_DELIVERIES_KEYS.all });
        queryClient.invalidateQueries({ queryKey: SELLER_DASHBOARD_KEYS.all });
      }
      if (pending.has("order")) {
        // order.created with local number already covered by pending, but keep fine-grained
        // POS.orders(businessId) is also covered by pending's broad POS.all, no extra needed.
      }
      pending.clear();
    };

    const schedule = (kind: string) => {
      pending.add(kind);
      if (!timer) timer = setTimeout(flush, RECONCILE_DEBOUNCE_MS);
    };

    // Reference changes re-sync offline data and refresh caches on this device
    // and (via the LAN relay) on every connected terminal.
    const unregisterReferenceInvalidator = registerReferenceInvalidator(() => {
      schedule("reference");
    });

    // Pending-order reconciliation invalidates POS + seller order lists so the
    // server-confirmed order replaces the optimistic one. Invalidate from the
    // broadest key: POS_KEYS.orders() without a businessId would produce
    // ['pos','orders',undefined] which does not prefix-match business-scoped
    // keys. Also cover kiosk/seller-orders/business-deliveries so boards
    // refresh even when there is no Local Node (offline queue + Phoenix).
    const unregisterInvalidator = registerPendingOrdersInvalidator(() => {
      schedule("pending");
    });

    // Reference-change events are published through the Sync Engine but are
    // not backed by a command, so the engine has no transport dependency on
    // the reference module. Register the singleton once.
    registerReferenceEventEngine(syncEngine);

    const unsubscribe = syncEngine.subscribe(async (event) => {
      // LAN strict: ignore events for other business on same subnet
      try {
        const activeId = getActiveBusiness()?.id;
        const payloadBid = (event.payload as Record<string, unknown> | undefined)?.business_id as string | undefined;
        if (activeId && payloadBid && payloadBid !== activeId) return;
      } catch {}
      syncLogger.event(event, "received");

      // The node relays engine events (e.g. order.created when a queued
      // command is replayed) to LAN clients so they reconcile their pending
      // orders and refresh caches.
      if (localNodeService.isLocalNode()) {
        localNodeService.broadcastToClients(event);
      }

      // Reference data changed on this device but we are a LAN client (not the
      // node): forward the event to the node so it rebroadcasts it to every
      // other terminal (the node also applies it locally via its onRelayEvent
      // hook). The node does not echo it back to this device.
      if (
        event.event_type === REFERENCE_CHANGED_EVENT_TYPE &&
        !localNodeService.isLocalNode()
      ) {
        localNodeService.getClient()?.publishEvent?.(event);
      }

      // Where the event came from: a Phoenix push is "cloud", a LAN relay is
      // "lan", everything produced on this device is "local". The journal
      // stores it so a cloud event is never re-hydrated as pending local work.
      const origin = event.origin ?? "local";

      // Reference data changed (locally or echoed from the cloud): re-sync the
      // affected keys and refresh caches on this device.
      await applyReferenceChangeEvent(event, origin);

      // Order/delivery state changed: refresh order caches so this terminal
      // shows the same order states as the device that made the change.
      await applyOrderStateChangeEvent(event, origin);
      // Any order/delivery event should refresh dashboard recent orders immediately (fresh on transition)
      if (event.event_type.startsWith("order.") || event.event_type.startsWith("delivery.")) {
        schedule("pending");
      }

      // Route both queued (optimistic) and reconciled (created) order events
      // into the pending-orders store.
      if (
        event.event_type === "order.create_queued" ||
        event.event_type === "order.created"
      ) {
        await applyPendingOrderEvent(event, origin);
      }

      if (event.event_type === "order.created" && isLocalOrderEvent(event)) {
        try {
          const db = getSyncDatabase();
          await markEventsSynced(db, [event.event_id]);
        } catch (error) {
          syncLogger.error("Reconciliation", "Failed to mark event synced", {
            error: String(error),
          });
        }

        schedule("pending");
      }
    });

    const dbUnsub = subscribeDbChanges((info) => {
      if (info.table.startsWith("reference_data")) schedule("reference");
      else if (info.table === "orders" || info.table.startsWith("entity_snapshots")) schedule("pending");
    });

    return () => {
      if (timer) clearTimeout(timer);
      unsubscribe();
      unregisterInvalidator();
      unregisterReferenceInvalidator();
      dbUnsub();
    };
  }, [queryClient]);
}
