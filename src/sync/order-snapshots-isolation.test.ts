import { describe, it, expect, beforeEach } from "vitest";
import { createMemoryDriver } from "../test-helpers/memory-driver";
import { setSqliteDriver } from "../adapters/sqlite";
import { openSyncDatabase, closeSyncDatabase } from "../db/connection";
import { orderSnapshotsService } from "./order-snapshots.service";
import { removeItemSync } from "../adapters/kv";
import { generateEventId } from "../utils/uuid";
import type { SellerOrder } from "../types/api/seller.api";

function order(id: string, status: string): SellerOrder {
  return { id, order_number: `01-100-${id.slice(-3)}`, status, business_id: "biz-A" } as unknown as SellerOrder;
}

describe("orderSnapshots business isolation", () => {
  beforeEach(async () => {
    const driver = createMemoryDriver();
    setSqliteDriver(driver);
    try { await closeSyncDatabase(); } catch {}
    removeItemSync("teinc_callout_seq");
  });

  it("applyQueuedStatusEvent filtered by business_id does not leak", async () => {
    await orderSnapshotsService.persistSellerOrders("biz-A", "biz-A", [order("o1", "pending")]);
    await orderSnapshotsService.persistSellerOrders("biz-B", "biz-B", [order("o1", "pending")]);

    const evtA = {
      event_id: generateEventId(),
      event_type: "order.accept_queued",
      event_version: "1.0",
      entity_id: "o1",
      user_id: "u1",
      device_id: "d1",
      payload: { order_id: "o1", to_status: "accepted", business_id: "biz-A" },
      timestamp: new Date(Date.now() + 1000).toISOString(),
    };
    await orderSnapshotsService.applyQueuedStatusEvent(evtA as any, "local");

    const listA = await orderSnapshotsService.getSellerList("biz-A", "biz-A");
    const listB = await orderSnapshotsService.getSellerList("biz-B", "biz-B");
    expect(listA![0].status).toBe("accepted");
    expect(listB![0].status).toBe("pending");
  });

  it("applyPaymentEvent filtered by business_id is_paid independent", async () => {
    await orderSnapshotsService.persistSellerOrders("biz-A", "biz-A", [order("o2", "ready")]);
    await orderSnapshotsService.persistSellerOrders("biz-B", "biz-B", [order("o2", "ready")]);

    const pay = {
      event_id: generateEventId(),
      event_type: "payment.completed_queued",
      event_version: "1.0",
      entity_id: "o2",
      user_id: "u1",
      device_id: "d1",
      payload: { order_id: "o2", business_id: "biz-A", paid_at: new Date().toISOString() },
      timestamp: new Date(Date.now() + 1000).toISOString(),
    };
    await orderSnapshotsService.applyPaymentEvent(pay as any, "local");
    const a = await orderSnapshotsService.getSellerList("biz-A", "biz-A");
    const b = await orderSnapshotsService.getSellerList("biz-B", "biz-B");
    expect((a![0] as any).is_paid).toBe(true);
    expect((b![0] as any).is_paid).not.toBe(true);
  });
});
