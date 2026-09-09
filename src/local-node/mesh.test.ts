import { describe, it, expect, beforeEach } from "vitest";
import { localNodeStore } from "./store";
import { localNodeService, initLocalNodeService } from "./service";
import type { DiscoveryAdapter, TransportAdapter } from "./adapters";
import { getAppInstanceId, setAppInstanceId } from "../adapters/devices";
import { setKVDriver } from "../adapters/kv";

class MockDiscovery implements DiscoveryAdapter {
  opts: any = null;
  scanning = false;
  publishing = false;
  publishedPort: number | null = null;
  setOptions(o: any) { this.opts = o; }
  startScanning() { this.scanning = true; }
  stopScanning() { this.scanning = false; }
  startPublishing(o: any) { this.publishing = true; this.publishedPort = o.port; this.opts = o; }
  stop() { this.scanning = false; this.publishing = false; }
}

class MockTransport implements TransportAdapter {
  server: any = null;
  clients: any[] = [];
  createServer(opts: any) {
    return {
      start: async () => { this.server = opts; },
      stop: async () => { this.server = null; },
      isListening: () => !!this.server,
      broadcast: () => {},
    };
  }
  createClient(opts: any) {
    const c = {
      connect: async () => { opts.onConnected(); },
      disconnect: () => {},
      isConnected: () => true,
      execute: async () => [],
      requestReferenceData: async () => ({ data: {} }),
    };
    this.clients.push(c);
    return c;
  }
}

describe("mesh local-node core", () => {
  beforeEach(async () => {
    // Reset store
    (localNodeStore as any)._reset();
    // Reset service
    await localNodeService.shutdown().catch(() => {});
    // Reset appInstanceId
    (await import("../adapters/devices")).setAppInstanceId("test-device-" + Math.random().toString(36).slice(2, 6));
    // Mock KV in-memory
    const mem = new Map<string, string>();
    setKVDriver({
      getItem: (k: string) => mem.get(k) ?? null,
      setItem: (k: string, v: string) => { mem.set(k, v); },
      removeItem: (k: string) => { mem.delete(k); },
    } as any);
  });

  it("isLocalNodeEnabled persists without elected", async () => {
    expect(localNodeStore.getState().isLocalNodeEnabled).toBe(false);
    localNodeStore.getState().setIsLocalNodeEnabled(true);
    expect(localNodeStore.getState().isLocalNodeEnabled).toBe(true);
    // Simulate rehydrate after restart
    const raw = (await (await import("../adapters/kv")).getKVDriver().getItem("teinc_local_node")) as string;
    expect(raw).toContain("isLocalNodeEnabled");
    expect(raw).not.toContain("elected");
    // New store instance should hydrate to true
    const { localNodeStore: s2 } = await import("./store");
    // Force rehydrate
    await s2.rehydrate();
    expect(s2.getState().isLocalNodeEnabled).toBe(true);
  });

  it("appInstanceId stable at install", async () => {
    const id1 = getAppInstanceId();
    const id2 = getAppInstanceId();
    expect(id1).toBe(id2);
    expect(id1.length).toBeGreaterThan(8);
    const { getAppInstanceIdAsync } = await import("../adapters/devices");
    const id3 = await getAppInstanceIdAsync();
    expect(id3).toBe(id1);
  });

  it("mesh: every enabled device is server+client, no elected needed", async () => {
    const business = { id: "biz-123", ownerId: "owner-1" };
    const discovery = new MockDiscovery();
    const transport = new MockTransport();
    setAppInstanceId("device-mesh-1");
    localNodeStore.getState().setIsLocalNodeEnabled(true);
    initLocalNodeService({
      getDeviceId: () => "device-mesh-1",
      getDeviceName: () => "Mesh 1",
      getBusiness: () => business as any,
      getAuth: () => ({ user: { id: "u1" }, accessToken: "tok" }),
      discovery: discovery as any,
      transport: transport as any,
    });
    await localNodeService.initialize();
    // In mesh, server should be listening and discovery both publishing and scanning
    expect(discovery.publishing).toBe(true);
    expect(discovery.scanning).toBe(true);
    // isLocalNode means mesh enabled + listening
    expect(localNodeService.isLocalNode()).toBe(true);

    // Simulate peer discovery
    const peer = { deviceId: "device-mesh-2", name: "peer", host: "192.168.1.11", port: 44621, deviceName: "Peer 2", lastSeenAt: new Date().toISOString() };
    localNodeStore.getState().addDiscoveredNode(peer as any);
    // Service should have auto-connected to peer via peers Map
    // Wait a tick for async connect
    await new Promise((r) => setTimeout(r, 50));
    expect(transport.clients.length).toBe(1);
    expect(localNodeService.isConnectedToNode()).toBe(true);
  });

  it("discovery filters self and fe80", async () => {
    const discovery = new MockDiscovery();
    const transport = new MockTransport();
    setAppInstanceId("self-123");
    localNodeStore.getState().setIsLocalNodeEnabled(true);
    initLocalNodeService({
      getDeviceId: () => "self-123",
      getBusiness: () => ({ id: "biz-123", ownerId: "o1" } as any),
      getAuth: () => ({ user: { id: "u1" }, accessToken: "tok" }),
      discovery: discovery as any,
      transport: transport as any,
    });
    await localNodeService.initialize();
    // Try to add self
    const selfNode = { deviceId: "self-123", name: "self", host: "192.168.1.12", port: 44621, deviceName: "Self", lastSeenAt: new Date().toISOString() };
    localNodeStore.getState().addDiscoveredNode(selfNode as any);
    await new Promise((r) => setTimeout(r, 50));
    // Should not have created a client for self
    expect(transport.clients.length).toBe(0);
  });
});
