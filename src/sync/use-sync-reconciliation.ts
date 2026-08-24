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
import {
  applyPendingOrderEvent,
  applyOrderStateChangeEvent,
  registerPendingOrdersInvalidator,
} from "./pending-orders.service";
import { localNodeService } from "../adapters/local-node";
import { getSyncDatabase } from "../db/connection";
import { markEventsSynced } from "../db/operations";
import { syncLogger } from "../utils/sync-logger";
import { POS_KEYS, SELLER_KEYS, MENU_KEYS, REFERENCE_KEYS } from "../adapters/query-keys";
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
  return typeof localOrderNumber === "string" && localOrderNumber.startsWith("TFL-");
}

export function useSyncReconciliation(): void {
  const queryClient = useQueryClient();

  useEffect(() => {
    // Reference changes re-sync offline data and refresh caches on this device
    // and (via the LAN relay) on every connected terminal.
    const unregisterReferenceInvalidator = registerReferenceInvalidator(() => {
      queryClient.invalidateQueries({ queryKey: MENU_KEYS.all });
      queryClient.invalidateQueries({ queryKey: REFERENCE_KEYS.all });
      queryClient.invalidateQueries({ queryKey: POS_KEYS.all });
      queryClient.invalidateQueries({ queryKey: SELLER_KEYS.all });
    });

    // Pending-order reconciliation invalidates POS + seller order lists so the
    // server-confirmed order replaces the optimistic one. Invalidate from the
    // broadest key: POS_KEYS.orders() without a businessId would produce
    // ['pos','orders',undefined] which does not prefix-match business-scoped
    // keys.
    const unregisterInvalidator = registerPendingOrdersInvalidator(() => {
      queryClient.invalidateQueries({ queryKey: POS_KEYS.all });
      queryClient.invalidateQueries({ queryKey: SELLER_KEYS.all });
    });

    // Reference-change events are published through the Sync Engine but are
    // not backed by a command, so the engine has no transport dependency on
    // the reference module. Register the singleton once.
    registerReferenceEventEngine(syncEngine);

    const unsubscribe = syncEngine.subscribe(async (event) => {
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

      // Reference data changed (locally or echoed from the cloud): re-sync the
      // affected keys and refresh caches on this device.
      await applyReferenceChangeEvent(event, "local");

      // Order/delivery state changed: refresh order caches so this terminal
      // shows the same order states as the device that made the change.
      await applyOrderStateChangeEvent(event, "local");

      // Route both queued (optimistic) and reconciled (created) order events
      // into the pending-orders store.
      if (
        event.event_type === "order.create_queued" ||
        event.event_type === "order.created"
      ) {
        await applyPendingOrderEvent(event, "local");
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

        const payload = event.payload as Record<string, unknown>;
        const businessId = payload.business_id as string | undefined;
        if (businessId) {
          queryClient.invalidateQueries({ queryKey: POS_KEYS.orders(businessId) });
          queryClient.invalidateQueries({ queryKey: SELLER_KEYS.all });
        }
      }
    });

    return () => {
      unsubscribe();
      unregisterInvalidator();
      unregisterReferenceInvalidator();
    };
  }, [queryClient]);
}
