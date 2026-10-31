import { describe, it, expect, beforeEach, vi } from "vitest";
import { createMemoryDriver } from "../test-helpers/memory-driver";
import { setSqliteDriver } from "../adapters/sqlite";
import { setKVDriver } from "../adapters/kv";
import { setAuthProvider } from "../adapters/auth";
import { setActiveBusiness } from "../adapters/business";
import { setHttpClient } from "../adapters/http";
import { setConnectivityState } from "../adapters/connectivity";
import { openSyncDatabase, closeSyncDatabase } from "../db/connection";
import { insertOrder, getOrderById } from "../db/operations";
import { drainPending } from "./sync-jobs.service";
import { transitionLocalOrder } from "../domain/orders/service";
import { phoenixSocket } from "../realtime/phoenix-socket";
import type { SellerOrder } from "../types/api/seller.api";

const BID = "biz-queue-order-test";
const ORDER_ID = "77777777-7777-4777-8777-777777777777";

function localOrder(status: string): SellerOrder {
  return {
    id: ORDER_ID,
    business_id: BID,
    order_number: "07-003-001",
    callout_number: 1,
    status,
    order_type: "takeout",
    is_pos: true,
    items: [],
    subtotal_minor: 3000,
    total_minor: 3000,
    tax_minor: 0,
    tax_lines: [],
    payment: { is_paid: false, reference: null, amount_minor: 3000, currency: "GHS", paid_at: null },
    customer_name: null,
    customer_phone: null,
    pos_payment_method: "cash",
    delivery_id: null,
    business: null,
    user: null,
    currency: "GHS",
    currency_code: "GHS",
    inserted_at: "2026-01-03T09:00:00.000Z",
    updated_at: "2026-01-03T09:00:00.000Z",
  } as unknown as SellerOrder;
}

describe("offline queue ordering", () => {
  const posted: string[] = [];

  beforeEach(async () => {
    const mem = createMemoryDriver();
    setSqliteDriver(mem as never);
    const kvStore = new Map<string, string>();
    setKVDriver({
      getItem: async (k: string) => kvStore.get(k) ?? null,
      setItem: async (k: string, v: string) => { kvStore.set(k, v); },
      removeItem: async (k: string) => { kvStore.delete(k); },
      getItemSync: (k: string) => kvStore.get(k) ?? null,
      setItemSync: (k: string, v: string) => { kvStore.set(k, v); },
      removeItemSync: (k: string) => { kvStore.delete(k); },
    } as never);
    try { await closeSyncDatabase(); } catch {}
    await openSyncDatabase();
    setAuthProvider(() => "token-queue");
    setActiveBusiness({ id: BID } as never);
    setConnectivityState({ isOnline: true, isCloudReachable: "reachable" });
    (phoenixSocket as unknown as { getChannel?: unknown }).getChannel = undefined;

    posted.length = 0;
    setHttpClient({
      get: vi.fn(async () => ({ data: { data: [], pagination: { total_pages: 1 } } })) as never,
      post: vi.fn(async (url: string) => {
        posted.push(url);
        return { data: { data: { id: ORDER_ID, status: "accepted" } } };
      }) as never,
      put: vi.fn(async () => ({ data: {} })) as never,
      patch: vi.fn(async () => ({ data: {} })) as never,
      delete: vi.fn(async () => ({ data: {} })) as never,
    });
  });

  it("drains jobs created in the same millisecond in insertion order", async () => {
    const db = await openSyncDatabase();
    const createdAt = "2026-01-03T10:00:00.000Z";
    const jobs = [
      { id: "job-a", type: "order:accept" },
      { id: "job-b", type: "order:start_preparing" },
      { id: "job-c", type: "order:mark_ready" },
    ];
    for (const job of jobs) {
      await db.runAsync(
        `INSERT OR IGNORE INTO sync_jobs (id, business_id, command_type, entity_id, payload, status, created_at, updated_at) VALUES (?, ?, ?, ?, ?, 'pending', ?, ?);`,
        job.id,
        BID,
        job.type,
        ORDER_ID,
        JSON.stringify({ action: job.type.split(":")[1], orderId: ORDER_ID }),
        createdAt,
        createdAt,
      );
    }

    await drainPending(BID);
    // The chain between jobs of the same entity is scheduled with a short delay.
    await new Promise((r) => setTimeout(r, 400));

    const transitions = posted.filter((p) => p.startsWith(`/orders/${ORDER_ID}/`));
    expect(transitions).toEqual([
      `/orders/${ORDER_ID}/accept`,
      `/orders/${ORDER_ID}/start-preparing`,
      `/orders/${ORDER_ID}/ready-for-delivery`,
    ]);
  });

  it("promotes a paid awaiting order out of the payment queue locally", async () => {
    const db = await openSyncDatabase();
    await insertOrder(db, localOrder("awaiting_payment") as never);

    const updated = await transitionLocalOrder(BID, ORDER_ID, "confirm_cash");

    expect(updated.status).toBe("accepted");
    expect(updated.payment?.is_paid).toBe(true);
  });

  it("resolves payment:confirm_cash to the backend cash route", async () => {
    const db = await openSyncDatabase();
    await insertOrder(db, localOrder("awaiting_payment") as never);
    const now = new Date().toISOString();
    await db.runAsync(
      `INSERT OR IGNORE INTO sync_jobs (id, business_id, command_type, entity_id, payload, status, created_at, updated_at) VALUES (?, ?, ?, ?, ?, 'pending', ?, ?);`,
      "job-payment-confirm", BID, "payment:confirm_cash", ORDER_ID,
      JSON.stringify({ orderId: ORDER_ID }), now, now,
    );

    await drainPending(BID);

    expect(posted).toContain(`/orders/${ORDER_ID}/confirm-cash-payment`);
  });

  it("completes an ALREADY_PAID job and pulls the server status", async () => {
    const db = await openSyncDatabase();
    await insertOrder(db, localOrder("awaiting_payment") as never);
    const now = new Date().toISOString();
    await db.runAsync(
      `INSERT OR IGNORE INTO sync_jobs (id, business_id, command_type, entity_id, payload, status, created_at, updated_at) VALUES (?, ?, ?, ?, ?, 'pending', ?, ?);`,
      "job-already-paid", BID, "order:confirm_cash", ORDER_ID,
      JSON.stringify({ action: "confirm_cash", orderId: ORDER_ID }), now, now,
    );
    setHttpClient({
      get: vi.fn(async () => ({
        data: {
          data: [{
            ...localOrder("accepted"),
            is_paid: true,
            paid_at: now,
            payment: { is_paid: true, reference: "CASH-07-003-001", amount_minor: 3000, currency: "GHS", paid_at: now },
            updated_at: now,
          }],
          pagination: { total_pages: 1 },
        },
      })) as never,
      post: vi.fn(async () => {
        throw Object.assign(new Error("Order is already paid"), {
          status: 409,
          response: { status: 409, data: { error: { code: "ALREADY_PAID", message: "Order is already paid" } } },
        });
      }) as never,
      put: vi.fn(async () => ({ data: {} })) as never,
      patch: vi.fn(async () => ({ data: {} })) as never,
      delete: vi.fn(async () => ({ data: {} })) as never,
    });

    await drainPending(BID);

    const allJobs = await db.getAllAsync<{ id: string; status: string }>(
      `SELECT * FROM sync_jobs WHERE business_id = ?;`, BID,
    );
    const job = allJobs.find((row) => row.id === "job-already-paid");
    const order = await getOrderById(db, BID, ORDER_ID);
    expect(job?.status).toBe("completed");
    expect(order?.status).toBe("accepted");
    expect(order?.is_paid).toBe(true);
  });

  it("does not queue the same transition twice", async () => {
    const db = await openSyncDatabase();
    await insertOrder(db, localOrder("accepted") as never);

    // A pending transition already exists (double tap on another thread / replay).
    await db.runAsync(
      `INSERT OR IGNORE INTO sync_jobs (id, business_id, command_type, entity_id, payload, status, created_at, updated_at) VALUES (?, ?, ?, ?, ?, 'pending', ?, ?);`,
      "job-existing",
      BID,
      "order:start_preparing",
      ORDER_ID,
      JSON.stringify({ action: "start_preparing", orderId: ORDER_ID }),
      "2026-01-03T10:00:00.000Z",
      "2026-01-03T10:00:00.000Z",
    );

    await transitionLocalOrder(BID, ORDER_ID, "start_preparing");

    const rows = await db.getAllAsync<{ id: string; command_type: string; entity_id: string; status: string }>(
      `SELECT * FROM sync_jobs WHERE business_id = ?;`,
      BID,
    );
    const transitions = rows.filter(
      (r) => r.entity_id === ORDER_ID && r.command_type === "order:start_preparing" && r.status === "pending",
    );
    expect(transitions.length).toBe(1);
  });
});
