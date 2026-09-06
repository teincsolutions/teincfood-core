import { describe, it, expect, beforeEach, vi } from "vitest";
import { createMemoryDriver } from "../test-helpers/memory-driver";
import { setSqliteDriver } from "../adapters/sqlite";
import { setKVDriver } from "../adapters/kv";
import { setConnectivityState } from "../adapters/connectivity";
import { setAuthProvider, setAuthRefreshProvider, setAuthTokensProvider, setAuthClearProvider } from "../adapters/auth";
import { setHttpClient } from "../adapters/http";
import { setActiveBusiness } from "../adapters/business";
import { openSyncDatabase, closeSyncDatabase } from "../db/connection";
import { createLocalOrder, transitionLocalOrder } from "../domain/orders/service";
import { drainOne, pullRemoteOrders } from "./sync-jobs.service";
import { setItemSync, getItemSync } from "../adapters/kv";
import { phoenixSocket } from "../realtime/phoenix-socket";
import { seedOpenHours } from "../test-helpers/seed-hours";

const BUSINESS_ID = "0f0764da-53aa-48e4-ac40-3bfd8a52b0ec";
const USER_ID = "test-user";

describe("POS sync — full correct data like Desktop CartPanel", () => {
  let httpCalls: Array<{ url: string; body: unknown }>;
  let mockHttp: any;

  beforeEach(async () => {
    const mem = createMemoryDriver();
    setSqliteDriver(mem as any);
    // simple KV in-memory
    const kvStore = new Map<string, string>();
    setKVDriver({
      getItem: async (k: string) => kvStore.get(k) ?? null,
      setItem: async (k: string, v: string) => { kvStore.set(k, v); },
      removeItem: async (k: string) => { kvStore.delete(k); },
      getItemSync: (k: string) => kvStore.get(k) ?? null,
      setItemSync: (k: string, v: string) => { kvStore.set(k, v); },
      removeItemSync: (k: string) => { kvStore.delete(k); },
    } as any);
    // force PHX to fail so REST path is exercised
    (phoenixSocket as any).getChannel = undefined;
    // need to reset DB instance between tests
    try { await closeSyncDatabase(); } catch {}
    // set device lease DD 01-99
    setItemSync(`teinc_device_number:${BUSINESS_ID}`, "07");
    // start offline so auto drainOne from createLocalOrder does not consume job before test
    setConnectivityState({ isOnline: false, isCloudReachable: "unreachable" });
    setAuthProvider(() => "token-123");
    setAuthRefreshProvider(() => "refresh-123");
    setAuthTokensProvider(() => {});
    setAuthClearProvider(() => {});
    setActiveBusiness({ id: BUSINESS_ID } as any);

    httpCalls = [];
    mockHttp = {
      get: vi.fn(async (url: string) => {
        httpCalls.push({ url, body: null });
        if (url.includes(`/businesses/${BUSINESS_ID}/orders`)) {
          return { data: { data: [], pagination: { total_pages: 1 } } };
        }
        return { data: {} };
      }),
      post: vi.fn(async (url: string, body?: unknown) => {
        httpCalls.push({ url, body });
        // Simulate backend NoRouteError for old endpoint — should NOT be called
        if (url.includes("/orders/sync")) {
          const err: any = new Error("no route found for POST /orders/sync");
          err.status = 500;
          err.response = { status: 500, data: { error: { code: "NOT_FOUND", message: "no route" } } };
          throw err;
        }
        // POS create endpoint
        if (url === `/businesses/${BUSINESS_ID}/pos/orders`) {
          // validate payload shape like backend expects
          const b = body as Record<string, any>;
          expect(b.id).toBeDefined();
          expect(b.local_order_number).toMatch(/^[0-9]{2}-[0-9]{3}-[0-9]{3}$/);
          expect(b.items).toBeDefined();
          expect(Array.isArray(b.items)).toBe(true);
          expect(b.items[0].menu_item_id).toBeDefined();
          // order_type and pos_payment_method required
          expect(["takeout","dine_in","delivery"]).toContain(b.order_type);
          expect(["cash","mobile_money"]).toContain(b.pos_payment_method);
          return { data: { data: { id: b.id, order_number: b.local_order_number } } };
        }
        // transitions
        if (url.includes("/orders/") && (url.endsWith("/complete-pickup") || url.endsWith("/start-preparing") || url.endsWith("/ready-for-delivery") || url.endsWith("/accept") || url.endsWith("/confirm-cash-payment") || url.endsWith("/cancel"))) {
          return { data: { data: {} } };
        }
        throw new Error(`unexpected POST ${url}`);
      }),
    };
    setHttpClient(mockHttp);
    // ensure DB migrated
    await openSyncDatabase();
    // creation is fail-closed on operating hours — seed 24/7
    await seedOpenHours(BUSINESS_ID);
  });

  it("create POS order with full CartPanel data syncs via POST /businesses/:id/pos/orders (not /orders/sync)", async () => {
    const order = await createLocalOrder(BUSINESS_ID, {
      order_type: "takeout",
      customer_name: "Walk-in Customer",
      customer_phone: "0550000111",
      pos_payment_method: "cash",
      items: [
        { menu_item_id: "item-1", quantity: 2, variant_id: "var-1", addon_ids: ["addon-1"] } as any,
      ],
      item_snapshots: [
        { menu_item_id: "item-1", name: "Jollof", quantity: 2, unit_price_minor: 2500, variant_name: "Large", addons: [{ name: "Extra meat", price_minor: 500 }] } as any,
      ],
      total_minor: 5500,
      subtotal_minor: 5000,
      tax_minor: 500,
      tax_lines: [{ id: "tax1", name: "VAT", rate_basis_points: 1250, tax_amount_minor: 500, is_inclusive: false }] as any,
      currency_code: "GHS",
    } as any);

    expect(order.order_number).toMatch(/^[0-9]{2}-[0-9]{3}-[0-9]{3}$/);
    expect(order.order_number).not.toBe("[object Object]");
    expect(order.id).toBeDefined();
    // should have created sync_job
    const db = await openSyncDatabase();
    const job = await db.getFirstAsync<any>(`SELECT * FROM sync_jobs WHERE business_id = ? AND entity_id = ? AND status='pending' ORDER BY created_at LIMIT 1;`, BUSINESS_ID, order.id);
    expect(job).toBeTruthy();
    expect(job.command_type).toBe("order:create");

    // drain should POST to correct endpoint, not old /orders/sync
    setConnectivityState({ isOnline: true, isCloudReachable: "reachable" });
    httpCalls = [];
    await drainOne(BUSINESS_ID, order.id);
    expect(httpCalls.length).toBe(1);
    expect(httpCalls[0].url).toBe(`/businesses/${BUSINESS_ID}/pos/orders`);
    expect(httpCalls[0].url).not.toContain("/orders/sync");
    // payload should contain local_order_number, not just order_number
    const body = httpCalls[0].body as Record<string, any>;
    expect(body.local_order_number).toBe(order.order_number);
    expect(body.id).toBe(order.id);
    expect(body.items).toBeDefined();

    // job should be completed
    const after = await db.getFirstAsync<any>(`SELECT * FROM sync_jobs WHERE business_id = ? AND entity_id = ? AND status='pending' ORDER BY created_at LIMIT 1;`, BUSINESS_ID, order.id);
    expect(after).toBeNull();
  });

  it("transition complete_pickup syncs via POST /orders/:id/complete-pickup", async () => {
    const order = await createLocalOrder(BUSINESS_ID, {
      order_type: "dine_in",
      customer_name: "Dine In",
      pos_payment_method: "cash",
      items: [{ menu_item_id: "item-1", quantity: 1 } as any],
      item_snapshots: [{ menu_item_id: "item-1", name: "Burger", quantity: 1, unit_price_minor: 3000 } as any],
      total_minor: 3000,
      subtotal_minor: 3000,
      tax_minor: 0,
      tax_lines: [],
      currency_code: "GHS",
    } as any);
    // accepted -> preparing -> ready
    await transitionLocalOrder(BUSINESS_ID, order.id, "start_preparing");
    await transitionLocalOrder(BUSINESS_ID, order.id, "mark_ready");
    // check ready
    setConnectivityState({ isOnline: true, isCloudReachable: "reachable" });
    let db = await openSyncDatabase();
    let cur = await db.getFirstAsync<any>(`SELECT * FROM orders WHERE business_id = ? AND (id = ? OR order_number = ?) LIMIT 1;`, BUSINESS_ID, order.id, order.id);
    // our memory driver stores status, need to check via get
    // use drain for ready already created jobs, clear calls
    httpCalls = [];
    // drain start_preparing
    await drainOne(BUSINESS_ID, order.id); // will drain first pending (start_preparing)
    // Need to drain all pending sequentially; easiest call pull
    // Instead drain each pending via loop
    const jobs = await db.getAllAsync<any>(`SELECT * FROM sync_jobs WHERE business_id = ? AND status='pending' ORDER BY created_at`, BUSINESS_ID);
    for (const j of jobs) {
      await drainOne(BUSINESS_ID, j.entity_id);
    }
    // verify at least one call was to start-preparing or ready
    const urls = httpCalls.map(c => c.url);
    expect(urls.some(u => u.includes("/start-preparing") || u.includes("/ready-for-delivery"))).toBe(true);

    // now complete pickup
    httpCalls = [];
    await transitionLocalOrder(BUSINESS_ID, order.id, "complete_pickup");
    await drainOne(BUSINESS_ID, order.id);
    expect(httpCalls.some(c => c.url === `/orders/${order.id}/complete-pickup`)).toBe(true);

    // verify order delivered
    const after = await db.getFirstAsync<any>(`SELECT * FROM orders WHERE business_id = ? AND (id = ? OR order_number = ?) LIMIT 1;`, BUSINESS_ID, order.id, order.id);
    // via memory driver, status should be delivered
    // get via domain helper to be safe
    const { getOrderById } = await import("../db/operations");
    const fetched = await getOrderById(await openSyncDatabase(), BUSINESS_ID, order.id);
    expect(fetched?.status).toBe("delivered");
  });

  it("409 ORDER_NUMBER_TAKEN regenerates RRR and keeps same UUID", async () => {
    // mock that first POST returns 409, second succeeds
    let callCount = 0;
    mockHttp.post = vi.fn(async (url: string, body?: unknown) => {
      httpCalls.push({ url, body });
      if (url === `/businesses/${BUSINESS_ID}/pos/orders`) {
        callCount++;
        if (callCount === 1) {
          const err: any = new Error("ORDER_NUMBER_TAKEN");
          err.status = 409;
          err.response = { status: 409, data: { error: { code: "ORDER_NUMBER_TAKEN", message: "Order number already taken" } } };
          err.message = "ORDER_NUMBER_TAKEN";
          throw err;
        }
        return { data: { data: { id: (body as any).id } } };
      }
      return { data: {} };
    });

    const order = await createLocalOrder(BUSINESS_ID, {
      order_type: "takeout",
      pos_payment_method: "cash",
      items: [{ menu_item_id: "item-1", quantity: 1 } as any],
      item_snapshots: [{ menu_item_id: "item-1", name: "Test", quantity: 1, unit_price_minor: 1000 } as any],
      total_minor: 1000,
      subtotal_minor: 1000,
      tax_minor: 0,
      tax_lines: [],
      currency_code: "GHS",
    } as any);
    const originalNumber = order.order_number;
    const originalId = order.id;
    setConnectivityState({ isOnline: true, isCloudReachable: "reachable" });
    httpCalls = [];
    await drainOne(BUSINESS_ID, order.id);
    // first call 409, should regen RRR and keep pending
    expect(callCount).toBe(1);
    // check sync_jobs payload updated with new number
    const db = await openSyncDatabase();
    const job = await db.getFirstAsync<any>(`SELECT * FROM sync_jobs WHERE business_id = ? AND entity_id = ? AND status='pending' ORDER BY created_at LIMIT 1;`, BUSINESS_ID, order.id);
    expect(job).toBeTruthy();
    const payload = JSON.parse(job.payload);
    expect(payload.order_number).not.toBe(originalNumber);
    expect(payload.order_number).toMatch(/^[0-9]{2}-[0-9]{3}-[0-9]{3}$/);
    // order row also updated
    const { getOrderById } = await import("../db/operations");
    const updated = await getOrderById(await openSyncDatabase(), BUSINESS_ID, originalId);
    expect(updated?.order_number).toBe(payload.order_number);
    expect(updated?.id).toBe(originalId); // same UUID

    // second drain should succeed with new number
    httpCalls = [];
    await drainOne(BUSINESS_ID, order.id);
    expect(httpCalls[0].url).toBe(`/businesses/${BUSINESS_ID}/pos/orders`);
    const body2 = httpCalls[0].body as any;
    expect(body2.local_order_number).toBe(payload.order_number);
  });
});
