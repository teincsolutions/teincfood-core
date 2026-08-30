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
      const lists = await getEntitySnapshotsByType<SellerOrderListSnapshot>(
        db,
        "seller_orders",
      );
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

  /**
   * Patch the latest status of a known order inside every list snapshot for the
   * business, so offline devices see live status changes without a refetch.
   */
  private async applyOrderStatusToReadModel(
    db: Awaited<ReturnType<typeof openSyncDatabase>>,
    event: DomainEvent,
  ): Promise<void> {
    const payload = event.payload as Record<string, unknown> | undefined;
    const orderId = payload?.order_id as string | undefined;
    const toStatus =
      (payload?.to_status as string | undefined) ??
      (payload?.status as string | undefined);

    if (!orderId || !toStatus || event.event_type !== "order.status_changed") {
      return;
    }

    await this.applyOrderStatusToReadModelInternal(db, orderId, toStatus, event);
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