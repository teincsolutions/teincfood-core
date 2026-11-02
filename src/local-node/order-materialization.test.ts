import { describe, it, expect, beforeEach, vi } from "vitest";
import { createMemoryDriver } from "../test-helpers/memory-driver";
import { setSqliteDriver } from "../adapters/sqlite";
import { setKVDriver } from "../adapters/kv";
import { setAppInstanceId } from "../adapters/devices";
import { localNodeStore } from "./store";
import { localNodeService, initLocalNodeService } from "./service";
import { openSyncDatabase, closeSyncDatabase } from "../db/connection";
import { getOrderById } from "../db/operations";
import { listLocalOrders } from "../domain/orders/service";
import { registerPendingOrdersInvalidator } from "../sync/pending-orders.service";
import type { DomainEvent } from "../sync/types";
import type { DiscoveryAdapter, TransportAdapter } from "./adapters";

const BIZ = "biz-mesh-orders";

class MockDiscovery implements DiscoveryAdapter {
  setOptions(_o: any) {}
  startScanning() {}
  stopScanning() {}
  startPublishing(_o: any) {}
  stop() {}
}

function fullOrder(overrides: Record<string, unknown> = {}) {
  return {
    id: "order-lan-1",
    business_id: BIZ,
    order_number: "07-001-001",
    callout_number: null,
    status: "pending",
    order_type: "dine_in",
    is_pos: true,
    items: [],
    subtotal_minor: 5000,
    total_minor: 5000,
    tax_minor: 0,
    tax_lines: [],
    // Never null: orderRowToSellerOrder does JSON.parse(payment).currency.
    payment: { method: "cash", is_paid: false, paid_at: null, currency: "GHS" },
    customer_name: null,
    customer_phone: null,
    pos_payment_method: "cash",
    delivery_id: null,
    business: null,
    user: null,
    inserted_at: new Date().toISOString(),
    ...overrides,
  };
}

function lanEvent(type: string, payload: Record<string, unknown>): DomainEvent {
  return {
    event_id: `evt-${Math.random().toString(36).slice(2)}`,
    event_type: type,
    event_version: "1.0",
    entity_id: (payload.id as string) ?? "unknown",
    user_id: "u-peer",
    device_id: "device-peer",
    payload,
    timestamp: new Date().toISOString(),
  };
}

describe("mesh LAN order.created materialization", () => {
  let capturedOnEvent: ((e: DomainEvent) => void) | null = null;
  let capturedOnRelay: ((e: DomainEvent) => void) | null = null;

  beforeEach(async () => {
    capturedOnEvent = null;
    capturedOnRelay = null;
    const mem = createMemoryDriver();
    setSqliteDriver(mem as any);
    const kvStore = new Map<string, string>();
    setKVDriver({
      getItem: async (k: string) => kvStore.get(k) ?? null,
      setItem: async (k: string, v: string) => { kvStore.set(k, v); },
      removeItem: async (k: string) => { kvStore.delete(k); },
    } as any);
    try { await closeSyncDatabase(); } catch {}
    await openSyncDatabase();
    (localNodeStore as any)._reset();
    await localNodeService.shutdown().catch(() => {});
    setAppInstanceId("device-mesh-desk");

    const transport: TransportAdapter = {
      createServer: (opts: any) => {
        capturedOnRelay = opts.onRelayEvent;
        return {
          start: async () => {},
          stop: async () => {},
          isListening: () => true,
          broadcast: () => {},
        };
      },
      createClient: (opts: any) => {
        capturedOnEvent = opts.onEvent;
        return {
          connect: async () => { opts.onConnected(); },
          disconnect: () => {},
          isConnected: () => true,
          execute: async () => [],
          requestReferenceData: async () => ({ data: {} }),
        };
      },
    } as unknown as TransportAdapter;

    localNodeStore.getState().setIsLocalNodeEnabled(true);
    initLocalNodeService({
      getDeviceId: () => "device-mesh-desk",
      getDeviceName: () => "Desk",
      getBusiness: () => ({ id: BIZ, ownerId: "o1" }) as any,
      getAuth: () => ({ user: { id: "u1" }, accessToken: "tok" }),
      discovery: new MockDiscovery() as any,
      transport: transport as any,
    });
    await localNodeService.initialize();
    localNodeStore.getState().addDiscoveredNode({
      deviceId: "device-peer",
      name: "peer",
      host: "192.168.1.42",
      port: 44621,
      deviceName: "Peer",
      lastSeenAt: new Date().toISOString(),
    } as any);
    await new Promise((r) => setTimeout(r, 50));
    expect(capturedOnEvent).not.toBeNull();
    expect(capturedOnRelay).not.toBeNull();
  });

  async function receive(event: DomainEvent) {
    capturedOnEvent!(event);
    // onEvent materialization runs in a fire-and-forget async IIFE.
    await new Promise((r) => setTimeout(r, 200));
  }

  async function receiveRelay(event: DomainEvent) {
    capturedOnRelay!(event);
    // onRelayEvent materialization runs in a fire-and-forget async IIFE.
    await new Promise((r) => setTimeout(r, 200));
  }

  it("materializes a local-shape LAN order.created (with local_order_number)", async () => {
    const db = await openSyncDatabase();
    await receive(lanEvent("order.created", {
      ...fullOrder(),
      local_order_number: "07-001-001",
    }));
    const row = await getOrderById(db, BIZ, "order-lan-1");
    expect(row?.order_number).toBe("07-001-001");
    // Kiosk read path (POS In Progress) sees it too.
    const listed = await listLocalOrders(BIZ, {}, 1, 100);
    expect(listed.data.map((o) => o.order_number)).toContain("07-001-001");
  });

  it("materializes a cloud-shape LAN order.created (no local_order_number)", async () => {
    const db = await openSyncDatabase();
    await receive(lanEvent("order.created", fullOrder({
      id: "cloud-uuid-9",
      order_number: "07-001-002",
    })));
    const row = await getOrderById(db, BIZ, "cloud-uuid-9");
    expect(row?.order_number).toBe("07-001-002");
  });

  it("materializes LAN order.status_changed full-row echoes", async () => {
    const db = await openSyncDatabase();
    await receive(lanEvent("order.created", fullOrder()));
    await receive(lanEvent("order.status_changed", {
      ...fullOrder(),
      status: "preparing",
      order_id: "order-lan-1",
    }));
    const row = await getOrderById(db, BIZ, "order-lan-1");
    expect(row?.status).toBe("preparing");
  });

  it("fires the pending-orders invalidator so lists refetch", async () => {
    const spy = vi.fn();
    const unreg = registerPendingOrdersInvalidator(spy);
    try {
      await receive(lanEvent("order.created", fullOrder()));
      expect(spy).toHaveBeenCalled();
    } finally {
      unreg();
    }
  });

  it("ignores LAN order events for another business", async () => {
    const db = await openSyncDatabase();
    await receive(lanEvent("order.created", fullOrder({
      id: "order-foreign",
      business_id: "biz-foreign",
      order_number: "99-001-001",
    })));
    expect(await getOrderById(db, BIZ, "order-foreign")).toBeNull();
    expect(await getOrderById(db, "biz-foreign", "order-foreign")).toBeNull();
  });

  it("repeat delivery is idempotent (no duplicate rows)", async () => {
    const db = await openSyncDatabase();
    const evt = lanEvent("order.created", fullOrder());
    await receive(evt);
    await receive({ ...evt, event_id: "evt-duplicate" });
    const listed = await listLocalOrders(BIZ, {}, 1, 100);
    expect(listed.data.filter((o) => o.id === "order-lan-1")).toHaveLength(1);
  });
  it("materializes an order relayed by a client that completed the sale over the cloud", async () => {
    const db = await openSyncDatabase();
    await receiveRelay(lanEvent("order.created", fullOrder({
      id: "cloud-path-order",
      order_number: "07-001-003",
    })));
    const row = await getOrderById(db, BIZ, "cloud-path-order");
    expect(row?.order_number).toBe("07-001-003");
  });

  it("applies relayed order.sync catch-up rows", async () => {
    const db = await openSyncDatabase();
    await receiveRelay(lanEvent("order:sync", fullOrder({
      id: "catchup-order",
      order_number: "07-001-004",
      hlc: "2026-01-01T10:00:00.000Z",
    })));
    const row = await getOrderById(db, BIZ, "catchup-order");
    expect(row?.order_number).toBe("07-001-004");
  });

  it("fires the pending-orders invalidator for relayed order events", async () => {
    const spy = vi.fn();
    const unreg = registerPendingOrdersInvalidator(spy);
    try {
      await receiveRelay(lanEvent("order.created", fullOrder({
        id: "relay-invalidate",
        order_number: "07-001-005",
      })));
      expect(spy).toHaveBeenCalled();
    } finally {
      unreg();
    }
  });

});
