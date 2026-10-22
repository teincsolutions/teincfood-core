/**
 * Durable order read-model.
 *
 * Bridges order events and fetched order lists into the SQLite
 * `entity_snapshots` read model so a restaurant can see current + recent
 * orders offline (survives restart and logout) and refresh them once a
 * connection is re-established.
 *
 * Two sources feed the read model:
 *   1. Incoming order/delivery events (cloud WebSocket or LAN relay) are
 *      persisted to the events journal and used to patch the latest status of
 *      a known order.
 *   2. Successful order list fetches are written through as snapshots so the
 *      exact list last seen while online is available offline.
 */

import { openSyncDatabase } from "../db/connection";
import {
  insertEvent,
  upsertEntitySnapshot,
  getEntitySnapshot,
  getEntitySnapshotsByType,
  pruneEntitySnapshots,
  updateOrderPayment,
} from "../db/operations";
import { syncLogger } from "../utils/sync-logger";
import type { DomainEvent } from "./types";
import type { SellerOrder } from "../types/api/seller.api";

const RETAIN_MS = 30 * 24 * 60 * 60 * 1000; // 30 days

const ORDER_EVENT_TYPES = new Set([
  "order.created",
  "order.status_changed",
  "delivery.assigned",
  "delivery.status_changed",
  "delivery.pickup_confirmed",
  "payment.completed",
  "payment.failed",
]);

/** Payload stored in a seller_orders snapshot. */
type SellerOrderListSnapshot = {
  data: SellerOrder[];
  savedAt: string;
};

class OrderSnapshotsService {
  /**
   * Persist an order/delivery event into the durable event journal and patch
   * the read model. Returns true if it was an order event (idempotent for
   * duplicates).
   */
  async persistOrderEvent(
    event: DomainEvent,
    origin: "local" | "lan" | "cloud",
  ): Promise<boolean> {
    if (!ORDER_EVENT_TYPES.has(event.event_type)) return false;
    try {
      const db = await openSyncDatabase();
      await insertEvent(db, { event, origin });
      await this.applyOrderStatusToReadModel(db, event);
      return true;
    } catch (error) {
      syncLogger.error("OrderSnapshots", "Failed to persist order event", {
        error: String(error),
        event_type: event.event_type,
      });
      return false;
    }
  }

  /**
   * Patch the latest status for a queued transition (e.g. accept_queued)
   * carrying to_status/order_id. Used so offline devices see the new status
   * immediately and after restart via the durable snapshot.
   */
  async applyQueuedStatusEvent(
    event: DomainEvent,
    origin: "local" | "lan" | "cloud" = "local",
  ): Promise<void> {
    const payload = event.payload as Record<string, unknown> | undefined;
    const toStatus = payload?.to_status as string | undefined;
    const orderId = (payload?.order_id as string | undefined) ?? (event.entity_id as string | undefined);
    if (!toStatus || !orderId) return;
    try {
      const db = await openSyncDatabase();
      await insertEvent(db, { event, origin });
      await this.applyOrderStatusToReadModelInternal(db, orderId, toStatus, event);
    } catch (error) {
      syncLogger.error("OrderSnapshots", "Failed to apply queued status", {
        error: String(error),
        event_type: event.event_type,
      });
    }
  }

  private async applyOrderStatusToReadModelInternal(
    db: Awaited<ReturnType<typeof openSyncDatabase>>,
    orderId: string,
    toStatus: string,
    event: DomainEvent,
  ): Promise<void> {
    try {
      const payload = event.payload as Record<string, unknown> | undefined;
      const businessId = (payload?.business_id as string | undefined) ?? (payload?.businessId as string | undefined) ?? null;
      // Dual-write: keep canonical orders table in sync so POS/KDS reads converge instantly.
      if (businessId) {
        try {
          const { updateOrderStatus } = await import("../db/operations");
          await updateOrderStatus(db, businessId, orderId, toStatus, event.timestamp);
        } catch {}
      }
      const lists = businessId
        ? await getEntitySnapshotsByType<SellerOrderListSnapshot>(db, "seller_orders", businessId)
        : await getEntitySnapshotsByType<SellerOrderListSnapshot>(db, "seller_orders");
      for (const list of lists) {
        const data = list.payload.data ?? [];
        const idx = data.findIndex((o) => o.id === orderId);
        if (idx === -1) continue;
        const updated = data.map((o, i) =>
          i === idx ? { ...o, status: toStatus } : o,
        );
        await upsertEntitySnapshot(db, {
          entityType: "seller_orders",
          entityId: list.entity_id,
          businessId: list.business_id,
          lastEventId: event.event_id,
          lastEventTimestamp: event.timestamp,
          payload: { ...list.payload, data: updated },
        });
      }
    } catch (error) {
      syncLogger.error("OrderSnapshots", "Failed to apply status to read model", {
        error: String(error),
      });
    }
  }

  async applyPaymentEvent(
    event: DomainEvent,
    origin: "local" | "lan" | "cloud" = "local",
  ): Promise<void> {
    const payload = event.payload as Record<string, unknown> | undefined;
    const orderId = (payload?.order_id as string | undefined) ?? (event.entity_id as string | undefined);
    if (!orderId) return;
    const paidAt = (payload?.paid_at as string) || new Date().toISOString();
    try {
      const db = await openSyncDatabase();
      await insertEvent(db, { event, origin });
      const businessId = (payload?.business_id as string | undefined) ?? (payload?.businessId as string | undefined) ?? null;
      // Dual-write the canonical orders row: POS/Orders screens read payment
      // from there, not from the snapshot. Without this a mobile-money sale
      // stayed UNPAID (and kept offering "Collect cash") after its payment
      // completed, because only the snapshot list was patched.
      if (businessId) {
        await updateOrderPayment(db, businessId, orderId, { is_paid: true, paid_at: paidAt });
      } else {
        try {
          const row = await db.getFirstAsync<{ business_id: string }>(
            `SELECT business_id FROM orders WHERE id = ? OR order_number = ? LIMIT 1;`,
            orderId,
            (payload?.order_number as string | undefined) ?? orderId,
          );
          if (row?.business_id) {
            await updateOrderPayment(db, row.business_id, orderId, { is_paid: true, paid_at: paidAt });
          }
        } catch {}
      }
      const lists = businessId
        ? await getEntitySnapshotsByType<SellerOrderListSnapshot>(db, "seller_orders", businessId)
        : await getEntitySnapshotsByType<SellerOrderListSnapshot>(db, "seller_orders");
      for (const list of lists) {
        const data = list.payload.data ?? [];
        const idx = data.findIndex((o) => o.id === orderId || o.order_number === (payload?.order_number as string));
        if (idx === -1) continue;
        const updated = data.map((o, i) =>
          i === idx ? { ...o, is_paid: true, paid_at: paidAt, payment: { ...(o.payment as SellerOrder["payment"]), is_paid: true, paid_at: paidAt } } : o,
        );
        await upsertEntitySnapshot(db, {
          entityType: "seller_orders",
          entityId: list.entity_id,
          businessId: list.business_id,
          lastEventId: event.event_id,
          lastEventTimestamp: event.timestamp,
          payload: { ...list.payload, data: updated },
        });
      }
    } catch (error) {
      syncLogger.error("OrderSnapshots", "Failed to apply payment", { error: String(error) });
    }
  }

  /**
   * Patch the latest status of a known order inside every list snapshot for the
   * business, so offline devices see live status changes without a refetch.
   * Also applies delivery linkage (delivery.assigned / delivery.status_changed
   * / delivery.pickup_confirmed): backend emits delivery events WITHOUT an
   * order.status_changed for assign + merchant/rider single-confirms, so
   * without this other terminals keep offering "Assign rider" forever.
   */
  private async applyOrderStatusToReadModel(
    db: Awaited<ReturnType<typeof openSyncDatabase>>,
    event: DomainEvent,
  ): Promise<void> {
    const payload = event.payload as Record<string, unknown> | undefined;
    if (event.event_type === "delivery.assigned") {
      await this.applyDeliveryAssignedToReadModel(db, event);
      return;
    }
    if (event.event_type === "delivery.status_changed" || event.event_type === "delivery.pickup_confirmed") {
      await this.applyDeliveryStatusToReadModel(db, event);
      return;
    }
    const orderId = payload?.order_id as string | undefined;
    const toStatus =
      (payload?.to_status as string | undefined) ??
      (payload?.status as string | undefined);

    if (!orderId || !toStatus || event.event_type !== "order.status_changed") {
      return;
    }

    await this.applyOrderStatusToReadModelInternal(db, orderId, toStatus, event);
  }

  private businessIdOf(event: DomainEvent): string | null {
    const payload = event.payload as Record<string, unknown> | undefined;
    return (
      (payload?.business_id as string | undefined) ??
      (payload?.businessId as string | undefined) ??
      null
    );
  }

  private orderIdOf(event: DomainEvent): string | undefined {
    const payload = event.payload as Record<string, unknown> | undefined;
    return (payload?.order_id as string | undefined) ?? (event.entity_id as string | undefined);
  }

  /** delivery.assigned {order_id, rider_id}, entity = delivery id. */
  private async applyDeliveryAssignedToReadModel(
    db: Awaited<ReturnType<typeof openSyncDatabase>>,
    event: DomainEvent,
  ): Promise<void> {
    try {
      const payload = event.payload as Record<string, unknown> | undefined;
      const orderId = this.orderIdOf(event);
      const businessId = this.businessIdOf(event);
      const deliveryId = (event.entity_id as string | undefined) ?? (payload?.delivery_id as string | undefined);
      if (!orderId || !businessId || !deliveryId) return;
      try {
        const { updateOrderDelivery } = await import("../db/operations");
        await updateOrderDelivery(db, businessId, orderId, { delivery_id: deliveryId });
      } catch {}
      const lists = await getEntitySnapshotsByType<SellerOrderListSnapshot>(db, "seller_orders", businessId);
      for (const list of lists) {
        const data = list.payload.data ?? [];
        const idx = data.findIndex((o) => o.id === orderId);
        if (idx === -1) continue;
        const updated = data.map((o, i) =>
          i === idx ? { ...o, delivery_id: deliveryId, delivery_status: "assigned" } : o,
        );
        await upsertEntitySnapshot(db, {
          entityType: "seller_orders",
          entityId: list.entity_id,
          businessId: list.business_id,
          lastEventId: event.event_id,
          lastEventTimestamp: event.timestamp,
          payload: { ...list.payload, data: updated },
        });
      }
    } catch (error) {
      syncLogger.error("OrderSnapshots", "Failed to apply delivery.assigned to read model", { error: String(error) });
    }
  }

  /** delivery.status_changed {order_id, status} / delivery.pickup_confirmed {order_id, rider_confirmed, merchant_confirmed, status}. */
  private async applyDeliveryStatusToReadModel(
    db: Awaited<ReturnType<typeof openSyncDatabase>>,
    event: DomainEvent,
  ): Promise<void> {
    try {
      const payload = event.payload as Record<string, unknown> | undefined;
      const orderId = this.orderIdOf(event);
      const businessId = this.businessIdOf(event);
      if (!orderId || !businessId) return;
      const deliveryStatus = payload?.status as string | undefined;
      const patch: Record<string, unknown> = {};
      if (deliveryStatus) patch.delivery_status = deliveryStatus;
      if (typeof payload?.merchant_confirmed === "boolean") patch.merchant_handover_confirmed_at = payload.merchant_confirmed ? event.timestamp : null;
      if (typeof payload?.rider_confirmed === "boolean") patch.rider_handover_confirmed_at = payload.rider_confirmed ? event.timestamp : null;
      if (Object.keys(patch).length === 0) return;
      const lists = await getEntitySnapshotsByType<SellerOrderListSnapshot>(db, "seller_orders", businessId);
      for (const list of lists) {
        const data = list.payload.data ?? [];
        const idx = data.findIndex((o) => o.id === orderId);
        if (idx === -1) continue;
        const updated = data.map((o, i) => (i === idx ? { ...o, ...patch } : o));
        await upsertEntitySnapshot(db, {
          entityType: "seller_orders",
          entityId: list.entity_id,
          businessId: list.business_id,
          lastEventId: event.event_id,
          lastEventTimestamp: event.timestamp,
          payload: { ...list.payload, data: updated },
        });
      }
    } catch (error) {
      syncLogger.error("OrderSnapshots", "Failed to apply delivery status to read model", { error: String(error) });
    }
  }

  /**
   * Write through a fetched order list so it is available offline. Used by the
   * seller and POS order queries. `scope` distinguishes complementary lists
   * (e.g. the unfiltered recent list) within a business.
   */
  async persistSellerOrders(
    businessId: string,
    scope: string,
    orders: SellerOrder[],
  ): Promise<void> {
    if (!businessId) return;
    try {
      const db = await openSyncDatabase();
      await upsertEntitySnapshot(db, {
        entityType: "seller_orders",
        entityId: scope,
        businessId,
        lastEventId: `fetch-${Date.now()}`,
        lastEventTimestamp: new Date().toISOString(),
        payload: { data: orders, savedAt: new Date().toISOString() },
      });
    } catch (error) {
      syncLogger.error("OrderSnapshots", "Failed to persist seller list", {
        error: String(error),
        businessId,
      });
    }
  }

  /**
   * Read a persisted order list from the offline read model.
   */
  async getSellerList(
    businessId: string,
    scope: string,
  ): Promise<SellerOrder[] | null> {
    try {
      const db = await openSyncDatabase();
      const snap = await getEntitySnapshot<SellerOrderListSnapshot>(
        db,
        "seller_orders",
        scope,
        businessId,
      );
      if (!snap || snap.business_id !== businessId) return null;
      return snap.payload.data ?? null;
    } catch (error) {
      syncLogger.error("OrderSnapshots", "Failed to read seller list", {
        error: String(error),
      });
      return null;
    }
  }

  /**
   * Prune snapshots outside the retention window. Call on startup.
   */
  async pruneOld(): Promise<void> {
    try {
      const cutoff = new Date(Date.now() - RETAIN_MS).toISOString();
      const db = await openSyncDatabase();
      await pruneEntitySnapshots(db, "seller_orders", cutoff);
    } catch (error) {
      syncLogger.error("OrderSnapshots", "Failed to prune", {
        error: String(error),
      });
    }
  }
}

export const orderSnapshotsService = new OrderSnapshotsService();