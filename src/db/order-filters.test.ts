import { describe, it, expect, beforeEach } from "vitest";
import { createMemoryDriver } from "../test-helpers/memory-driver";
import { setSqliteDriver } from "../adapters/sqlite";
import { openSyncDatabase, closeSyncDatabase } from "../db/connection";
import { insertOrder, listOrders } from "../db/operations";
import { formatDateTime, formatTime, formatDateCompact } from "../utils/formatDate";

const BID = "biz-order-filters";

function order(over: {
  id: string;
  order_type: string;
  is_paid: boolean;
  inserted_at: string;
}): Record<string, unknown> {
  return {
    id: over.id,
    business_id: BID,
    order_number: `07-001-${over.id.slice(-1)}`,
    callout_number: 1,
    status: "delivered",
    order_type: over.order_type,
    is_pos: 1,
    items: "[]",
    subtotal_minor: 1000,
    total_minor: 1000,
    tax_minor: 0,
    tax_lines: "[]",
    payment: { is_paid: over.is_paid },
    customer_name: null,
    customer_phone: null,
    pos_payment_method: "cash",
    delivery_id: null,
    business: null,
    user: null,
    inserted_at: over.inserted_at,
    updated_at: over.inserted_at,
  };
}

describe("listOrders filters (order_type / is_paid / date range)", () => {
  beforeEach(async () => {
    setSqliteDriver(createMemoryDriver() as never);
    try { await closeSyncDatabase(); } catch {}
    const db = await openSyncDatabase();
    await insertOrder(db, order({ id: "o1", order_type: "takeout", is_paid: true, inserted_at: "2026-01-01T10:00:00.000Z" }) as never);
    await insertOrder(db, order({ id: "o2", order_type: "delivery", is_paid: false, inserted_at: "2026-01-15T10:00:00.000Z" }) as never);
    await insertOrder(db, order({ id: "o3", order_type: "takeout", is_paid: false, inserted_at: "2026-02-01T10:00:00.000Z" }) as never);
  });

  async function ids(filters: Record<string, string>): Promise<string[]> {
    const db = await openSyncDatabase();
    const { data } = await listOrders(db, BID, filters, 1, 50);
    return data.map((o) => o.id).sort();
  }

  it("filters by order_type", async () => {
    expect(await ids({ order_type: "takeout" })).toEqual(["o1", "o3"]);
    expect(await ids({ order_type: "delivery" })).toEqual(["o2"]);
  });

  it("filters by payment status", async () => {
    expect(await ids({ is_paid: "paid" })).toEqual(["o1"]);
    expect(await ids({ is_paid: "unpaid" })).toEqual(["o2", "o3"]);
  });

  it("counts a paid_at-only order (cash at the till) as paid", async () => {
    // Backend POS cash sales have paid_at on the order and no payment
    // transaction, so the blob alone reads unpaid.
    const db = await openSyncDatabase();
    await insertOrder(
      db,
      {
        ...order({ id: "o4", order_type: "takeout", is_paid: false, inserted_at: "2026-03-01T10:00:00.000Z" }),
        paid_at: "2026-03-01T10:00:00.000Z",
      } as never,
    );
    expect(await ids({ is_paid: "paid" })).toEqual(["o1", "o4"]);
    expect(await ids({ is_paid: "unpaid" })).toEqual(["o2", "o3"]);
  });

  it("filters by date range", async () => {
    expect(await ids({ date_from: "2026-01-10", date_to: "2026-01-31" })).toEqual(["o2"]);
  });

  it("combines order_type and payment status", async () => {
    expect(await ids({ order_type: "takeout", is_paid: "unpaid" })).toEqual(["o3"]);
  });

  it("returns all when unfiltered", async () => {
    expect(await ids({})).toEqual(["o1", "o2", "o3"]);
  });
});

describe("formatDateTime", () => {
  it("renders a compact date and 12h time", () => {
    const iso = "2026-09-26T14:30:00.000Z";
    expect(formatDateTime(iso)).toContain(",");
    expect(formatTime(iso)).toMatch(/AM|PM/);
    expect(formatDateCompact(iso)).toMatch(/2026/);
  });
});
