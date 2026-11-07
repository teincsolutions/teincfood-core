import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { createMemoryDriver } from "../test-helpers/memory-driver";
import { setSqliteDriver } from "../adapters/sqlite";
import { setKVDriver } from "../adapters/kv";
import { setAuthProvider } from "../adapters/auth";
import { setActiveBusiness } from "../adapters/business";
import { setHttpClient } from "../adapters/http";
import { setConnectivityState } from "../adapters/connectivity";
import { openSyncDatabase, closeSyncDatabase } from "../db/connection";
import { insertCommand, insertOrder, getOrderById } from "../db/operations";
import { drainOne } from "./sync-jobs.service";
import { commandQueueService } from "./command-queue.service";
import { phoenixSocket } from "../realtime/phoenix-socket";

const BID = "biz-menu-order-gate";
const ORDER_ID = "aaaaaaaa-1111-4111-8111-aaaaaaaaaaaa";
const ITEM_ID = "bbbbbbbb-2222-4222-8222-bbbbbbbbbbbb";
const JOB_ID = "job-order-menu-gate";

function localOrder(updatedAt: string): Record<string, unknown> {
  return {
    id: ORDER_ID,
    business_id: BID,
    order_number: "07-001-009",
    callout_number: 9,
    status: "pending",
    order_type: "takeout",
    is_pos: 1,
    items: "[]",
    subtotal_minor: 3500,
    total_minor: 3500,
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

describe("order drain menu dependency gate", () => {
  let httpPost: ReturnType<typeof vi.fn>;

  beforeEach(async () => {
    setSqliteDriver(createMemoryDriver() as never);
    const kvStore = new Map<string, string>();
    setKVDriver({
      getItem: async (k: string) => kvStore.get(k) ?? null,
      setItem: async (k: string, v: string) => {
        kvStore.set(k, v);
      },
      removeItem: async (k: string) => {
        kvStore.delete(k);
      },
      getItemSync: (k: string) => kvStore.get(k) ?? null,
      setItemSync: (k: string, v: string) => {
        kvStore.set(k, v);
      },
      removeItemSync: (k: string) => {
        kvStore.delete(k);
      },
    } as never);
    try {
      await closeSyncDatabase();
    } catch {}
    await openSyncDatabase();
    setAuthProvider(() => "token-123");
    setActiveBusiness({ id: BID } as never);
    setConnectivityState({ isOnline: true, isCloudReachable: "reachable" });
    (phoenixSocket as unknown as { getChannel?: unknown }).getChannel = undefined;
    httpPost = vi.fn(async () => ({ data: {} }));
    setHttpClient({
      get: vi.fn(async () => ({ data: { data: [] } })),
      post: httpPost,
    } as never);
  });

  afterEach(() => {
    vi.useRealTimers();
    vi.restoreAllMocks();
  });

  async function seedOrderCreate(): Promise<void> {
    const db = await openSyncDatabase();
    const now = new Date().toISOString();
    await insertOrder(db, localOrder(now) as never);
    await db.runAsync(
      `INSERT OR IGNORE INTO sync_jobs (id, business_id, command_type, entity_id, payload, status, created_at, updated_at) VALUES (?, ?, ?, ?, ?, 'pending', ?, ?);`,
      JOB_ID,
      BID,
      "order:create",
      ORDER_ID,
      JSON.stringify({
        id: ORDER_ID,
        items: [{ menu_item_id: ITEM_ID, quantity: 1 }],
        item_snapshots: [{ menu_item_id: ITEM_ID, quantity: 1 }],
      }),
      now,
      now,
    );
  }

  async function seedMenuCommand(status: "pending" | "failed"): Promise<void> {
    const db = await openSyncDatabase();
    await insertCommand(db, {
      command: {
        command_id: "cmd-menu-gate",
        command_type: "menu:create_item",
        command_version: "1.0",
        timestamp: new Date().toISOString(),
        business_id: BID,
        entity_id: ITEM_ID,
        user_id: "user-1",
        device_id: "device-1",
        payload: { id: ITEM_ID, name: "Offline Item" },
      },
      status,
    });
  }

  it("defers an order while a referenced menu item is still pending sync", async () => {
    await seedOrderCreate();
    await seedMenuCommand("pending");
    vi.spyOn(commandQueueService, "replay").mockResolvedValue();
    vi.useFakeTimers();

    await drainOne(BID, ORDER_ID);

    expect(httpPost).not.toHaveBeenCalled();
    const db = await openSyncDatabase();
    const job = await db.getFirstAsync<{ status: string; attempts: number }>(
      `SELECT * FROM sync_jobs WHERE id = ?;`,
      JOB_ID,
    );
    expect(job?.status).toBe("pending");
    expect(job?.attempts).toBe(0);
  });

  it("fails the order when its referenced menu item failed to sync", async () => {
    await seedOrderCreate();
    await seedMenuCommand("failed");

    await drainOne(BID, ORDER_ID);

    expect(httpPost).not.toHaveBeenCalled();
    const db = await openSyncDatabase();
    const job = await db.getFirstAsync<{ status: string; last_error: string }>(
      `SELECT * FROM sync_jobs WHERE id = ?;`,
      JOB_ID,
    );
    expect(job?.status).toBe("failed");
    expect(job?.last_error).toBe("menu_item_sync_failed");
    const order = await getOrderById(db, BID, ORDER_ID);
    expect(
      (order as unknown as { sync_failed_at?: string | null })?.sync_failed_at,
    ).toBeTruthy();
  });
});
