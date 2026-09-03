/**
 * Pending Orders Service.
 *
 * Bridges optimistic order events (queued while offline) into the
 * Pending Orders Store so every terminal can render them, and cleans them up
 * once the cloud acknowledges the order.
 *
 * Event sources:
 *   - The Sync Engine broadcasts `order.create_queued` events locally.
 *   - The Local Node broadcasts the same events to LAN clients.
 *   - The cloud returns `order.created` (echoing `local_order_number`).
 *
 * The optimistic event payload for `order.create_queued` is the SellerOrder
 * itself; `order.created` carries `local_order_number` matching the optimistic
 * order's `order_number`.
 */

import { openSyncDatabase } from "../db/connection";
import {
  insertEvent,
  getUnsyncedEvents,
  markEventsSynced,
} from "../db/operations";
import { usePendingOrdersStore } from "../adapters/pending-orders";
import { orderSnapshotsService } from "./order-snapshots.service";
import { syncLogger } from "../utils/sync-logger";
import type { DomainEvent } from "./types";
import type { SellerOrder } from "../types/api/seller.api";

const PENDING_EVENT_TYPE = "order.create_queued";

/** Order/delivery state-change events that should refresh every terminal. */
const ORDER_STATE_EVENT_TYPES = new Set([
  "order.status_changed",
  "delivery.status_changed",
  "delivery.assigned",
]);

const QUEUED_STATUS_EVENT_TYPES = new Set([
  "order.accept_queued",
  "order.reject_queued",
  "order.start_preparing_queued",
  "order.mark_ready_queued",
  "order.complete_pickup_queued",
  "order.cancel_queued",
  "delivery.assign_queued",
  "delivery.confirm_handover_queued",
]);

let invalidator: (() => void) | null = null;

/**
 * Register a callback used to invalidate TanStack Query caches when a pending
 * order is reconciled. Returns an unregister function.
 */
export function registerPendingOrdersInvalidator(fn: () => void): () => void {
  invalidator = fn;
  return () => {
    if (invalidator === fn) invalidator = null;
  };
}

/**
 * Load persisted unsynced order:create_queued events into the store.
 * Idempotent; safe to call after app restart while still offline.
 */
export async function hydratePendingOrders(): Promise<void> {
  const store = usePendingOrdersStore.getState();
  if (store.hydrated) return;

  try {
    const db = await openSyncDatabase();
    const byNumber = new Map<string, SellerOrder>();

    for (const origin of ["local", "lan"] as const) {
      const events = await getUnsyncedEvents(db, origin, Number.MAX_SAFE_INTEGER);
      for (const event of events) {
        if (event.event_type !== PENDING_EVENT_TYPE) continue;
        const order = event.payload as unknown as SellerOrder;
        if (order?.order_number) byNumber.set(order.order_number, order);
      }
    }

    usePendingOrdersStore.setState({ orders: [...byNumber.values()] });
  } catch (error) {
    syncLogger.error("PendingOrders", "Hydration failed", {
      error: String(error),
    });
  } finally {
    usePendingOrdersStore.getState().setHydrated(true);
  }
}

/**
 * Apply a domain event to the pending-orders store and persistence layer.
 *
 *   - order.create_queued → add to store + persist (origin local|lan).
 *   - order.created       → remove matching pending order, mark the persisted
 *                           optimistic event synced, and invalidate caches.
 *
 * Idempotent: duplicate events (local broadcast + LAN broadcast + direct
 * enqueue) are safe.
 */
/**
 * Apply an order/delivery state-change event: refresh order caches so every
 * terminal shows the same order states. Status changes are not stored in the
 * pending-orders store (only queued creations are); this only fires the
 * invalidator. Idempotent — duplicate deliveries are harmless.
 */
export async function applyOrderStateChangeEvent(
  event: DomainEvent,
  origin: "local" | "lan" = "local",
): Promise<void> {
  try {
    const isQueued = QUEUED_STATUS_EVENT_TYPES.has(event.event_type);
    if (!ORDER_STATE_EVENT_TYPES.has(event.event_type) && !isQueued) return;
    syncLogger.debug("OrderState", "Order state changed", {
      origin,
      event_type: event.event_type,
      entity_id: event.entity_id,
    });
    // Persist the event into the durable journal and patch the offline read
    // model so every terminal keeps the same order states after a restart.
    // Queued transitions carry to_status/order_id so they patch instantly offline.
    if (isQueued) {
      await orderSnapshotsService.applyQueuedStatusEvent(event, origin);
      invalidator?.();
      return;
    }
    await orderSnapshotsService.persistOrderEvent(event, origin);
    invalidator?.();
  } catch (error) {
    syncLogger.error("OrderState", "Failed to apply order state change", {
      error: String(error),
      event_type: event.event_type,
    });
  }
}

export async function applyPendingOrderEvent(
  event: DomainEvent,
  origin: "local" | "lan" = "local",
): Promise<void> {
  try {
    if (event.event_type === PENDING_EVENT_TYPE) {
      const order = event.payload as unknown as SellerOrder;
      if (!order?.order_number) return;

      usePendingOrdersStore.getState().addOrder(order);

      const db = await openSyncDatabase();
      await insertEvent(db, { event, origin });
      // Ensure every screen (POS, Orders, Kitchen) sees the optimistic order
      // even when there is no Local Node — TanStack queries that merge pending
      // orders will re-render due to store change, but also invalidate so
      // server-backed lists that are currently cached refresh with the pending
      // overlay.
      invalidator?.();
      return;
    }

    if (QUEUED_STATUS_EVENT_TYPES.has(event.event_type)) {
      // Queued transitions: patch the read model so listing reflects new status offline.
      await orderSnapshotsService.applyQueuedStatusEvent(event, origin);
      const db = await openSyncDatabase();
      await insertEvent(db, { event, origin });
      invalidator?.();
      return;
    }

    if (event.event_type === "order.created") {
      const payload = event.payload as Record<string, unknown> | undefined;
      const localOrderNumber = payload?.local_order_number;
      if (typeof localOrderNumber !== "string") return;

      usePendingOrdersStore.getState().removeByOrderNumber(localOrderNumber);

      // Persist the cloud acknowledgment into the durable journal + read model.
      await orderSnapshotsService.persistOrderEvent(event, "cloud");

      const db = await openSyncDatabase();
      // Mark every persisted optimistic event for this local order number as
      // synced so it does not rehydrate as pending after a restart. Check both
      // origins: the creating terminal persisted "local", LAN clients "lan".
      const ids: string[] = [];
      for (const origin of ["local", "lan"] as const) {
        const unsynced = await getUnsyncedEvents(
          db,
          origin,
          Number.MAX_SAFE_INTEGER,
        );
        for (const e of unsynced) {
          if (e.event_type !== PENDING_EVENT_TYPE) continue;
          if (
            (e.payload as { order_number?: string })?.order_number ===
            localOrderNumber
          ) {
            ids.push(e.event_id);
          }
        }
      }
      if (ids.length > 0) {
        await markEventsSynced(db, ids);
      }

      invalidator?.();
    }
  } catch (error) {
    syncLogger.error("PendingOrders", "Failed to apply event", {
      error: String(error),
      event_type: event.event_type,
    });
  }
}
