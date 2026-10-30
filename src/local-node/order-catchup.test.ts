import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { createMemoryDriver } from "../test-helpers/memory-driver";
import { setSqliteDriver } from "../adapters/sqlite";
import { setKVDriver } from "../adapters/kv";
import { setAppInstanceId } from "../adapters/devices";
import { setActiveBusiness } from "../adapters/business";
import { setAuthProvider } from "../adapters/auth";
import { localNodeStore } from "./store";
import { initLocalNodeService, localNodeService } from "./service";
import { openSyncDatabase, closeSyncDatabase } from "../db/connection";
import { insertOrder } from "../db/operations";
import { usePendingOrdersStore } from "../adapters/pending-orders";
import type { DomainEvent } from "../sync/types";
import type { DiscoveryAdapter, TransportAdapter } from "./adapters";
import type { SellerOrder } from "../types/api/seller.api";

const BID = "biz-order-catchup";
const DEVICE_ID = "device-catchup-desk";
const PEER_ID = "device-catchup-peer";

class MockDiscovery implements DiscoveryAdapter {
  setOptions(_o: unknown) {}
  startScanning() {}
  stopScanning() {}
  startPublishing(_o: unknown) {}
  stop() {}
}

function order(overrides: Partial<SellerOrder> = {}): SellerOrder {
  return {
    id: "order-catchup-1",
    business_id: BID,
    order_number: "07-001-009",
    callout_number: 9,
    status: "accepted",
    order_type: "takeout",
    is_pos: true,
    items: [],
    subtotal_minor: 1500,
    total_minor: 1500,
    tax_minor: 0,
    tax_lines: [],
    payment: {
      is_paid: true,
      reference: null,
      amount_minor: 1500,
      currency: "GHS",
      paid_at: new Date().toISOString(),
    },
    customer_name: null,
    customer_phone: null,
    pos_payment_method: "cash",
    delivery_id: null,
    business: null,
    user: null,
    inserted_at: new Date().toISOString(),
    updated_at: new Date().toISOString(),
    ...overrides,
  } as SellerOrder;
}

describe("LAN order catch-up on connect", () => {
  const published: DomainEvent[] = [];

  beforeEach(async () => {
    published.length = 0;
    const mem = createMemoryDriver();
    setSqliteDriver(mem);
    const kvStore = new Map<string, string>();
    setKVDriver({
      getItem: async (k: string) => kvStore.get(k) ?? null,
      setItem: async (k: string, v: string) => {
        kvStore.set(k, v);
      },
      removeItem: async (k: string) => {
        kvStore.delete(k);
      },
    } as never);
    try {
      await closeSyncDatabase();
    } catch {}
    await openSyncDatabase();
    (localNodeStore as unknown as { _reset?: () => void })._reset?.();
    await localNodeService.shutdown().catch(() => undefined);
    setAppInstanceId(DEVICE_ID);
    setActiveBusiness({ id: BID } as never);
    setAuthProvider(() => "token-catchup");
    usePendingOrdersStore.setState({ orders: [], hydrated: true });

    const transport: TransportAdapter = {
      createServer: () => ({
        start: async () => undefined,
        stop: async () => undefined,
        isListening: () => true,
        broadcast: () => undefined,
      }),
      createClient: (opts) => ({
        connect: async () => {
          opts.onConnected();
        },
        disconnect: () => undefined,
        isConnected: () => true,
        execute: async () => [],
        requestReferenceData: async () => ({ data: {} }),
        publishEvent: async (event: DomainEvent) => {
          published.push(event);
        },
      }),
    } as TransportAdapter;

    localNodeStore.getState().setIsLocalNodeEnabled(true);
    initLocalNodeService({
      getDeviceId: () => DEVICE_ID,
      getDeviceName: () => "Desk",
      getBusiness: () => ({ id: BID }),
      getAuth: () => ({ user: { id: "u1" }, accessToken: "tok" }),
      discovery: new MockDiscovery(),
      transport,
    });
  });

  afterEach(async () => {
    await localNodeService.shutdown().catch(() => undefined);
  });

  async function connectWithDiscoveredPeer() {
    localNodeStore.getState().addDiscoveredNode({
      deviceId: PEER_ID,
      name: "peer",
      host: "192.168.1.42",
      port: 44621,
      deviceName: "Peer",
      lastSeenAt: new Date().toISOString(),
    } as never);
    await localNodeService.initialize();
    await new Promise((resolve) => setTimeout(resolve, 200));
  }

  it("publishes orders created before the peer connected", async () => {
    const db = await openSyncDatabase();
    await insertOrder(db, {
      ...order(),
      hlc: "2026-01-01T10:00:00.000Z",
    } as never);

    await connectWithDiscoveredPeer();

    const event = published.find(
      (candidate) =>
        candidate.event_type === "order:sync" &&
        (candidate.payload as { order_number?: string }).order_number ===
          "07-001-009",
    );
    expect(event).toBeDefined();
    expect((event?.payload as { hlc?: string }).hlc).toBe(
      "2026-01-01T10:00:00.000Z",
    );
  });

  it("publishes queued offline creations that have no orders row yet", async () => {
    usePendingOrdersStore.setState({
      orders: [order({ id: "pending-order", order_number: "07-001-010" })],
      hydrated: true,
    });

    await connectWithDiscoveredPeer();

    expect(
      published.some(
        (candidate) =>
          candidate.event_type === "order:sync" &&
          (candidate.payload as { order_number?: string }).order_number ===
            "07-001-010",
      ),
    ).toBe(true);
  });
});
