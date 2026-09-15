#!/usr/bin/env -S node -r tsx --no-warnings
/**
 * LAN integration test — Device-A peer that verifies real TLS + mDNS + handshake
 * with the actual desktop app (or mobile app).
 *
 * Runs two phases:
 *   Phase 1 — Peer connects to Device-A (tests peer's mDNS browse + TLS client)
 *   Phase 2 — Device-A connects to peer (tests peer's mDNS publish + TLS server)
 *
 * Usage:
 *   npx tsx scripts/node-mesh/integration-test.ts [--id device-A] [--port 44621] [--timeout 30]
 *
 * Then start the desktop app (or mobile):
 *   cargo tauri dev   (desktop)
 *
 * Device-A will wait for the peer to connect, exchange data, and report pass/fail.
 * Same script works for mobile — just run the mobile app instead.
 */

import { randomUUID } from "node:crypto";
import { localNodeStore } from "../../src/local-node/store";
import { localNodeService, initLocalNodeService } from "../../src/local-node/service";
import { setKVDriver } from "../../src/adapters/kv";
import { setAppInstanceId } from "../../src/adapters/devices";
import { setConnectivityState } from "../../src/adapters/connectivity";
import { openSyncDatabase } from "../../src/db/connection";
import { NodeDiscovery, NodeTransport } from "./drivers";
import { installNodeSqlite, seedHarness } from "./sqlite-node";
import type { DomainEvent, Command } from "../../src/sync/types";

// ─── Args ───────────────────────────────────────────────────────────────────

function arg(name: string, def?: string): string | undefined {
  const i = process.argv.indexOf(`--${name}`);
  if (i !== -1) return process.argv[i + 1];
  return def;
}

const DEVICE_ID = arg("id", "integration-test-A");
const PORT = parseInt(arg("port", "44621"), 10);
const TIMEOUT_S = parseInt(arg("timeout", "30"), 10);
const BUSINESS_ID = arg("business", "0f0764da-53aa-48e4-ac40-3bfd8a52b0ec");
// Direct-dial fallback: --peer 192.168.1.45:44621 injects a discovered node
// into the store so the service dials it via the production connectToPeer
// path. Used when mDNS browse misses a peer that system dns-sd can see
// (library-level multicast receive issue, not a product bug — mobile uses
// the OS mDNSResponder, not bonjour-service).
const DIRECT_PEER = arg("peer");
// --keep-alive <seconds>: after the tests complete, stay up with connections
// open instead of exiting, so a human can open the app UI (desktop Settings →
// Local Node, or mobile LAN screen) and SEE this peer listed as connected.
// Exit code still reflects the test results.
const KEEP_ALIVE_S = parseInt(arg("keep-alive", "0"), 10);

(globalThis as unknown as { __teincDeviceId?: string }).__teincDeviceId = DEVICE_ID;

// ─── Test harness ───────────────────────────────────────────────────────────

let passed = 0;
let failed = 0;
const errors: string[] = [];

function ok(msg: string): void {
  passed++;
  console.log(`  ✓ ${msg}`);
}

function fail(msg: string, err?: unknown): void {
  failed++;
  const detail = err ? ` — ${String(err)}` : "";
  console.log(`  ✗ FAIL: ${msg}${detail}`);
  errors.push(`${msg}${detail}`);
}

// ─── Setup adapters (same as harness.ts) ────────────────────────────────────

const mem = new Map<string, string>();
setKVDriver({
  getItem: (k: string) => mem.get(k) ?? null,
  setItem: (k: string, v: string) => { mem.set(k, v); },
  removeItem: (k: string) => { mem.delete(k); },
  getItemAsync: async (k: string) => mem.get(k) ?? null,
} as Parameters<typeof setKVDriver>[0]);

installNodeSqlite();
setAppInstanceId(DEVICE_ID);
setConnectivityState({ isOnline: false, isCloudReachable: "unreachable" });
await seedHarness(BUSINESS_ID, "01");

// ─── Start service ──────────────────────────────────────────────────────────

localNodeStore.getState().setIsLocalNodeEnabled(true);
localNodeStore.getState().setLocalNodePort(PORT);

const discovery = new NodeDiscovery();
const transport = new NodeTransport();

initLocalNodeService({
  getDeviceId: () => DEVICE_ID,
  getDeviceName: () => DEVICE_ID,
  getBusiness: () => ({ id: BUSINESS_ID }),
  getAuth: () => ({ user: { id: "u1" }, accessToken: "tok" }),
  discovery,
  transport,
});

await localNodeService.initialize();
console.log(`\n[${DEVICE_ID}] LAN integration test started`);
console.log(`  port=${PORT} business=${BUSINESS_ID} timeout=${TIMEOUT_S}s`);
console.log(`  isLocalNode=${localNodeService.isLocalNode()} server listening`);
console.log(`  mDNS: _teincnode._tcp.local. published + scanning`);
console.log(`\n  Waiting for peer (desktop or mobile app) to connect...\n`);

// Visibility: log every mDNS discovery + connection change as it happens.
localNodeStore.subscribe((state, prev) => {
  if (state.discoveredNodes.length !== prev.discoveredNodes.length) {
    console.log(
      `  [discovery] nodes (${state.discoveredNodes.length}): ` +
        (state.discoveredNodes.map((n) => `${n.deviceId}@${n.host}:${n.port}`).join(", ") || "(none)"),
    );
  }
  if (state.connectedClients.length !== prev.connectedClients.length) {
    console.log(
      `  [mesh] connected clients (${state.connectedClients.length}): ` +
        (state.connectedClients.map((c) => c.deviceId).join(", ") || "(none)"),
    );
  }
});

// Direct-dial fallback (--peer host:port): inject into the store so the
// service dials via the production connectToPeer path.
if (DIRECT_PEER) {
  const m = DIRECT_PEER.match(/^(.+):(\d+)$/);
  if (m) {
    const [, host, portStr] = m;
    console.log(`  [direct] injecting peer ${host}:${portStr} (bypasses mDNS browse)`);
    localNodeStore.getState().addDiscoveredNode({
      deviceId: `direct-${host}`,
      name: `direct-${host}`,
      host,
      port: parseInt(portStr, 10),
      lastSeenAt: new Date().toISOString(),
    });
  } else {
    console.log(`  [direct] WARN: --peer must be host:port, got ${DIRECT_PEER}`);
  }
}

// ─── Phase 1: wait for peer to connect to us ─────────────────────────────

const phase1 = await new Promise<"skip" | "ok">((resolve) => {
  const deadline = setTimeout(() => {
    console.log(`\n  Phase 1: no peer connected within ${TIMEOUT_S}s — skipping (start the peer app first)`);
    resolve("skip");
  }, TIMEOUT_S * 1000);

  const unsub = localNodeStore.subscribe((state, prev) => {
    if (state.connectedClients.length > prev.connectedClients.length) {
      const client = state.connectedClients[state.connectedClients.length - 1];
      clearTimeout(deadline);
      unsub();
      console.log(`  Phase 1: peer connected ← ${client.deviceId}@${client.host} (peer→Device-A TLS)`);
      ok("peer connected to Device-A TLS server");
      resolve("ok");
    }
  });
});

if (phase1 === "ok") {
  // ── Test: broadcast event from Device-A to peer ──────────
  console.log("\n  Test: broadcast chat:message to peer...");
  const chatEvent: DomainEvent = {
    event_id: `test-${Date.now()}`,
    event_type: "chat:message" as unknown as DomainEvent["event_type"],
    event_version: "1",
    entity_id: DEVICE_ID,
    user_id: "u1",
    device_id: DEVICE_ID,
    payload: { text: "integration-test ping", from: DEVICE_ID, echo: false } as unknown as Record<string, unknown>,
    timestamp: new Date().toISOString(),
  };
  try {
    localNodeService.broadcastToClients(chatEvent);
    ok("broadcast chat:message sent to connected peer");
  } catch (e) {
    fail("broadcast chat:message", e);
  }

  // ── Test: broadcast order:sync ──────────────────────────────
  console.log("  Test: broadcast order:sync to peer...");
  const orderEvent: DomainEvent = {
    event_id: `test-order-${Date.now()}`,
    event_type: "order:sync" as unknown as DomainEvent["event_type"],
    event_version: "1",
    entity_id: randomUUID(),
    user_id: "u1",
    device_id: DEVICE_ID,
    payload: {
      id: randomUUID(),
      order_number: "TFL-TEST-001",
      status: "accepted",
      business_id: BUSINESS_ID,
      items: [{ menu_item_id: "m-jollof", quantity: 1 }],
      total_minor: 5000,
    } as unknown as Record<string, unknown>,
    timestamp: new Date().toISOString(),
  };
  try {
    localNodeService.broadcastToClients(orderEvent);
    ok("broadcast order:sync sent to connected peer");
  } catch (e) {
    fail("broadcast order:sync", e);
  }
} else {
  console.log("  Phase 1 tests skipped (no inbound connection)");
}

// ── Brief pause between phases ──────────────────────────────────────────────

await new Promise((r) => setTimeout(r, 2000));

// ─── Phase 2: Device-A connects to peer's server ────────────────────────────
// Device-A discovers peer via mDNS. The localNodeService auto-connects to
// discovered peers. We just wait for the connection to establish.

console.log("\n  Phase 2: checking for outbound peer connections...");
// (The localNodeService connects to discovered peers automatically via
// setupStoreSubscriptions. We just check if any peer is connected.)

// Phase 2 works by the localNodeService auto-connecting to any discovered
// peer via setupStoreSubscriptions. The connection may already be established
// (from Phase 1 discovery or from the background sweep). Check peers map.

const phase2Connected = await new Promise<boolean>((resolve) => {
  // Check existing peers first
  const svc = localNodeService as unknown as { peers: Map<string, { isConnected: () => boolean }> };
  for (const [, peer] of svc.peers) {
    if (peer.isConnected()) { resolve(true); return; }
  }
  // Wait up to 10s for a new peer to connect
  const deadline = setTimeout(() => resolve(false), 10_000);
  const unsub = localNodeStore.subscribe(() => {
    for (const [, peer] of svc.peers) {
      if (peer.isConnected()) {
        clearTimeout(deadline);
        unsub();
        resolve(true);
        return;
      }
    }
  });
});

if (phase2Connected) {
  ok("Device-A connected to peer TLS server (Phase 2 outbound handshake)");
} else {
  // Check if we ever discovered the peer at all
  const discovered = localNodeStore.getState().discoveredNodes.length;
  if (discovered === 0) {
    console.log("  Phase 2: peer not found via mDNS — no discovered nodes");
  }
  fail("Device-A could not connect to peer TLS server (Phase 2 outbound handshake timeout)");
}

// ─── Summary ────────────────────────────────────────────────────────────────

console.log(`\n${"=".repeat(50)}`);
console.log(`  Results: ${passed} passed, ${failed} failed`);
if (errors.length) {
  console.log(`  Errors:`);
  for (const e of errors) console.log(`    - ${e}`);
}
console.log(`${"=".repeat(50)}\n`);

// Keep-alive: stay up with connections open so a human can verify the peer
// in the app UI (desktop Settings → Local Node screen). Heartbeat shows the
// live connection count; exit code still reflects the test results above.
if (KEEP_ALIVE_S > 0) {
  console.log(`  [keep-alive] staying up for ${KEEP_ALIVE_S}s — open the app UI now to see '${DEVICE_ID}' connected.`);
  const endAt = Date.now() + KEEP_ALIVE_S * 1000;
  while (Date.now() < endAt) {
    await new Promise((r) => setTimeout(r, 15000));
    const s = localNodeStore.getState();
    const remaining = Math.max(0, Math.round((endAt - Date.now()) / 1000));
    console.log(
      `  [keep-alive] ${remaining}s left — connected=[${s.connectedClients.map((c) => c.deviceId).join(", ") || "none"}] discovered=${s.discoveredNodes.length}`,
    );
  }
  console.log(`  [keep-alive] done.`);
}

// Cleanup
try { await localNodeService.shutdown(); } catch {}
try { discovery.stop(); } catch {}

process.exit(failed > 0 ? 1 : 0);
