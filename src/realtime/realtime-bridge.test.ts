import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import { createMemoryDriver } from "../test-helpers/memory-driver";
import { setSqliteDriver } from "../adapters/sqlite";
import { setKVDriver } from "../adapters/kv";
import { setAuthProvider } from "../adapters/auth";
import { setActiveBusiness } from "../adapters/business";
import { setHttpClient } from "../adapters/http";
import { setConnectivityState } from "../adapters/connectivity";
import { openSyncDatabase, closeSyncDatabase } from "../db/connection";
import { insertOrder, getOrderById } from "../db/operations";
import { eventsService } from "./events.service";
import { phoenixSocket } from "./phoenix-socket";
import { syncEngine } from "../sync/engine";
import { subscribeGlobalRealtime } from "./realtime-bridge";
import type { SellerOrder } from "../types/api/seller.api";

const BID = "biz-bridge-test";
const ORDER_ID = "55555555-5555-4555-8555-555555555555";

function serverOrder(): SellerOrder {
  return {
    id: ORDER_ID,
    business_id: BID,
    order_number: "07-002-001",
    callout_number: 1,
    status: "pending",
    order_type: "takeout",
    is_pos: true,
    items: [],
    subtotal_minor: 2000,
    total_minor: 2000,
    tax_minor: 0,
    tax_lines: [],
    payment: { is_paid: false, reference: null, amount_minor: 2000, currency: "GHS", paid_at: null },
    customer_name: null,
    customer_phone: null,
    pos_payment_method: "cash",
    delivery_id: null,
    business: null,
    user: null,
    currency: "GHS",
    currency_code: "GHS",
    inserted_at: "2026-01-02T09:00:00.000Z",
    updated_at: "2026-01-02T09:00:00.000Z",
  } as unknown as SellerOrder;
}

type FrameHandler = (args: unknown[]) => void;

describe("global realtime bridge", () => {
  let frameHandler: FrameHandler | null = null;
  const httpGet = vi.fn();

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
    setAuthProvider(() => "token-bridge");
    setActiveBusiness({ id: BID } as never);
    setConnectivityState({ isOnline: true, isCloudReachable: "reachable" });

    httpGet.mockReset();
    httpGet.mockImplementation(async (url: string, config?: { params?: Record<string, unknown> }) => {
      if (url.includes(`/businesses/${BID}/orders`)) {
        const params = config?.params ?? {};
        // A single-order fetch is filtered by order_number; a list pull is not.
        if (params.order_number) {
          return { data: { data: [serverOrder()], pagination: { total_pages: 1 } } };
        }
        return { data: { data: [], pagination: { total_pages: 1 } } };
      }
      return { data: { data: [] } };
    });
    setHttpClient({
      get: httpGet as never,
      post: vi.fn(async () => ({ data: {} })) as never,
      put: vi.fn(async () => ({ data: {} })) as never,
      patch: vi.fn(async () => ({ data: {} })) as never,
      delete: vi.fn(async () => ({ data: {} })) as never,
    });

    frameHandler = null;
    vi.spyOn(phoenixSocket, "onFrame").mockImplementation(((_topic: string, handler: FrameHandler) => {
      frameHandler = handler;
      return () => { frameHandler = null; };
    }) as never);
    vi.spyOn(phoenixSocket, "connect").mockResolvedValue(undefined as never);
    vi.spyOn(phoenixSocket, "joinChannel").mockResolvedValue(undefined as never);
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  function emit(eventType: string, payload: Record<string, unknown>): void {
    const handler = frameHandler;
    expect(handler).toBeTruthy();
    handler!([1, 1, "events:user-1", eventType, payload]);
  }

  it("publishes a cloud order.created event to the sync engine", async () => {
    const published: string[] = [];
    vi.spyOn(syncEngine, "publish").mockImplementation((event) => {
      published.push(event.event_type);
    });

    const disconnectEvents = eventsService.connect("user-1", BID);
    const releaseBridge = subscribeGlobalRealtime();

    emit("order.created", {
      business_id: BID,
      order_id: ORDER_ID,
      order_number: "07-002-001",
    });

    expect(published).toContain("order.created");

    releaseBridge();
    disconnectEvents();
  });

  it("fetches only the unknown order — never the whole list", async () => {
    vi.spyOn(syncEngine, "publish").mockImplementation(() => undefined);

    const disconnectEvents = eventsService.connect("user-1", BID);
    const releaseBridge = subscribeGlobalRealtime();

    emit("order.created", {
      business_id: BID,
      order_id: ORDER_ID,
      order_number: "07-002-001",
    });

    await new Promise((r) => setTimeout(r, 700));

    const orderCalls = httpGet.mock.calls.filter((c) => String(c[0]).includes("/orders"));
    expect(orderCalls.length).toBe(1);
    expect((orderCalls[0][1] as { params?: Record<string, unknown> })?.params?.order_number).toBe("07-002-001");

    // The fetched order landed in the local read model.
    const row = await getOrderById(await openSyncDatabase(), BID, ORDER_ID);
    expect(row?.id).toBe(ORDER_ID);

    releaseBridge();
    disconnectEvents();
  });

  it("does not re-fetch an order this device already has", async () => {
    vi.spyOn(syncEngine, "publish").mockImplementation(() => undefined);
    const db = await openSyncDatabase();
    await insertOrder(db, serverOrder() as never);

    const disconnectEvents = eventsService.connect("user-1", BID);
    const releaseBridge = subscribeGlobalRealtime();

    emit("order.created", {
      business_id: BID,
      order_id: ORDER_ID,
      order_number: "07-002-001",
    });

    await new Promise((r) => setTimeout(r, 700));

    const orderCalls = httpGet.mock.calls.filter((c) => String(c[0]).includes("/orders"));
    expect(orderCalls.length).toBe(0);

    releaseBridge();
    disconnectEvents();
  });

  it("ignores events that belong to another business", async () => {
    const published: string[] = [];
    vi.spyOn(syncEngine, "publish").mockImplementation((event) => {
      published.push(event.event_type);
    });

    const disconnectEvents = eventsService.connect("user-1", BID);
    const releaseBridge = subscribeGlobalRealtime();

    emit("order.created", {
      business_id: "some-other-business",
      order_id: "66666666-6666-4666-8666-666666666666",
      order_number: "09-009-009",
    });

    await new Promise((r) => setTimeout(r, 300));

    expect(published).toHaveLength(0);
    const orderCalls = httpGet.mock.calls.filter((c) => String(c[0]).includes("/orders"));
    expect(orderCalls.length).toBe(0);

    releaseBridge();
    disconnectEvents();
  });
});
