import { describe, it, expect, beforeEach, vi } from "vitest";
import { createMemoryDriver } from "../test-helpers/memory-driver";
import { setSqliteDriver } from "../adapters/sqlite";
import { setKVDriver } from "../adapters/kv";
import { setAuthProvider } from "../adapters/auth";
import { setActiveBusiness } from "../adapters/business";
import { setHttpClient } from "../adapters/http";
import { setConnectivityState } from "../adapters/connectivity";
import { openSyncDatabase, closeSyncDatabase } from "../db/connection";
import { insertOrder } from "../db/operations";
import { drainOne } from "./sync-jobs.service";
import { phoenixSocket } from "../realtime/phoenix-socket";

const BID = "biz-drain-retry-test";
const ORDER_ID = "33333333-3333-4333-8333-333333333333";
const JOB_ID = "job-422-test";

function localOrder(status: string, updatedAt: string): Record<string, unknown> {
  return {
    id: ORDER_ID,
    business_id: BID,
    order_number: "07-001-004",
    callout_number: 4,
    status,
    order_type: "takeout",
    is_pos: 1,
    items: "[]",
    subtotal_minor: 5000,
    total_minor: 5000,
    tax_minor: 0,
    tax_lines: "[]",
    payment: "{}",
    customer_name: null,
    customer_phone: null,
    pos_payment_method: "cash",
    delivery_id: null,
    business: null,
    user: null,
    inserted_at: updatedAt,
    updated_at: updatedAt,
  };
}

describe("drainOne bounded 4xx retry + absorb", () => {
  let serverStatus: string;
  const serverUpdatedAt = new Date(Date.now() + 60_000).toISOString();

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
    setAuthProvider(() => "token-123");
    setActiveBusiness({ id: BID } as never);
    setConnectivityState({ isOnline: true, isCloudReachable: "reachable" });
    (phoenixSocket as unknown as { getChannel?: unknown }).getChannel = undefined;
    serverStatus = "accepted";
    const err422 = Object.assign(new Error("Cannot mark_ready from accepted"), {
      status: 422,
      response: { status: 422, data: { error: { code: "INVALID_TRANSITION", message: "Cannot mark_ready" } } },
    });
    setHttpClient({
      get: vi.fn(async (url: string) => {
        if (url.includes(`/businesses/${BID}/orders`)) {
          return { data: { data: [localOrder(serverStatus, serverUpdatedAt)], pagination: { total_pages: 1 } } };
        }
        return { data: { data: [] } };
      }),
      post: vi.fn(async (url: string) => {
        if (url.includes("/ready-for-delivery")) throw err422;
        return { data: {} };
      }),
    } as never);
  });

  async function seedJob(): Promise<void> {
    const db = await openSyncDatabase();
    await insertOrder(db, localOrder("accepted", new Date().toISOString()) as never);
    const now = new Date().toISOString();
    await db.runAsync(
      `INSERT OR IGNORE INTO sync_jobs (id, business_id, command_type, entity_id, payload, status, created_at, updated_at) VALUES (?, ?, ?, ?, ?, 'pending', ?, ?);`,
      JOB_ID, BID, "order:mark_ready", ORDER_ID,
      JSON.stringify({ action: "mark_ready", orderId: ORDER_ID }), now, now,
    );
  }

  async function jobRow(): Promise<{ status: string; attempts: number } | null> {
    const db = await openSyncDatabase();
    return db.getFirstAsync<{ status: string; attempts: number }>(
      `SELECT * FROM sync_jobs WHERE business_id = ? AND entity_id = ? AND status='pending';`,
      BID, ORDER_ID,
    );
  }

  async function anyJobRow(): Promise<{ status: string; attempts: number } | null> {
    const db = await openSyncDatabase();
    const rows = await db.getAllAsync<{ status: string; attempts: number }>(
      `SELECT * FROM sync_jobs WHERE business_id = ?;`, BID,
    );
    return (rows as unknown as Array<{ status: string; attempts: number }>)[0] ?? null;
  }

  it("422 race stays pending with attempts=1 (no instant fail)", async () => {
    await seedJob();
    await drainOne(BID, ORDER_ID);
    const row = await jobRow();
    expect(row?.status).toBe("pending");
    expect(row?.attempts).toBe(1);
  });

  it("absorbs and completes when the server is already ready", async () => {
    serverStatus = "ready";
    await seedJob();
    await drainOne(BID, ORDER_ID);
    expect(await jobRow()).toBeNull();
    const row = await anyJobRow();
    expect(row?.status).toBe("completed");
  });

  it("8th attempt marks failed (4xx cap)", async () => {
    await seedJob();
    const db = await openSyncDatabase();
    for (let i = 0; i < 7; i++) {
      await db.runAsync(`UPDATE sync_jobs SET attempts = attempts + 1, last_error = ?, updated_at = ? WHERE id = ?;`, "422", new Date().toISOString(), JOB_ID);
    }
    await drainOne(BID, ORDER_ID);
    const row = await anyJobRow();
    expect(row?.status).toBe("failed");
  });
});
