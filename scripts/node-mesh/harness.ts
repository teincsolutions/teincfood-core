#!/usr/bin/env -S node -r tsx --no-warnings
/**
 * Two-process LAN proof — lib alone.
 * Each process gets its own --id (assumed deviceId already set), its own --port, own KV.
 * Usage:
 *   node -r tsx scripts/node-mesh/harness.ts --id device-A --port 44621
 *   node -r tsx scripts/node-mesh/harness.ts --id device-B --port 44622
 * Then type a line in one, the other prints and echoes `echo: <line>` back.
 * Both go over real TCP (127.0.0.1) via file rendezvous discovery, no Business/Desktop.
 */

import * as readline from "node:readline";
import * as fs from "node:fs";
import { localNodeStore } from "../../src/local-node/store";
import { localNodeService, initLocalNodeService } from "../../src/local-node/service";
import { setKVDriver } from "../../src/adapters/kv";
import { setAppInstanceId, getAppInstanceId } from "../../src/adapters/devices";
import { setConnectivityState } from "../../src/adapters/connectivity";
import { syncLogger } from "../../src/utils/sync-logger";
import { NodeDiscovery, NodeTransport } from "./drivers";
import type { DomainEvent } from "../../src/sync/types";

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

// In-memory SQLite no-op so openSyncDatabase not needed for chat flow
// The service's handleNodeCommand fallback to commandQueue needs DB; we stub it for chat.
import { setSqliteDriver } from "../../src/adapters/sqlite";
setSqliteDriver({
  getFirstAsync: async () => null,
  getAllAsync: async () => [],
  runAsync: async () => ({ lastInsertRowId: 0, changes: 0 }),
  execAsync: async () => {},
} as unknown as Parameters<typeof setSqliteDriver>[0]);

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
const ownerId = arg("ownerId") ?? arg("owner_id") ?? ""; // match Desktop persisted business_data (no owner_id field) -> secret ""

(globalThis as unknown as { __teincDeviceId?: string }).__teincDeviceId = deviceId;
setAppInstanceId(deviceId);

// Make store believe enabled before init
localNodeStore.getState().setIsLocalNodeEnabled(true);
localNodeStore.getState().setLocalNodePort(port);

const discovery = new NodeDiscovery();
const transport = new NodeTransport();

initLocalNodeService({
  getDeviceId: () => deviceId,
  getDeviceName: () => deviceName,
  getBusiness: () => ({ id: businessId, ownerId }),
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
  if ((e.event_type as string) === "chat:message") {
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

console.log(`[${deviceId}] appInstanceId=${getAppInstanceId()} port=${port} business=${businessId} owner=${ownerId.slice(0,8)}`);
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

rl.on("line", (line) => {
  const text = line.trim();
  if (!text) { rl.prompt(); return; }
  if (text === "/status") {
    const s = localNodeStore.getState();
    console.log(`  isLocalNodeEnabled=${s.isLocalNodeEnabled} port=${s.localNodePort} discovered=${s.discoveredNodes.length} connected=${s.connectedClients.length} isLocalNode=${localNodeService.isLocalNode()} isConnected=${localNodeService.isConnectedToNode()}`);
    console.log(`  discovered: ${s.discoveredNodes.map((n) => `${n.deviceId}@${n.host}:${n.port}`).join(", ") || "(none)"}`);
    console.log(`  clients: ${s.connectedClients.map((c) => c.deviceId).join(", ") || "(none)"}`);
    rl.prompt();
    return;
  }
  if (text === "/quit" || text === "/exit") { process.exit(0); }
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
  rl.prompt();
});

// Keep process alive even when stdin is not a TTY (backgrounded proof).
// readline close should not exit; harness is long-lived mesh node.
if (!process.stdin.isTTY) {
  // Background mode: keep alive, also accept commands via FIFO /tmp/mesh-<id>.cmd
  const fifo = `/tmp/mesh-${deviceId}.cmd`;
  try { fs.writeFileSync(fifo, ""); } catch {}
  // Poll fifo for commands
  setInterval(() => {
    try {
      const txt = fs.readFileSync(fifo, "utf-8").trim();
      if (txt) {
        fs.writeFileSync(fifo, "");
        // treat fifo content as a line to send
        const ev: DomainEvent = {
          event_id: `${deviceId}-${Date.now()}-${Math.random().toString(36).slice(2, 6)}`,
          event_type: "chat:message" as unknown as DomainEvent["event_type"],
          event_version: "1",
          entity_id: deviceId,
          user_id: "u1",
          device_id: deviceId,
          payload: { text: txt, from: deviceId, echo: false, id: deviceId } as unknown as Record<string, unknown>,
          timestamp: new Date().toISOString(),
        };
        console.log(`[${deviceId}] -> broadcast (via fifo): ${txt}`);
        localNodeService.broadcastToClients(ev);
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
