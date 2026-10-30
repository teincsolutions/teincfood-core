import { beforeEach, describe, expect, it } from "vitest";
import { createMemoryDriver } from "../test-helpers/memory-driver";
import { setSqliteDriver } from "../adapters/sqlite";
import { closeSyncDatabase, openSyncDatabase } from "../db/connection";
import { usePendingOrdersStore } from "../adapters/pending-orders";
import { applyOrderStateChangeEvent } from "./pending-orders.service";
import type { DomainEvent } from "./types";
import type { SellerOrder } from "../types/api/seller.api";

const BID = "biz-pending-overlay-test";
const ORDER_ID = "99999999-9999-4999-8999-999999999999";

function pendingOrder(): SellerOrder {
  return {
    id: ORDER_ID,
    business_id: BID,
    order_number: "07-009-001",
    callout_number: 1,
    status: "accepted",
    order_type: "takeout",
    is_pos: true,
    items: [],
    subtotal_minor: 2500,
    total_minor: 2500,
    tax_minor: 0,
    tax_lines: [],
    payment: {
      is_paid: true,
      reference: null,
      amount_minor: 2500,
      currency: "GHS",
      paid_at: "2026-01-01T10:00:00.000Z",
    },
    customer_name: null,
    customer_phone: null,
    pos_payment_method: "cash",
    delivery_id: null,
    business: null,
    user: null,
    inserted_at: "2026-01-01T10:00:00.000Z",
    updated_at: "2026-01-01T10:00:00.000Z",
  } as unknown as SellerOrder;
}

function event(type: string, payload: Record<string, unknown>): DomainEvent {
  return {
    event_id: `evt-${Math.random().toString(36).slice(2)}`,
    event_type: type,
    event_version: "1.0",
    entity_id: ORDER_ID,
    user_id: "u1",
    device_id: "d1",
    payload,
    timestamp: new Date().toISOString(),
  };
}

describe("pending order overlay updates", () => {
  beforeEach(async () => {
    setSqliteDriver(createMemoryDriver());
    try {
      await closeSyncDatabase();
    } catch {}
    await openSyncDatabase();
    usePendingOrdersStore.setState({
      orders: [pendingOrder()],
      hydrated: true,
    });
  });

  it("applies a queued transition to an existing pending order", async () => {
    await applyOrderStateChangeEvent(
      event("order.start_preparing_queued", {
        business_id: BID,
        order_id: ORDER_ID,
        to_status: "preparing",
      }),
      "local",
    );

    const order = usePendingOrdersStore
      .getState()
      .orders.find((o) => o.id === ORDER_ID);
    expect(order?.status).toBe("preparing");
  });

  it("applies a queued cash confirmation to an existing pending order", async () => {
    usePendingOrdersStore.setState({
      orders: [{ ...pendingOrder(), is_paid: false, paid_at: null }],
    });

    await applyOrderStateChangeEvent(
      event("payment.completed_queued", {
        business_id: BID,
        order_id: ORDER_ID,
        paid_at: "2026-01-01T10:05:00.000Z",
      }),
      "local",
    );

    const order = usePendingOrdersStore
      .getState()
      .orders.find((o) => o.id === ORDER_ID);
    expect(order?.is_paid).toBe(true);
    expect(order?.paid_at).toBe("2026-01-01T10:05:00.000Z");
  });
});
