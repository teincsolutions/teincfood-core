#!/usr/bin/env -S node -r tsx --no-warnings
/**
 * Two-process LAN proof — lib alone.
 * Each process gets its own --id (assumed deviceId already set), its own --port, own KV.
 * Real mDNS + TLS (production-faithful), real in-memory SQLite (node:sqlite) with
 * migrations + seeded DD lease + 24/7 hours, cloud forced unreachable.
 * Usage:
 *   node -r tsx scripts/node-mesh/harness.ts --id device-A --port 44631 [--dd 01]
 *   node -r tsx scripts/node-mesh/harness.ts --id device-B --port 44632 [--dd 02]
 * Chat: type a line, peer prints and echoes `echo: <line>` back.
 * Orders: /order [label] → order:create via handleNodeCommand → order:sync to peer
 *   /prepare <id> /ready <id> /pickup <id> → transitions → order:sync {action}
 *   /orders → local orders table. Peer prints order:sync receipt + local verify.
 */

import * as readline from "node:readline";
import * as fs from "node:fs";
import { randomUUID } from "node:crypto";
import { localNodeStore } from "../../src/local-node/store";
import { localNodeService, initLocalNodeService } from "../../src/local-node/service";
import { setKVDriver } from "../../src/adapters/kv";
import { setAppInstanceId, getAppInstanceId } from "../../src/adapters/devices";
import { setConnectivityState } from "../../src/adapters/connectivity";
import { syncLogger } from "../../src/utils/sync-logger";
import { openSyncDatabase } from "../../src/db/connection";
import { getOrderById } from "../../src/db/operations";
import { NodeDiscovery, NodeTransport } from "./drivers";
import { installNodeSqlite, seedHarness } from "./sqlite-node";
import { orderRepository } from "../../src/repositories/order.repository";
import type { DomainEvent, Command } from "../../src/sync/types";

// In-memory KV per process
const mem = new Map<string, string>();
const drv = {
  getItem: (k: string) => mem.get(k) ?? null,
  setItem: (k: string, v: string) => { mem.set(k, v); },
  removeItem: (k: string) => { mem.delete(k); },
  // async variants for rehydrate
  getItemAsync: async (k: string) => mem.get(k) ?? null,
};
setKVDriver(drv as unknown as Parameters<typeof setKVDriver>[0]);

// Real in-memory SQLite (node:sqlite) so order flows run production code:
// migrations, guards, insertOrder/transitionLocalOrder all execute.
installNodeSqlite();

function arg(name: string, def?: string): string | undefined {
  const i = process.argv.indexOf(`--${name}`);
  if (i !== -1) return process.argv[i + 1];
  if (def) return def;
  return undefined;
}

const deviceId = arg("id") ?? `dev-${Math.random().toString(36).slice(2, 6)}`;
const port = parseInt(arg("port") ?? "44621", 10);
const deviceName = arg("name") ?? deviceId;
const businessId = arg("business") ?? "0f0764da-53aa-48e4-ac40-3bfd8a52b0ec";
// Lib-central contract: business id only. Owner is never an input (core security.ts).

(globalThis as unknown as { __teincDeviceId?: string }).__teincDeviceId = deviceId;
setAppInstanceId(deviceId);

// Simulate offline terminal: cloud unreachable → engine/LAN paths stay local,
// DD lease + 24/7 hours seeded so lib guards pass without a backend.
setConnectivityState({ isOnline: false, isCloudReachable: "unreachable" });
const dd = arg("dd") ?? (deviceId.endsWith("A") ? "01" : "02");
await seedHarness(businessId, dd);

// Make store believe enabled before init
localNodeStore.getState().setIsLocalNodeEnabled(true);
localNodeStore.getState().setLocalNodePort(port);

const discovery = new NodeDiscovery();
const transport = new NodeTransport();

initLocalNodeService({
  getDeviceId: () => deviceId,
  getDeviceName: () => deviceName,
  getBusiness: () => ({ id: businessId }),
  getAuth: () => ({ user: { id: "u1" }, accessToken: "tok" }),
  discovery,
  transport,
});

// Capture peer events: the service's transport onEvent is where chat lands.
// We monkey-patch syncLogger.event (cast to any to avoid TS error with ...rest spread).
const echoSeen = new Set<string>();
const origEvent: (e: unknown, ...a: unknown[]) => void = (syncLogger as unknown as { event: (e: unknown, ...a: unknown[]) => void }).event.bind(syncLogger);
(syncLogger as unknown as { event: unknown }).event = ((ev: unknown, ...rest: unknown[]) => {
  origEvent(ev as DomainEvent, ...rest);
  const e = ev as DomainEvent;
  if ((e.event_type as string) === "order:sync") {
    const p = e.payload as { order_number?: string; status?: string; action?: string; orderId?: string; id?: string };
    const num = p.order_number ?? (p.id as string | undefined) ?? e.entity_id;
    const detail = p.action ? `action=${p.action} order=${p.orderId}` : `order=${num} status=${p.status}`;
    console.log(`\n[${deviceId}] <- order:sync from ${e.device_id}: ${detail}`);
    // Verify convergence: the apply path should have written our local DB.
    void (async () => {
      try {
        const db = await openSyncDatabase();
        const row = await getOrderById(db, businessId, e.entity_id);
        console.log(`[${deviceId}]    local verify: ${row ? `FOUND ${row.order_number} status=${row.status}` : "NOT YET (apply in flight)"}`);
      } catch (err) { console.log(`[${deviceId}]    local verify failed: ${String(err)}`); }
    })();
    setTimeout(() => { try { const r = (globalThis as unknown as { __rl?: readline.Interface }).__rl; if (r && !(r as unknown as { closed?: boolean }).closed) r.prompt(true); } catch {} }, 0);
    return;
  }  if ((e.event_type as string) === "chat:message") {
    const p = e.payload as { text?: string; from?: string; echo?: boolean; id?: string };
    if (p.from === deviceId) return; // own broadcast
    const text = String(p.text ?? "");
    const isEcho = !!p.echo;
    if (isEcho) {
      console.log(`\n[${deviceId}] <- echo from ${p.from}: ${text}`);
    } else {
      console.log(`\n[${deviceId}] <- message from ${p.from}: ${text}`);
      // echo once
      const echoId = `${e.event_id}:echo`;
      if (echoSeen.has(echoId)) return;
      echoSeen.add(echoId);
      const echoEv: DomainEvent = {
        event_id: echoId,
        event_type: "chat:message" as unknown as DomainEvent["event_type"],
        event_version: "1",
        entity_id: deviceId,
        user_id: "u1",
        device_id: deviceId,
        payload: { text: `echo: ${text}`, from: deviceId, echo: true, id: echoId } as unknown as Record<string, unknown>,
        timestamp: new Date().toISOString(),
      };
      localNodeService.broadcastToClients(echoEv);
    }
    // Defer readline prompt until rl is created (guard closed)
    setTimeout(() => { try { const r = (globalThis as unknown as { __rl?: readline.Interface }).__rl; if (r && !(r as unknown as { closed?: boolean }).closed) r.prompt(true); } catch {} }, 0);
  }
}) as unknown as typeof syncLogger.event;

try {
  await localNodeService.initialize();
} catch (e) {
  console.error(`[${deviceId}] initialize failed:`, e);
  process.exit(1);
}

console.log(`[${deviceId}] appInstanceId=${getAppInstanceId()} port=${port} business=${businessId}`);
console.log(`[${deviceId}] isLocalNode=${localNodeService.isLocalNode()} isConnected=${localNodeService.isConnectedToNode()}`);
console.log(`[${deviceId}] mesh: every isLocalNodeEnabled is server+client, discovery _teincnode._tcp.local. mDNS + TLS pinned teinc-local-node (production-faithful)`);
if (process.stdin.isTTY) console.log(`[${deviceId}] Type a line and press enter to send; peer will echo. Ctrl+C to quit.\n`);
else console.log(`[${deviceId}] (background) send via: echo "hello" > /tmp/mesh-${deviceId}.cmd  — logs: /tmp/mesh-${deviceId === "device-A" ? "a" : "b"}.log\n`);

const rl = readline.createInterface({ input: process.stdin, output: process.stdout, prompt: `[${deviceId}] > ` });
(globalThis as unknown as { __rl?: readline.Interface }).__rl = rl;
if (!process.stdin.isTTY) { try { rl.prompt(true); } catch {} }
rl.prompt();

// periodic status
setInterval(() => {
  const s = localNodeStore.getState();
  const st = localNodeService.getState();
  // quiet unless changed, but heartbeat every 5s
}, 5000).unref();

function buildCommand(type: string, entityId: string, payload: Record<string, unknown>): Command {
  return {
    command_id: randomUUID(),
    command_type: type,
    business_id: businessId,
    entity_id: entityId,
    user_id: "u1",
    device_id: deviceId,
    created_at: new Date().toISOString(),
    payload,
  } as Command;
}

async function doOrder(label: string): Promise<void> {
  const id = randomUUID();
  const evt = await localNodeService.handleNodeCommand(buildCommand("order:create", id, {
    items: [{ menu_item_id: "m-jollof", quantity: 1 }],
    item_snapshots: [{ menu_item_id: "m-jollof", name: "Jollof Rice", quantity: 1, unit_price_minor: 5000 }],
    total_minor: 5000,
    subtotal_minor: 5000,
    pos_payment_method: "cash",
    order_type: "takeout",
    customer_name: label || "Walk-in",
  }));
  const o = evt?.payload as { id?: string; order_number?: string; status?: string } | undefined;
  console.log(`[${deviceId}] order created id=${o?.id} number=${o?.order_number} status=${o?.status}`);
}

async function doTransition(orderId: string, commandType: string): Promise<void> {  const evt = await localNodeService.handleNodeCommand(buildCommand(commandType, orderId, { orderId }));
  const p = evt?.payload as { action?: string; orderId?: string } | undefined;
  const db = await openSyncDatabase();
  const row = await getOrderById(db, businessId, orderId);
  console.log(`[${deviceId}] ${commandType} → broadcast action=${p?.action} local status=${row?.status} (${row?.order_number})`);
}

async function doOrders(): Promise<void> {
  const db = await openSyncDatabase();
  const rows = await db.getAllAsync<{ id: string; order_number: string; status: string }>(
    `SELECT id, order_number, status FROM orders WHERE business_id = ? ORDER BY inserted_at;`,
    businessId,
  );
  if (!rows.length) { console.log(`[${deviceId}] orders: (none)`); return; }
  for (const r of rows) console.log(`[${deviceId}] order ${r.order_number} ${r.id.slice(0, 8)} status=${r.status}`);
}

async function handleLine(line: string): Promise<void> {
  const text = line.trim();
  if (!text) return;
  const [cmd, ...rest] = text.split(/\s+/);
  try {
    if (cmd === "/status") {
      const s = localNodeStore.getState();
      console.log(`  isLocalNodeEnabled=${s.isLocalNodeEnabled} port=${s.localNodePort} discovered=${s.discoveredNodes.length} connected=${s.connectedClients.length} isLocalNode=${localNodeService.isLocalNode()} isConnected=${localNodeService.isConnectedToNode()}`);
      console.log(`  discovered: ${s.discoveredNodes.map((n) => `${n.deviceId}@${n.host}:${n.port}`).join(", ") || "(none)"}`);
      console.log(`  clients: ${s.connectedClients.map((c) => c.deviceId).join(", ") || "(none)"}`);
      return;
    }
    if (cmd === "/quit" || cmd === "/exit") { process.exit(0); }
    if (cmd === "/order") { await doOrder(rest.join(" ")); return; }
    if (cmd === "/eng-order") {
      // Full product path: repository -> SyncEngine -> LocalNodeTransport ->
      // peer handleNodeCommand -> order:sync. Proves routing, not just the executor.
      const { randomUUID: uuid } = await import("node:crypto");
      try {
        const o = await orderRepository.createOrder({ businessId, data: { items: [{ menu_item_id: "m-jollof", quantity: 1 }], item_snapshots: [{ menu_item_id: "m-jollof", name: "Jollof Rice", quantity: 1, unit_price_minor: 5000 }], total_minor: 5000, pos_payment_method: "cash", order_type: "takeout", customer_name: rest.join(" ") || "Eng" } as unknown as Parameters<typeof orderRepository.createOrder>[0]["data"], entityId: uuid() });
        console.log(`[${deviceId}] eng-order created id=${o.id} number=${o.order_number} status=${o.status}`);
      } catch (e) { console.log(`[${deviceId}] eng-order failed: ${String(e)}`); }
      return;
    }
    if (cmd === "/eng-accept") {
      // Engine-routed transition via repository (not direct handleNodeCommand).
      // Use a valid action for the order's status (e.g. start_preparing on accepted).
      const action = rest[1] ?? "accept";
      const verbs: Record<string, (p: { orderId: string; businessId: string }) => Promise<unknown>> = {
        accept: (p) => orderRepository.acceptOrder(p),
        start_preparing: (p) => orderRepository.startPreparingOrder(p),
        mark_ready: (p) => orderRepository.markOrderReady(p),
        complete_pickup: (p) => orderRepository.completePickup(p),
        cancel: (p) => orderRepository.cancelOrder(p),
      };
      try {
        const run = verbs[action];
        if (!run) throw new Error(`unknown action ${action}`);
        const o = await run({ orderId: rest[0], businessId });
        console.log(`[${deviceId}] eng-${action} ok status=${(o as { status?: string }).status}`);
      } catch (e) { console.log(`[${deviceId}] eng-${action} failed: ${String(e)}`); }
      return;
    }
    if (cmd === "/prepare") { await doTransition(rest[0], "order:start_preparing"); return; }
    if (cmd === "/ready") { await doTransition(rest[0], "order:mark_ready"); return; }
    if (cmd === "/pickup") { await doTransition(rest[0], "order:complete_pickup"); return; }
    if (cmd === "/orders") { await doOrders(); return; }
    if (cmd === "/ref") {
      const svc = localNodeService as unknown as { peers: Map<string, { isConnected: () => boolean; requestReferenceData?: (b: string, k: string[]) => Promise<{ data?: unknown }> }> };
      const keys = rest.length ? rest : ["menu:items", "operating-hours"];
      let done = 0;
      for (const [, c] of svc.peers) {
        try {
          if (!c.isConnected() || !c.requestReferenceData) continue;
          const res = await c.requestReferenceData(businessId, keys);
          const data = (res?.data ?? {}) as Record<string, unknown>;
          console.log(`[${deviceId}] reference_response keys=${Object.keys(data).join(",") || "(empty)"}`);
          done++;
        } catch (e) { console.log(`[${deviceId}] reference fetch failed: ${String(e)}`); }
      }
      if (!done) console.log(`[${deviceId}] reference fetch: no connected peers`);
      return;
    }
    if (cmd === "/peers") {
      const svc = localNodeService as unknown as { peers: Map<string, { isConnected: () => boolean }> };
      if (!svc.peers || svc.peers.size === 0) { console.log(`[${deviceId}] peers: (none)`); return; }
      for (const [id, c] of svc.peers) {
        let conn = "?";
        try { conn = String(c.isConnected()); } catch (e) { conn = `err ${String(e)}`; }
        console.log(`[${deviceId}] peer ${id} connected=${conn}`);
      }
      return;
    }
    if (cmd === "/redial") {
      const target = rest[0];
      const svc = localNodeService as unknown as { peers: Map<string, { disconnect: () => void }>; reconnectNow: () => void };
      if (target) {
        const s = localNodeStore.getState();
        const node = s.discoveredNodes.find((n) => n.deviceId === target || n.deviceId.startsWith(target));
        if (!node) { console.log(`[${deviceId}] redial: unknown peer ${target}`); return; }
        try { svc.peers.get(node.deviceId)?.disconnect(); } catch {}
        (svc.peers as Map<string, unknown>).delete(node.deviceId);
        console.log(`[${deviceId}] redial: dropped entry for ${node.deviceId}, reconnecting now`);
      } else {
        console.log(`[${deviceId}] redial: reconnecting all missing peers now`);
      }
      try { svc.reconnectNow(); } catch (e) { console.log(`[${deviceId}] reconnectNow failed: ${String(e)}`); }
      return;
    }
    const ev: DomainEvent = {
      event_id: `${deviceId}-${Date.now()}-${Math.random().toString(36).slice(2, 6)}`,
      event_type: "chat:message" as unknown as DomainEvent["event_type"],
      event_version: "1",
      entity_id: deviceId,
      user_id: "u1",
      device_id: deviceId,
      payload: { text, from: deviceId, echo: false, id: deviceId } as unknown as Record<string, unknown>,
      timestamp: new Date().toISOString(),
    };
    console.log(`[${deviceId}] → broadcast: ${text}`);
    localNodeService.broadcastToClients(ev);
  } catch (e) {
    console.log(`[${deviceId}] command failed: ${String(e)}`);
    try { console.log((e as Error)?.stack?.split("\n").slice(1, 5).join("\n")); } catch {}
  }
}

rl.on("line", (line) => {
  void handleLine(line).finally(() => { try { rl.prompt(); } catch {} });
});

// Keep process alive even when stdin is not a TTY (backgrounded proof).
// readline close should not exit; harness is long-lived mesh node.
if (!process.stdin.isTTY) {
  // Background mode: keep alive, also accept commands via FIFO /tmp/mesh-<id>.cmd
  const fifo = `/tmp/mesh-${deviceId}.cmd`;
  try { fs.writeFileSync(fifo, ""); } catch {}
  // Poll fifo for commands (chat lines or /order /prepare /ready /pickup /orders /status)
  setInterval(() => {
    try {
      const txt = fs.readFileSync(fifo, "utf-8").trim();
      if (txt) {
        fs.writeFileSync(fifo, "");
        console.log(`[${deviceId}] <- fifo: ${txt}`);
        void handleLine(txt).finally(() => { try { rl.prompt(true); } catch {} });
      }
    } catch {}
  }, 500).unref();
  // Prevent exit on stdin EOF
  process.stdin.on("end", () => {});
  process.stdin.resume();
}
rl.on("close", () => { if (process.stdin.isTTY) process.exit(0); });

process.on("SIGINT", () => { try { discovery.stop(); } catch {} process.exit(0); });
process.on("SIGTERM", () => { try { discovery.stop(); } catch {} process.exit(0); });

// also watch store for connection changes to print
let lastConn = 0;
setInterval(() => {
  const s = localNodeStore.getState();
  if (s.connectedClients.length !== lastConn) {
    console.log(`\n[${deviceId}] mesh update: connected=${s.connectedClients.length} [${s.connectedClients.map((c) => c.deviceId).join(",")}] discovered=${s.discoveredNodes.length}`);
    try { if (!(rl as unknown as { closed?: boolean }).closed) rl.prompt(true); } catch {}
    lastConn = s.connectedClients.length;
  }
}, 1000).unref();
