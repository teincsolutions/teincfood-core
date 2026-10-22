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
  getEntitySnapshotsByType,
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

const PAYMENT_QUEUED_TYPES = new Set(["payment.completed_queued"]);

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
 * Fire the registered query invalidator (lists refetch from SQLite).
 * Used after LAN-applied writes (order:sync) that bypass the engine event
 * pipeline, so peers' UIs converge without waiting for a cloud echo.
 */
export function notifyPendingOrdersChanged(): void {
  try {
    invalidator?.();
  } catch {}
}

/**
 * Merge optimistic (queued, unconfirmed) state into a page of listed orders.
 * Called by list queryFns (page 1 only) so offline work is visible:
 *  1. Pending creations (order.create_queued, local or LAN) missing from the
 *     SQLite page are prepended — deduped by id/order_number.
 *  2. Queued transitions only patch the snapshot read model, never the
 *     orders table — overlay snapshot statuses onto base rows so the list
 *     reflects the queued status immediately (converges on replay).
 * Reactivity comes from the invalidator: every apply path above refetches.
 */
export async function mergePendingIntoList(
  base: SellerOrder[],
  businessId: string,
  page: number,
): Promise<SellerOrder[]> {
  if (page !== 1) return base;
  let merged = base;
  try {
    const pending = usePendingOrdersStore.getState().orders;
    if (pending.length) {
      const seen = new Set(merged.map((o) => String(o.id ?? o.order_number)));
      const fresh = pending.filter((p) => !seen.has(String(p.id ?? p.order_number)));
      if (fresh.length) merged = [...fresh, ...merged];
    }
  } catch {}
  try {
    const db = await openSyncDatabase();
    const snaps = await getEntitySnapshotsByType<{ data?: SellerOrder[] }>(db, "seller_orders", businessId);
    if (!snaps.length) return merged;
    const statusById = new Map<string, string>();
    for (const s of snaps) {
      const arr = (s.payload as { data?: SellerOrder[] })?.data ?? [];
      for (const o of arr) {
        if (o?.id && o.status) statusById.set(String(o.id), String(o.status));
      }
    }
    if (!statusById.size) return merged;
    let patched = false;
    merged = merged.map((o) => {
      const want = statusById.get(String(o.id));
      if (want && want !== o.status) { patched = true; return { ...o, status: want as SellerOrder["status"] }; }
      return o;
    });
    if (patched) {
      syncLogger.debug("PendingOrders", "overlaid queued statuses onto list", { businessId, count: merged.length });
    }
  } catch {}
  return merged;
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
  origin: "local" | "lan" | "cloud" = "local",
): Promise<void> {
  try {
    const isQueued = QUEUED_STATUS_EVENT_TYPES.has(event.event_type);
    const isPaymentQueued = PAYMENT_QUEUED_TYPES.has(event.event_type);
    if (!ORDER_STATE_EVENT_TYPES.has(event.event_type) && !isQueued && !isPaymentQueued) {
      // Also handle cloud payment.completed for is_paid patch
      if (event.event_type !== "payment.completed") return;
    }
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
      patchPendingStatus(event);
      invalidator?.();
      return;
    }
    if (isPaymentQueued) {
      await orderSnapshotsService.applyPaymentEvent(event, origin);
      patchPendingPaid(event);
      invalidator?.();
      return;
    }
    if (event.event_type === "payment.completed") {
      await orderSnapshotsService.applyPaymentEvent(event, origin);
      patchPendingPaid(event);
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

function patchPendingStatus(event: DomainEvent): void {
  try {
    const payload = event.payload as Record<string, unknown>;
    const toStatus = (payload.to_status as string) || (payload.status as string);
    const orderId = (payload.order_id as string) || event.entity_id;
    if (!toStatus || !orderId) return;
    const store = usePendingOrdersStore.getState();
    const target = store.orders.find((o) => o.id === orderId || o.order_number === orderId);
    if (!target) return;
    const patched = { ...target, status: toStatus as SellerOrder["status"] };
    store.addOrder(patched);
  } catch {}
}

function patchPendingPaid(event: DomainEvent): void {
  try {
    const payload = event.payload as Record<string, unknown>;
    const orderId = (payload.order_id as string) || event.entity_id;
    if (!orderId) return;
    const now = new Date().toISOString();
    const store = usePendingOrdersStore.getState();
    const target = store.orders.find((o) => o.id === orderId || o.order_number === (payload.order_number as string) || o.id === event.entity_id);
    const altTarget = !target ? store.orders.find((o) => o.id === orderId) : null;
    const t = target ?? altTarget;
    if (!t) return;
    const paidAt = (payload.paid_at as string) || now;
    const patched: SellerOrder = {
      ...t,
      is_paid: true,
      paid_at: paidAt,
      payment: { ...(t.payment as SellerOrder["payment"]), is_paid: true, paid_at: paidAt },
    };
    store.addOrder(patched);
  } catch {}
}

export async function applyPendingOrderEvent(
  event: DomainEvent,
  origin: "local" | "lan" | "cloud" = "local",
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
      // Also patch pending store so isPending overlay shows new status immediately.
      try {
        const payload = event.payload as Record<string, unknown>;
        const toStatus = (payload.to_status as string) || (payload.status as string);
        const orderId = (payload.order_id as string) || event.entity_id;
        if (toStatus && orderId) {
          const store = usePendingOrdersStore.getState();
          const target = store.orders.find((o) => o.id === orderId || o.order_number === orderId);
          if (target) store.addOrder({ ...target, status: toStatus as SellerOrder["status"] });
        }
      } catch {}
      const db = await openSyncDatabase();
      await insertEvent(db, { event, origin });
      invalidator?.();
      return;
    }

    if (PAYMENT_QUEUED_TYPES.has(event.event_type) || event.event_type === "payment.completed") {
      await orderSnapshotsService.applyPaymentEvent(event, origin);
      patchPendingPaid(event);
      const db = await openSyncDatabase();
      await insertEvent(db, { event, origin });
      invalidator?.();
      return;
    }

    if (event.event_type === "order.created") {
      const payload = event.payload as Record<string, unknown> | undefined;
      // Local-shape echoes carry local_order_number; cloud-shape echoes
      // (backend id/number, e.g. received over LAN from a peer) carry only
      // order_number. Match on either so both shapes clear the optimistic
      // entry and converge snapshots — previously cloud-shape events hit the
      // early return and triggered no invalidation at all.
      const localOrderNumber = payload?.local_order_number;
      const matchNumber =
        typeof localOrderNumber === "string"
          ? localOrderNumber
          : (payload?.order_number as string | undefined);
      if (typeof matchNumber !== "string") return;

      usePendingOrdersStore.getState().removeByOrderNumber(matchNumber);

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
            matchNumber
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
