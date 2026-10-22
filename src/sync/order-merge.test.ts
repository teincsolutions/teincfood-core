import { describe, it, expect, beforeEach } from "vitest";
import { createMemoryDriver } from "../test-helpers/memory-driver";
import { setSqliteDriver } from "../adapters/sqlite";
import { openSyncDatabase, closeSyncDatabase } from "../db/connection";
import { insertOrder, getOrderById } from "../db/operations";
import { mergeOrderFromServer } from "./order-merge";
import type { SellerOrder } from "../types/api/seller.api";

const BID = "biz-merge-test";
const ORDER_ID = "44444444-4444-4444-8444-444444444444";

function serverOrder(
  status: string,
  isPaid: boolean,
  updatedAt = "2026-01-01T10:00:00.000Z",
): SellerOrder {
  return {
    id: ORDER_ID,
    business_id: BID,
    order_number: "07-001-001",
    callout_number: 1,
    status,
    order_type: "takeout",
    is_pos: true,
    items: [],
    subtotal_minor: 1000,
    total_minor: 1000,
    tax_minor: 0,
    tax_lines: [],
    payment: {
      is_paid: isPaid,
      reference: null,
      amount_minor: 1000,
      currency: "GHS",
      paid_at: isPaid ? updatedAt : null,
    },
    customer_name: null,
    customer_phone: null,
    pos_payment_method: "cash",
    delivery_id: null,
    business: null,
    user: null,
    currency: "GHS",
    currency_code: "GHS",
    inserted_at: "2026-01-01T09:00:00.000Z",
    updated_at: updatedAt,
  } as unknown as SellerOrder;
}

async function enqueueJob(
  db: Awaited<ReturnType<typeof openSyncDatabase>>,
  commandType: string,
  createdAt = "2026-01-01T09:30:00.000Z",
): Promise<void> {
  await db.runAsync(
    `INSERT OR IGNORE INTO sync_jobs (id, business_id, command_type, entity_id, payload, status, created_at, updated_at) VALUES (?, ?, ?, ?, ?, 'pending', ?, ?);`,
    `job-${commandType}`,
    BID,
    commandType,
    ORDER_ID,
    "{}",
    createdAt,
    createdAt,
  );
}

describe("server → local order merge", () => {
  beforeEach(async () => {
    const mem = createMemoryDriver();
    setSqliteDriver(mem as never);
    try { await closeSyncDatabase(); } catch {}
    await openSyncDatabase();
  });

  it("keeps a queued transition's status when the server copy is older", async () => {
    const db = await openSyncDatabase();
    // Local optimistic accept already applied.
    await insertOrder(db, serverOrder("accepted", true) as never);
    await enqueueJob(db, "order:accept");

    const merged = await mergeOrderFromServer(db, BID, serverOrder("pending", false));
    expect(merged).toBe(true);

    const row = await getOrderById(db, BID, ORDER_ID);
    expect(row?.status).toBe("accepted");
  });

  it("applies the server status once the queued command is done", async () => {
    const db = await openSyncDatabase();
    await insertOrder(db, serverOrder("accepted", true) as never);

    // No pending job → the server is authoritative.
    await mergeOrderFromServer(db, BID, serverOrder("preparing", false));

    const row = await getOrderById(db, BID, ORDER_ID);
    expect(row?.status).toBe("preparing");
  });

  it("keeps a queued cash payment paid", async () => {
    const db = await openSyncDatabase();
    await insertOrder(db, serverOrder("accepted", false) as never);
    await enqueueJob(db, "payment:confirm_cash");

    await mergeOrderFromServer(db, BID, serverOrder("accepted", false));

    const row = await getOrderById(db, BID, ORDER_ID);
    expect(row?.is_paid).toBe(true);
  });

  it("never un-pays an order from a server copy that lost the payment flag", async () => {
    // Regression: a cash sale is paid at the till but the server copy can lag
    // (or predate the paid_at fallback). A pull used to overwrite the local
    // payment with {is_paid:false} and the order read back as UNPAID.
    const db = await openSyncDatabase();
    await insertOrder(db, serverOrder("accepted", true) as never);

    await mergeOrderFromServer(db, BID, serverOrder("accepted", false));

    const row = await getOrderById(db, BID, ORDER_ID);
    expect(row?.is_paid).toBe(true);
    expect(row?.paid_at).toBeTruthy();
  });

  it("keeps a cash sale paid while its create command is still queued", async () => {
    const db = await openSyncDatabase();
    // Local optimistic cash sale: paid, with the create still unsynced.
    await insertOrder(db, serverOrder("accepted", true) as never);
    await enqueueJob(db, "order:create");

    await mergeOrderFromServer(db, BID, serverOrder("accepted", false));

    const row = await getOrderById(db, BID, ORDER_ID);
    expect(row?.is_paid).toBe(true);
  });

  it("treats a server top-level paid_at as paid even with an empty payment blob", async () => {
    // Backend POS cash sales carry `paid_at` on the order and no payment
    // transaction; the serializer's payment summary was empty for them.
    const db = await openSyncDatabase();
    const server = serverOrder("accepted", false);
    (server as unknown as { paid_at: string }).paid_at = "2026-01-01T10:00:00.000Z";
    (server as unknown as { is_paid: boolean }).is_paid = true;
    await mergeOrderFromServer(db, BID, server);

    const row = await getOrderById(db, BID, ORDER_ID);
    expect(row?.is_paid).toBe(true);
    expect(row?.paid_at).toBe("2026-01-01T10:00:00.000Z");
  });
});
