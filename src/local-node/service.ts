/**
 * Local Node Service — mesh, no elected, every isLocalNodeEnabled device is both server and client.
 */

import { localNodeStore, type DiscoveredNode } from "./store";
import { syncLogger } from "../utils/sync-logger";
import { recordAttempt } from "../utils/attempt-stats";
import { restTransport } from "../sync/transport-rest";
import { commandQueueService } from "../sync/command-queue.service";
import { applyPendingOrderEvent, applyOrderStateChangeEvent, notifyPendingOrdersChanged } from "../sync/pending-orders.service";
import { applyMenuCommandLocal } from "../reference/menu-apply";
import { REFERENCE_CHANGED_EVENT_TYPE } from "../reference/events";
import { applyReferenceChangeEvent } from "../reference/events";
import { openSyncDatabase } from "../db/connection";
import { insertOrder } from "../db/operations";
import { createLocalOrder, transitionLocalOrder } from "../domain/orders/service";
import type { SellerOrder } from "../types/api/seller.api";
import { getConnectivityState, setConnectivityState } from "../adapters/connectivity";
import { deriveLanSecret as deriveSecretCore } from "./security";
import type { Command, DomainEvent } from "../sync/types";
import type { LocalNodeInfo } from "./types";
import type { LocalNodeDeps, LocalNodeServer, LocalNodeClient } from "./adapters";
import type { ReferenceDataKey } from "../reference/types";

const KEEP_AWAKE_TAG = "TeincLocalNode";
const RECONNECT_BASE = 1_000;
const RECONNECT_MAX = 30_000;
const CONNECT_GUARD_MS = 15_000;
const LIFECYCLE_TIMEOUT_MS = 10_000;
const CLOUD_TIMEOUT_DEFAULT = 8_000;

function withTimeout<T>(p: Promise<T>, ms: number): Promise<T> {
  return new Promise((resolve, reject) => {
    const t = setTimeout(() => reject(new Error(`Timed out after ${ms}ms`)), ms);
    p.then((v) => { clearTimeout(t); resolve(v); }, (e) => { clearTimeout(t); reject(e); });
  });
}

class LocalNodeServiceCore {
  private server: LocalNodeServer | null = null;
  private peers = new Map<string, LocalNodeClient>();
  private peerInfos = new Map<string, LocalNodeInfo>();
  private mode: "mesh" | "idle" = "idle";
  private businessId: string | null = null;
  private secret: string | null = null;
  private subscribed = false;
  private cachedDeviceId: string | null = null;
  private lifecyclePromise: Promise<void> | null = null;
  private starting = false;
  private deps: LocalNodeDeps | null = null;
  /** mDNS publish state — a failed publish must never abort discovery. */
  private published = false;
  /** Whether discovery scanning was successfully started. */
  private discovering = false;

  init(deps: LocalNodeDeps): void { this.deps = deps; }
  private getDeps(): LocalNodeDeps {
    if (!this.deps) throw new Error("LocalNodeService not initialised: call initLocalNodeService(deps) first");
    return this.deps;
  }
  private async getDeviceId(): Promise<string> {
    const d = this.getDeps().getDeviceId();
    return d instanceof Promise ? await d : d;
  }
  private async runLifecycle<T>(fn: () => Promise<T>, tag: string): Promise<T> {
    if (this.lifecyclePromise) await this.lifecyclePromise;
    const p = (async () => { try { return await fn(); } finally { this.lifecyclePromise = null; } })();
    this.lifecyclePromise = p.then(() => undefined, () => undefined);
    await p.catch((error) => { syncLogger.error("LocalNodeService", `${tag} failed`, { error: String(error) }); throw error; });
    return p;
  }
  private async runInitialize(): Promise<void> {
    const deps = this.getDeps();
    if (this.starting) return;
    const auth = deps.getAuth();
    const business = deps.getBusiness();
    if (!auth.user || !auth.accessToken || !business) {
      if (this.mode !== "idle") await this.runShutdown();
      syncLogger.info("LocalNodeService", "Local Node idle (no active business)", {});
      this.setupStoreSubscriptions();
      return;
    }
    const store = localNodeStore.getState();
    if (!store.isLocalNodeEnabled) {
      if (this.mode !== "idle") await this.runShutdown();
      syncLogger.info("LocalNodeService", "Local Node disabled", {});
      this.setupStoreSubscriptions();
      return;
    }
    const thisDeviceId = await this.getDeviceId();
    this.cachedDeviceId = thisDeviceId;
    // Mesh: every enabled device is server + client, no elected check
    if (this.mode === "mesh" && this.server?.isListening() && this.businessId === business.id) {
      // Already serving: re-verify the auxiliary legs instead of returning
      // blind. A previous publish failure (or a start that never reached
      // discovery) must not leave this device mute/deaf forever.
      this.ensurePublished();
      this.ensureDiscovery();
      this.setupStoreSubscriptions();
      return;
    }
    if (this.mode !== "idle") await this.runShutdown();
    this.businessId = business.id;
    // Sole derivation point: lib-owned, business-only (security.ts).
    this.secret = await deriveSecretCore({ id: business.id });
    this.mode = "mesh";
    await this.startAsNode(store.localNodePort);
    this.ensureDiscovery();
    this.startPeerSweep();
    // Connect to already discovered peers
    for (const n of localNodeStore.getState().discoveredNodes) {
      if (n.deviceId !== thisDeviceId) this.connectToPeer(n);
    }
    this.setupStoreSubscriptions();
  }
  async initialize(): Promise<void> { return this.runLifecycle(() => this.runInitialize(), "initialize"); }
  async shutdown(): Promise<void> { return this.runLifecycle(() => this.runShutdown(), "shutdown"); }
  reconnectNow(): void {
    // Mesh: if server not listening, re-initialize; else ensure publish +
    // discovery and peer connections
    if (this.mode === "mesh") {
      if (!this.server?.isListening()) {
        this.initialize().catch((e) => syncLogger.error("LocalNodeService", "reconnectNow re-init failed", { error: String(e) }));
      } else {
        this.ensurePublished();
        this.ensureDiscovery();
        for (const n of localNodeStore.getState().discoveredNodes) {
          if (n.deviceId !== this.cachedDeviceId) this.connectToPeer(n);
        }
      }
      return;
    }
    if (this.mode === "idle") this.initialize().catch(() => undefined);
  }
  private async runShutdown(): Promise<void> {
    this.teardownStoreSubscriptions();
    this.stopPeerSweep();
    this.dialInFlight.clear();
    this.mismatchBackoff.clear();
    for (const t of this.dialTimers.values()) try { clearTimeout(t); } catch {}
    this.dialTimers.clear();
    for (const c of this.peers.values()) try { c.disconnect(); } catch {}
    this.peers.clear();
    this.peerInfos.clear();
    if (this.server) {
      await withTimeout(this.server.stop(), LIFECYCLE_TIMEOUT_MS).catch((e) => syncLogger.warn("LocalNodeService", "Server stop timed out", { error: String(e) }));
      this.server = null;
    }
    this.starting = false;
    try { this.getDeps().discovery.stop(); } catch {}
    this.published = false;
    this.discovering = false;
    this.mode = "idle";
    this.businessId = null;
    this.secret = null;
    syncLogger.info("LocalNodeService", "Mesh shutdown", {});
    try { localNodeStore.getState().clearConnectedClients(); } catch {}
    try { localNodeStore.getState().clearDiscoveredNodes(); } catch {}
    try { await this.getDeps().keepAlive?.deactivate(KEEP_AWAKE_TAG); } catch {}
  }
  isLocalNode(): boolean {
    // Mesh: isLocalNode means mesh enabled and server listening
    const store = localNodeStore.getState();
    return store.isLocalNodeEnabled && !!this.server?.isListening();
  }
  isConnectedToNode(): boolean { return this.peers.size > 0 && [...this.peers.values()].some((c) => c.isConnected()); }
  /** Mesh legibility for Diagnostics screens: publish/scan state per leg. */
  getMeshStatus(): { mode: string; listening: boolean; published: boolean; discovering: boolean; peers: number } {
    let listening = false;
    try {
      listening = !!this.server?.isListening();
    } catch {}
    return { mode: this.mode, listening, published: this.published, discovering: this.discovering, peers: this.peers.size };
  }
  getClient(): LocalNodeClient | null {
    // For compat: return first connected peer
    for (const c of this.peers.values()) if (c.isConnected()) return c;
    return null;
  }
  getElectedNode(): LocalNodeInfo | null {
    // No elected in mesh, return first peer or null
    const first = this.peerInfos.values().next().value as LocalNodeInfo | undefined;
    return first ?? null;
  }
  broadcastToClients(event: DomainEvent): void {
    // Mesh broadcast to all peers
    for (const c of this.peers.values()) {
      try { c.publishEvent?.(event); } catch {}
    }
    // Also via server broadcast to connected clients
    try { this.server?.broadcast(event); } catch {}
  }
  private storeUnsub: (() => void) | null = null;
  private setupStoreSubscriptions(): void {
    if (this.subscribed) return;
    this.subscribed = true;
    this.storeUnsub = localNodeStore.subscribe((state, prev) => {
      if (this.mode !== "mesh") return;
      // New discovered nodes -> connect. Dead entries (failed/in-flight, never
      // connected) must NOT block redial: connectToPeer self-heals via
      // stale-release, so only skip peers that are actually connected.
      if (state.discoveredNodes !== prev.discoveredNodes) {
        for (const n of state.discoveredNodes) {
          if (n.deviceId === this.cachedDeviceId) continue;
          if (this.peers.get(n.deviceId)?.isConnected()) continue;
          this.connectToPeer(n);
        }
        // Removed nodes -> drop the peer entry, but NEVER tear down a live
        // socket on discovery loss. mDNS scans flap (a peer missing from one
        // browse window is usually still there); killing the authenticated
        // connection on every miss causes an infinite connect/kill loop and
        // the UI never shows Connected. Socket close/error drives teardown
        // (see onDisconnected); discovery only governs (re)connect attempts.
        for (const pid of [...this.peers.keys()]) {
          if (!state.discoveredNodes.find((n) => n.deviceId === pid)) {
            const c = this.peers.get(pid);
            if (c?.isConnected()) continue;
            try { c?.disconnect(); } catch {}
            this.peers.delete(pid);
            this.peerInfos.delete(pid);
          }
        }
      }
    });
  }
  private teardownStoreSubscriptions(): void {
    try { this.storeUnsub?.(); } catch {}
    this.storeUnsub = null;
    this.subscribed = false;
  }
  private async startAsNode(port: number): Promise<void> {
    if (!this.businessId || !this.secret) throw new Error("LocalNodeService: business context missing");
    const deps = this.getDeps();
    this.server = deps.transport.createServer({
      port,
      businessId: this.businessId,
      secret: this.secret,
      onCommand: async (command) => {
        const event = await this.handleNodeCommand(command);
        return event ? [event] : [];
      },
      onRelayEvent: (event) => {
        applyReferenceChangeEvent(event, "lan").catch((e) => syncLogger.error("LocalNodeService", "Failed to apply relayed reference", { error: String(e), event_type: event.event_type }));
      },
      onClientConnected: (info) => {
        localNodeStore.getState().addConnectedClient({ deviceId: info.deviceId, deviceName: info.deviceName, host: info.host, connectedAt: new Date().toISOString() });
        syncLogger.info("LocalNodeService", "Client connected", { deviceId: info.deviceId, connected_clients: localNodeStore.getState().connectedClients.length });
      },
      onClientDisconnected: (deviceId) => {
        localNodeStore.getState().removeConnectedClient(deviceId);
        syncLogger.info("LocalNodeService", "Client disconnected", { deviceId, connected_clients: localNodeStore.getState().connectedClients.length });
      },
    });
    await this.server.start();
    try { await deps.keepAlive?.activate(KEEP_AWAKE_TAG); } catch {}
    this.ensurePublished();
  }
  /**
   * (Re)publish this node's mDNS advertisement. Isolated from server bring-up
   * and discovery: a publish throw must never abort scanning, sweeping, or
   * peer dials. Safe to call repeatedly (drivers dedupe internally).
   */
  private ensurePublished(): void {
    if (this.published) return;
    try {
      const deps = this.getDeps();
      const deviceId = this.cachedDeviceId ?? ((): string => {
        try {
          const v = deps.getDeviceId();
          return typeof v === "string" ? v : "";
        } catch {
          return "";
        }
      })();
      if (!deviceId) return;
      const port = localNodeStore.getState().localNodePort;
      deps.discovery.startPublishing({
        deviceId,
        deviceName: deps.getDeviceName?.(),
        port,
        onNodeFound: (node) => localNodeStore.getState().addDiscoveredNode(node),
        onNodeLost: (id) => localNodeStore.getState().removeDiscoveredNode(id),
      });
      this.published = true;
      syncLogger.info("LocalNodeService", "Published mDNS advertisement", { port });
    } catch (e) {
      this.published = false;
      syncLogger.warn("LocalNodeService", "Publish failed — will retry on next initialize/reconnect (scan continues)", {
        error: String(e),
      });
    }
  }
  private startDiscovery(): void {
    const deps = this.getDeps();
    deps.discovery.setOptions({
      deviceId: (() => { try { const v = deps.getDeviceId(); return typeof v === "string" ? v : ""; } catch { return ""; } })(),
      deviceName: deps.getDeviceName?.(),
      onNodeFound: (node) => {
        if (node.deviceId === this.cachedDeviceId) return;
        localNodeStore.getState().addDiscoveredNode(node);
      },
      onNodeLost: (deviceId) => localNodeStore.getState().removeDiscoveredNode(deviceId),
    });
    deps.discovery.startScanning();
  }
  /** Start scanning if not already running (idempotent drivers ignore repeats). */
  private ensureDiscovery(): void {
    if (this.discovering) {
      try {
        this.getDeps().discovery.startScanning();
      } catch {}
      return;
    }
    try {
      this.startDiscovery();
      this.discovering = true;
    } catch (e) {
      this.discovering = false;
      syncLogger.warn("LocalNodeService", "Discovery start failed — will retry on next initialize/reconnect", {
        error: String(e),
      });
    }
  }
  private dialInFlight = new Set<string>();
  private dialTimers = new Map<string, ReturnType<typeof setTimeout>>();
  private sweepTimer: ReturnType<typeof setInterval> | null = null;
  /** deviceId -> timestamp of last business_mismatch rejection. Foreign-business
   * peers (test rigs, neighboring shops) would otherwise be redialed on every
   * discovery event; back off quietly and re-probe after the window. */
  private mismatchBackoff = new Map<string, number>();
  private static readonly MISMATCH_BACKOFF_MS = 60_000;
  private startPeerSweep(): void {
    // mDNS is lossy: browse windows miss peers and re-announces are not
    // guaranteed, so discovery events alone cannot drive (re)dial. Sweep
    // every 15s; connectToPeer self-guards (connected or in-flight → skip),
    // so the steady state cost is one connected-check per known peer.
    this.stopPeerSweep();
    this.sweepTimer = setInterval(() => {
      try {
        if (this.mode !== "mesh") return;
        const nodes = localNodeStore.getState().discoveredNodes;
        recordAttempt("sweep_tick", `known=${nodes.length}`);
        for (const n of nodes) {
          if (n.deviceId === this.cachedDeviceId) continue;
          if (this.peers.get(n.deviceId)?.isConnected()) continue;
          this.connectToPeer(n);
        }
      } catch {}
    }, 15_000);
    try { (this.sweepTimer as unknown as { unref?: () => void }).unref?.(); } catch {}
  }
  private stopPeerSweep(): void {
    if (this.sweepTimer) { try { clearInterval(this.sweepTimer); } catch {} this.sweepTimer = null; }
  }
  private connectToPeer(node: DiscoveredNode): void {
    if (this.mode !== "mesh") return;
    // Foreign-business backoff (see mismatchBackoff).
    const mismatchedAt = this.mismatchBackoff.get(node.deviceId);
    if (mismatchedAt && Date.now() - mismatchedAt < LocalNodeServiceCore.MISMATCH_BACKOFF_MS) return;
    // One dial per peer at a time: discovery fires in bursts (initial browse,
    // re-announces) and parallel dials destroy each other's sockets mid-
    // handshake — a livelock where nothing ever completes. A second attempt
    // while one is in flight is always redundant.
    if (this.dialInFlight.has(node.deviceId)) return;
    if (this.peers.has(node.deviceId)) {
      const c = this.peers.get(node.deviceId);
      if (c?.isConnected()) return;
      // Stale attempt (failed/in-flight): release it before replacing so
      // listeners/sockets don't accumulate across scan cycles. The Rust side
      // only tears down the named connection (connId check), so a newer
      // attempt can never be killed by this.
      try { c?.disconnect(); } catch {}
      this.peers.delete(node.deviceId);
      this.peerInfos.delete(node.deviceId);
    }
    if (!this.businessId || !this.secret) { syncLogger.warn("LocalNodeService", "Cannot connect: no business context", {}); return; }
    const deps = this.getDeps();
    const client = deps.transport.createClient({
      node: { deviceId: node.deviceId, host: node.host, port: node.port },
      businessId: this.businessId,
      secret: this.secret,
      onEvent: (event) => {
        syncLogger.event(event, "received", { origin: "lan" });
        if ((event.event_type as string) === "order:sync") {
          void (async () => {
            try {
              const p = event.payload as Record<string, unknown>;
              if (p && typeof p.order_number === "string" && (p as { id?: unknown }).id) {
                const db = await openSyncDatabase();
                await insertOrder(db, p as unknown as SellerOrder & { hlc?: string });
              } else {
                const action = (p as { action?: string }).action;
                const orderId = (p as { orderId?: string }).orderId;
                const bid = deps.getBusiness()?.id;
                if (action && orderId && bid) { try { await transitionLocalOrder(bid, String(orderId), action); } catch {} }
              }
            } catch (e) { syncLogger.debug("LocalNodeService", "LAN order:sync apply failed", { err: String(e) }); }
            // The row is in SQLite now — invalidate so lists/detail refetch.
            // (order:sync bypasses the engine pipeline, so no subscriber does
            // this for us.)
            notifyPendingOrdersChanged();
          })();
        }
        applyPendingOrderEvent(event, "lan").catch((e) => syncLogger.error("LocalNodeService", "Failed to apply LAN event", { error: String(e), event_type: event.event_type }));
        applyReferenceChangeEvent(event, "lan").catch((e) => syncLogger.error("LocalNodeService", "Failed to apply LAN reference", { error: String(e), event_type: event.event_type }));
        applyOrderStateChangeEvent(event, "lan").catch((e) => syncLogger.error("LocalNodeService", "Failed to apply LAN order state", { error: String(e), event_type: event.event_type }));
      },
      onConnected: () => {
        this.settleDial(node.deviceId);
        this.mismatchBackoff.delete(node.deviceId);
        syncLogger.info("LocalNodeService", "Connected to peer", { deviceId: node.deviceId });
        this.peerInfos.set(node.deviceId, { deviceId: node.deviceId, host: node.host, port: node.port });
        localNodeStore.getState().addConnectedClient({ deviceId: node.deviceId, deviceName: node.deviceName, host: node.host, connectedAt: new Date().toISOString() });
      },
      onDisconnected: () => {
        this.settleDial(node.deviceId);
        syncLogger.warn("LocalNodeService", "Disconnected from peer", { deviceId: node.deviceId });
        this.peers.delete(node.deviceId);
        this.peerInfos.delete(node.deviceId);
        localNodeStore.getState().removeConnectedClient(node.deviceId);
      },
      onError: (error) => {
        if (String(error).includes("business_mismatch")) {
          this.mismatchBackoff.set(node.deviceId, Date.now());
        }
        syncLogger.debug("LocalNodeService", "Peer connect error", { error: String(error), deviceId: node.deviceId });
      },
    });
    this.peers.set(node.deviceId, client);
    this.peerInfos.set(node.deviceId, { deviceId: node.deviceId, host: node.host, port: node.port });
    this.dialInFlight.add(node.deviceId);
    recordAttempt("lan_dial", node.deviceId.slice(0, 8));
    // Wedged-handshake reaper: if neither connected nor failed within the TTL
    // (no callback ever fires), release the socket so the next discovery
    // redials instead of piling up parallel attempts.
    try { clearTimeout(this.dialTimers.get(node.deviceId)); } catch {}
    const ttl = setTimeout(() => {
      this.dialTimers.delete(node.deviceId);
      if (!this.dialInFlight.has(node.deviceId)) return;
      this.dialInFlight.delete(node.deviceId);
      const c = this.peers.get(node.deviceId);
      if (c && !c.isConnected()) {
        recordAttempt("ttl_reap", node.deviceId.slice(0, 8));
        syncLogger.debug("LocalNodeService", "Dial TTL expired, reaping wedged attempt", { deviceId: node.deviceId });
        try { c.disconnect(); } catch {}
        this.peers.delete(node.deviceId);
        this.peerInfos.delete(node.deviceId);
      }
    }, 10_000);
    // Never hold the process (or test runner) open for a wedged peer.
    try { (ttl as unknown as { unref?: () => void }).unref?.(); } catch {}
    this.dialTimers.set(node.deviceId, ttl);
    client.connect().catch((e) => {
      this.settleDial(node.deviceId);
      if (String(e?.message ?? e).includes("business_mismatch")) {
        this.mismatchBackoff.set(node.deviceId, Date.now());
      }
      syncLogger.debug("LocalNodeService", "Peer connect failed, will retry on next discovery", { error: String(e), deviceId: node.deviceId });
      // Keep peer entry so next discovery will retry; or remove to allow fresh connect
      // For mesh, keep and let discovery re-add
    });
  }
  private settleDial(deviceId: string): void {
    this.dialInFlight.delete(deviceId);
    const t = this.dialTimers.get(deviceId);
    if (t) { try { clearTimeout(t); } catch {} this.dialTimers.delete(deviceId); }
  }
  async handleNodeCommand(command: Command): Promise<DomainEvent | null> {
    syncLogger.command(command, "executing", { via: "local_node" });
    // Menu writes apply to the durable reference cache (NOT the cloud) so a
    // dark LAN converges; peers pull via reference_fetch after the
    // reference_data.changed fan-out below. Cloud replay re-applies through
    // the cloud path where the backend owns versions.
    if (command.command_type.startsWith("menu:")) {
      const { keys } = await applyMenuCommandLocal(command.business_id, command);
      if (!keys.length) return null;
      const evt: DomainEvent = {
        event_id: `lan-${command.command_id}`,
        event_type: REFERENCE_CHANGED_EVENT_TYPE as DomainEvent["event_type"],
        event_version: "1",
        entity_id: command.business_id,
        user_id: command.user_id,
        device_id: command.device_id,
        payload: { business_id: command.business_id, keys } as unknown as Record<string, unknown>,
        timestamp: new Date().toISOString(),
      };
      this.broadcastToClients(evt);
      return evt;
    }
    if (command.command_type.startsWith("order:") || command.command_type.startsWith("payment:")) {
      try {
        const bid = command.business_id;
        const payload = command.payload as Record<string, unknown>;
        if (command.command_type === "order:create") {
          const order = await createLocalOrder(bid, {
            ...(payload as Record<string, unknown>),
            command_id: command.command_id,
            id: command.entity_id ?? command.command_id,
            order_number: (payload as { order_number?: string }).order_number ?? (payload as { local_order_number?: string }).local_order_number,
          } as unknown as Parameters<typeof createLocalOrder>[1]);
          const evt: DomainEvent = {
            event_id: `lan-${command.command_id}`,
            event_type: "order:sync" as DomainEvent["event_type"],
            event_version: "1",
            entity_id: order.id,
            user_id: command.user_id,
            device_id: command.device_id,
            payload: order as unknown as Record<string, unknown>,
            timestamp: new Date().toISOString(),
          };
          this.broadcastToClients(evt);
          return evt;
        }
        const map: Record<string, string> = { "order:accept": "accept", "order:reject": "reject", "order:start_preparing": "start_preparing", "order:mark_ready": "mark_ready", "order:complete_pickup": "complete_pickup", "order:cancel": "cancel", "payment:confirm_cash": "confirm_cash" };
        const action = map[command.command_type] ?? command.command_type.replace(/^order:/, "");
        const orderId = command.entity_id ?? (payload as { orderId?: string }).orderId ?? (payload as { order_id?: string }).order_id;
        if (orderId) {
          const updated = await transitionLocalOrder(bid, String(orderId), action);
          const evt: DomainEvent = {
            event_id: `lan-${command.command_id}`,
            event_type: "order:sync" as DomainEvent["event_type"],
            event_version: "1",
            entity_id: String(orderId),
            user_id: command.user_id,
            device_id: command.device_id,
            // Full updated order (not just action+id) so repository callers
            // awaiting engine results get an order-shaped payload on every
            // path (cloud / LAN / queue-optimistic). Peers still apply via
            // transitionLocalOrder for their own read models.
            payload: { action, orderId: String(orderId), order: updated as unknown as Record<string, unknown>, ...(updated as unknown as Record<string, unknown>) },
            timestamp: new Date().toISOString(),
          };
          this.broadcastToClients(evt);
          return evt;
        }
      } catch (e) {
        const code = (e as { code?: string })?.code;
        if (code === "BUSINESS_CLOSED" || code === "HOURS_NOT_SYNCED" || code === "FORBIDDEN") {
          syncLogger.debug("LocalNodeService", "LAN handle rejected by lib guard, no fallback", { err: String(e), code });
          throw e;
        }
        syncLogger.debug("LocalNodeService", "New-DB LAN handle failed, fallback to legacy queue", { err: String(e) });
      }
    }
    const cloudReachable = (() => { try { const s = getConnectivityState() as unknown as { isCloudReachable?: string }; return s?.isCloudReachable === "reachable" || s?.isCloudReachable === "unknown"; } catch { return true; } })();
    let event: DomainEvent | null = null;
    const timeoutMs = this.getDeps().cloudCommandTimeoutMs ?? CLOUD_TIMEOUT_DEFAULT;
    if (cloudReachable) {
      try {
        const events = await withTimeout(restTransport.execute(command), timeoutMs);
        event = events[0] ?? null;
      } catch (error) {
        syncLogger.warn("LocalNodeService", "Cloud forward failed, queueing", { error: String(error) });
        try { setConnectivityState({ isCloudReachable: "unreachable" } as unknown as Record<string, unknown>); } catch {}
        event = await commandQueueService.enqueue(command);
      }
    } else {
      event = await commandQueueService.enqueue(command);
    }
    if (event) this.broadcastToClients(event);
    return event;
  }
  async requestReferenceData(businessId: string, keys: ReferenceDataKey[]): Promise<Partial<Record<ReferenceDataKey, import("../reference/types").ReferenceDataRecord | null>> | null> {
    // Mesh: ask any connected peer, or all peers and merge
    for (const c of this.peers.values()) {
      if (!c.isConnected() || !c.requestReferenceData) continue;
      try {
        const res = await c.requestReferenceData(businessId, keys);
        if (res?.data && Object.keys(res.data).length) return res.data;
      } catch {}
    }
    return null;
  }
  getState() { return { isLocalNode: this.isLocalNode(), isConnectedToNode: this.isConnectedToNode(), electedNode: this.getElectedNode(), client: this.getClient() }; }
}

export const localNodeService = new LocalNodeServiceCore();
export function initLocalNodeService(deps: LocalNodeDeps): LocalNodeServiceCore { localNodeService.init(deps); return localNodeService; }
export type LocalNodeService = LocalNodeServiceCore;
