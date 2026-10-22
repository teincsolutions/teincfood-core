/**
 * Server → local order merge.
 *
 * The server is authoritative for an order — EXCEPT while this device still
 * has unsynced work for it. A pull can land before the queued command
 * reaches the backend (reconnect storms, slow networks, a second terminal
 * pushing at the same time); without the overlay the local terminal would
 * visibly revert an accepted order back to `pending`, or drop a confirmed
 * cash payment, until the queue drained.
 *
 * Rules:
 *   1. The server row always overwrites the local row (status, totals,
 *      delivery linkage, items).
 *   2. If this device has a pending command for the order, the local intent
 *      (target status / payment) is re-applied on top of the server row.
 *   3. The local HLC comes from the server's `updated_at`, so device clock
 *      skew can never make fresh server state look stale.
 */

import type { SQLiteDatabase } from "../adapters/sqlite";
import {
  getOrderById,
  getPendingOrderIntent,
  updateOrderPayment,
  updateOrderStatus,
  upsertServerOrder,
} from "../db/operations";
import { syncLogger } from "../utils/sync-logger";
import type { SellerOrder } from "../types/api/seller.api";

/**
 * Merge one server order into the local read model.
 * Returns true when the row was written.
 */
export async function mergeOrderFromServer(
  db: SQLiteDatabase,
  businessId: string,
  serverOrder: SellerOrder,
): Promise<boolean> {
  if (!businessId || !serverOrder?.id) return false;
  try {
    const intent = await getPendingOrderIntent(db, businessId, serverOrder.id);
    // Capture the local payment BEFORE the server copy overwrites the row —
    // a queued cash sale carries the paid timestamp only on the device.
    const beforeMerge = intent.hasPending
      ? await getOrderById(db, businessId, serverOrder.id)
      : null;
    await upsertServerOrder(db, { ...serverOrder, business_id: businessId });

    if (intent.hasPending) {
      if (intent.status) {
        await updateOrderStatus(db, businessId, serverOrder.id, intent.status);
      }
      if (intent.isPaid) {
        const paidAt =
          (beforeMerge?.payment as { paid_at?: string | null } | undefined)?.paid_at ??
          beforeMerge?.paid_at ??
          new Date().toISOString();
        await updateOrderPayment(db, businessId, serverOrder.id, {
          is_paid: true,
          paid_at: paidAt,
        });
      }
      syncLogger.debug("OrderMerge", "Applied local intent over server row", {
        businessId,
        orderId: serverOrder.id,
        status: intent.status,
        isPaid: intent.isPaid,
      });
    }
    return true;
  } catch (error) {
    syncLogger.warn("OrderMerge", "Failed to merge server order", {
      businessId,
      orderId: serverOrder?.id,
      error: String(error),
    });
    return false;
  }
}
