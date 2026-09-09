import * as net from "node:net";
import * as tls from "node:tls";
import * as fs from "node:fs";
import * as path from "node:path";
import { fileURLToPath } from "node:url";
import type { Command, DomainEvent } from "../../src/sync/types";
import type { ReferenceDataKey } from "../../src/reference/types";
import type {
  DiscoveryAdapter,
  LocalNodeServer,
  LocalNodeClient,
  TransportAdapter,
} from "../../src/local-node/adapters";
import type { DiscoveredNode } from "../../src/local-node/store";
import { deriveLanSecret, computeProof, generateNonce } from "../../src/local-node/security";
import { createRequire } from "node:module";
const require = createRequire(import.meta.url);
// bonjour-service is CJS
const Bonjour: new () => { publish: (opts: unknown) => unknown; find: (opts: unknown, cb?: unknown) => unknown; destroy: () => void } = require("bonjour-service");

// ---- TLS material — same identity Desktop ships (must match Rust pinned cert) ----
function loadTlsMaterial(): { cert: string; key: string; ca: string } | null {
  const here = path.dirname(fileURLToPath(import.meta.url));
  const candidates = [
    path.resolve(here, "../../../TeincFoodBusiness/assets/tls/server-cert.pem"),
    path.resolve(here, "../../TeincFoodBusiness/assets/tls/server-cert.pem"),
    "/Users/ericmensah/Projects/TeincFoodBusiness/assets/tls/server-cert.pem",
    path.resolve(here, "../TeincFoodDesktop/src-tauri/tls/server-cert.pem"),
    "/Users/ericmensah/Projects/TeincFoodDesktop/src-tauri/tls/server-cert.pem",
  ];
  const keyCandidates = candidates.map((p) => p.replace("server-cert.pem", "server-key.pem"));
  for (let i = 0; i < candidates.length; i++) {
    try {
      const cert = fs.readFileSync(candidates[i], "utf-8");
      const key = fs.readFileSync(keyCandidates[i], "utf-8");
      return { cert, key, ca: cert };
    } catch {}
  }
  return null;
}
const TLS_MAT = loadTlsMaterial();
if (!TLS_MAT) console.warn("[NodeTransport] TLS material not found — falling back to plain TCP (not production-faithful)");

// ---- Discovery: production-faithful mDNS via bonjour-service (_teincnode._tcp.local.) ----
const SERVICE_TYPE = "teincnode"; // bonjour-service will advertise as _teincnode._tcp.local.

export class NodeDiscovery implements DiscoveryAdapter {
  private opts: { deviceId: string; deviceName?: string; onNodeFound: (n: DiscoveredNode) => void; onNodeLost: (id: string) => void } | null = null;
  private pub: { deviceId: string; deviceName?: string; port: number } | null = null;
  private bonjour: InstanceType<typeof Bonjour> | null = null;
  private publishedService: ReturnType<InstanceType<typeof Bonjour>["publish"]> | null = null;
  private browser: ReturnType<InstanceType<typeof Bonjour>["find"]> | null = null;
  private seen = new Map<string, DiscoveredNode>();

  setOptions(opts: { deviceId: string; deviceName?: string; onNodeFound: (n: DiscoveredNode) => void; onNodeLost: (id: string) => void }): void {
    this.opts = opts;
  }

  startPublishing(opts: { deviceId: string; deviceName?: string; port: number; onNodeFound: (n: DiscoveredNode) => void; onNodeLost: (id: string) => void }): void {
    this.pub = { deviceId: opts.deviceId, deviceName: opts.deviceName, port: opts.port };
    this.opts = { deviceId: opts.deviceId, deviceName: opts.deviceName, onNodeFound: opts.onNodeFound, onNodeLost: opts.onNodeLost };
    if (!this.bonjour) this.bonjour = new Bonjour();
    // Mobile publishes: publishService("teincnode","tcp","local.", name, port, txt:{deviceId, deviceName})
    // Rust expects instance_name = deviceId, host auto, port, txt deviceId/deviceName
    try {
      this.publishedService = this.bonjour.publish({
        name: opts.deviceId,
        type: SERVICE_TYPE,
        protocol: "tcp",
        port: opts.port,
        txt: { deviceId: opts.deviceId, deviceName: opts.deviceName ?? opts.deviceId },
      } as Parameters<InstanceType<typeof Bonjour>["publish"]>[0]);
    } catch (e) {
      console.error("[NodeDiscovery] publish failed", e);
    }
    this.startScanning();
  }

  startScanning(): void {
    if (this.browser) return;
    if (!this.bonjour) this.bonjour = new Bonjour();
    // Browse _teincnode._tcp.local. — mirrors Rust discovery::SERVICE_TYPE
    this.browser = this.bonjour.find({ type: SERVICE_TYPE, protocol: "tcp" }, (service: unknown) => {
      // bonjour-service calls onup for each up event already via event, but find callback also fires
    });
    const onUp = (service: {
      name: string;
      host: string;
      port: number;
      txt?: Record<string, string>;
      referer?: { address: string };
      addresses?: string[];
    }) => {
      const txt = service.txt ?? {};
      const deviceId = txt.deviceId ?? service.name;
      const selfId = this.pub?.deviceId ?? this.opts?.deviceId ?? "";
      if (!deviceId || deviceId === selfId) return;
      // Prefer routable IPv4 like Rust: !loopback && !127. && !fe80
      let host: string | null = null;
      const addrs: string[] = (service as unknown as { addresses?: string[] }).addresses ?? [];
      if (service.referer?.address) addrs.unshift(service.referer.address);
      if (service.host && !service.host.endsWith(".local")) addrs.unshift(service.host);
      // try to pick best
      host = addrs.find((a) => a.includes(".") && !a.startsWith("127.") && !a.startsWith("fe80")) ?? addrs.find((a) => a.includes(".")) ?? null;
      // bonjour-service on loopback may give hostname like "MacBook.local" — resolve to 127.0.0.1 for same-machine proof
      if (!host || host.endsWith(".local") || host === "localhost") host = "127.0.0.1";
      const target = this.pub ? this.opts?.onNodeFound : this.opts?.onNodeFound;
      if (!target) return;
      const node: DiscoveredNode = {
        deviceId,
        name: deviceId,
        host,
        port: service.port,
        deviceName: txt.deviceName,
        lastSeenAt: new Date().toISOString(),
      };
      this.seen.set(deviceId, node);
      target(node);
    };
    const onDown = (service: { name: string; txt?: Record<string, string> }) => {
      const deviceId = service.txt?.deviceId ?? service.name;
      if (this.seen.has(deviceId)) {
        this.seen.delete(deviceId);
        const target = this.pub ? this.opts?.onNodeLost : this.opts?.onNodeLost;
        target?.(deviceId);
      }
    };
    (this.browser as unknown as { on: (e: string, fn: (s: unknown) => void) => void }).on("up", onUp as unknown as (s: unknown) => void);
    (this.browser as unknown as { on: (e: string, fn: (s: unknown) => void) => void }).on("down", onDown as unknown as (s: unknown) => void);
  }

  stopScanning(): void {
    if (this.browser) {
      try { (this.browser as unknown as { stop: () => void }).stop(); } catch {}
      this.browser = null;
    }
  }

  stop(): void {
    this.stopScanning();
    if (this.publishedService) {
      try { (this.publishedService as unknown as { stop: () => void }).stop?.(); } catch {}
      this.publishedService = null;
    }
    if (this.bonjour) {
      try { this.bonjour.destroy(); } catch {}
      this.bonjour = null;
    }
    this.pub = null;
    this.opts = null;
    this.seen.clear();
  }
}

// ---- Transport: production-faithful Rust protocol (type/kind) over TLS, newline-delimited JSON ----
type RustMsg = { type: string; id: string; payload: Record<string, unknown> };
function rustSend(sock: net.Socket | tls.TLSSocket, kind: string, payload: unknown, id?: string) {
  const msg: RustMsg = { type: kind, id: id ?? `${Date.now()}-${Math.random().toString(36).slice(2, 6)}`, payload: payload as Record<string, unknown> };
  sock.write(JSON.stringify(msg) + "\n");
}
function isRustMsg(obj: unknown): obj is RustMsg { return !!obj && typeof (obj as { type?: unknown }).type === "string" && typeof (obj as { id?: unknown }).id === "string"; }

export class NodeTransport implements TransportAdapter {
  createServer(opts: {
    port: number;
    businessId: string;
    secret: string;
    onCommand: (c: Command) => Promise<DomainEvent[]>;
    onRelayEvent: (e: DomainEvent) => void;
    onClientConnected: (info: { deviceId: string; deviceName?: string; host?: string }) => void;
    onClientDisconnected: (deviceId: string) => void;
  }): LocalNodeServer {
    let server: net.Server | tls.Server | null = null;
    const clients = new Map<string, net.Socket | tls.TLSSocket>();
    const peerNonces = new Map<string, string>(); // sock remote -> nonce
    let listening = false;

    const handleConn = (sock: net.Socket | tls.TLSSocket) => {
      console.log(`[NodeTransport] incoming ${sock.remoteAddress}:${sock.remotePort} -> ${opts.port} (TLS=${!!(sock as unknown as { encrypted?: boolean }).encrypted})`);
      let buf = "";
      let authedDevice: string | null = null;
      let authed = false;
      sock.setEncoding("utf-8");
      sock.on("data", async (chunk) => {
        buf += chunk as string;
        let nl: number;
        while ((nl = buf.indexOf("\n")) !== -1) {
          const line = buf.slice(0, nl).trim();
          buf = buf.slice(nl + 1);
          if (!line) continue;
          let msg: unknown;
          try { msg = JSON.parse(line); } catch { console.log(`[NodeTransport] json parse fail`); continue; }
          if (!isRustMsg(msg)) { console.log(`[NodeTransport] not Rust msg, ignoring`); continue; }
          const m = msg as RustMsg;
          console.log(`[NodeTransport] msg type=${m.type} id=${m.id}`);
          if (m.type === "hello") {
            const deviceId = String((m.payload as { deviceId?: unknown }).deviceId ?? "");
            const businessId = String((m.payload as { businessId?: unknown }).businessId ?? "");
            if (businessId !== opts.businessId) { console.log(`[NodeTransport] business mismatch ${businessId} != ${opts.businessId}`); rustSend(sock, "auth_fail", { reason: "business_mismatch" }, m.id); continue; }
            const nonce = await generateNonce();
            (sock as unknown as { _nonce?: string })._nonce = nonce;
            (sock as unknown as { _deviceId?: string })._deviceId = deviceId;
            (sock as unknown as { _deviceName?: string })._deviceName = String((m.payload as { deviceName?: unknown }).deviceName ?? "");
            rustSend(sock, "challenge", { nonce }, m.id);
          } else if (m.type === "auth") {
            const nonce = String((m.payload as { nonce?: unknown }).nonce ?? "");
            const proof = String((m.payload as { proof?: unknown }).proof ?? "");
            const expectedNonce = (sock as unknown as { _nonce?: string })._nonce;
            if (!expectedNonce || nonce !== expectedNonce) { rustSend(sock, "auth_fail", { reason: "bad_nonce" }, m.id); continue; }
            const expected = await computeProof(opts.secret, nonce);
            console.log(`[NodeTransport] auth device=${(sock as unknown as { _deviceId?: string })._deviceId} proof ok=${expected===proof}`);
            if (expected !== proof) { rustSend(sock, "auth_fail", { reason: "invalid_proof" }, m.id); sock.destroy(); return; }
            authed = true;
            authedDevice = (sock as unknown as { _deviceId?: string })._deviceId ?? null;
            if (authedDevice) {
              (sock as unknown as { _peerId?: string })._peerId = authedDevice;
              clients.set(authedDevice, sock);
              opts.onClientConnected({ deviceId: authedDevice, deviceName: (sock as unknown as { _deviceName?: string })._deviceName, host: sock.remoteAddress ?? undefined });
            }
            rustSend(sock, "auth_ok", {}, m.id);
          } else if (m.type === "register") {
            if (!authed) continue;
            // second connected emission (Rust does it on register too)
            if (authedDevice) opts.onClientConnected({ deviceId: authedDevice, deviceName: String((m.payload as { deviceName?: unknown }).deviceName ?? authedDevice), host: sock.remoteAddress ?? undefined });
            rustSend(sock, "register_ack", {}, m.id);
          } else if (m.type === "relay_event") {
            if (!authed) continue;
            const ev = m.payload as unknown as DomainEvent;
            // relay to other authenticated peers
            for (const s of clients.values()) if (s !== sock) rustSend(s, "event", ev);
            opts.onRelayEvent(ev);
          } else if (m.type === "command") {
            if (!authed) { rustSend(sock, "auth_fail", { reason: "unauthenticated" }, m.id); continue; }
            try {
              const events = await opts.onCommand(m.payload as unknown as Command);
              rustSend(sock, "command_response", events, m.id);
            } catch { rustSend(sock, "command_response", [], m.id); }
          } else if (m.type === "reference_fetch") {
            if (!authed) continue;
            rustSend(sock, "reference_response", { data: {} }, m.id);
          } else if (m.type === "ping") {
            rustSend(sock, "pong", {}, m.id);
          }
        }
      });
      sock.on("close", () => {
        const pid = (sock as unknown as { _peerId?: string })._peerId;
        console.log(`[NodeTransport] close peer=${pid}`);
        if (pid) {
          clients.delete(pid);
          opts.onClientDisconnected(pid);
        }
      });
      sock.on("error", (e) => console.log(`[NodeTransport] sock error ${e}`));
    };

    return {
      start: async () =>
        new Promise<void>((resolve, reject) => {
          if (TLS_MAT) {
            server = tls.createServer({ cert: TLS_MAT.cert, key: TLS_MAT.key, requestCert: false }, (sock) => handleConn(sock as tls.TLSSocket));
          } else {
            server = net.createServer((sock) => handleConn(sock));
          }
          server.on("error", reject);
          server.listen(opts.port, "0.0.0.0", () => { listening = true; console.log(`[NodeTransport] LISTEN ${opts.port} TLS=${!!TLS_MAT}`); resolve(); });
        }),
      stop: async () =>
        new Promise<void>((resolve) => {
          listening = false;
          for (const s of clients.values()) try { s.destroy(); } catch {}
          clients.clear();
          if (!server) return resolve();
          server.close(() => resolve());
        }),
      isListening: () => listening,
      broadcast: (event: DomainEvent) => {
        for (const s of clients.values()) rustSend(s, "event", event);
      },
    };
  }

  createClient(opts: {
    node: { deviceId: string; host: string; port: number };
    businessId: string;
    secret: string;
    onEvent: (e: DomainEvent) => void;
    onConnected: () => void;
    onDisconnected: () => void;
    onError: (e: unknown) => void;
  }): LocalNodeClient {
    let sock: net.Socket | tls.TLSSocket | null = null;
    let connected = false;
    let buf = "";
    const pendingCmd = new Map<string, (ev: DomainEvent[]) => void>();
    const pendingRef = new Map<string, (d: Record<string, unknown>) => void>();

    const doConnect = async () => {
      let s: net.Socket | tls.TLSSocket | null = null;
      if (TLS_MAT) {
        try {
          s = await new Promise<tls.TLSSocket>((resolve, reject) => {
            // Use IP ServerName for 192.168.x, DNS for *.local — same as Rust client.rs
            // Present client cert to satisfy Rust server's AcceptAnyClient (avoids "certificate required" alert)
            const serverName = /^\d+\.\d+\.\d+\.\d+$/.test(opts.node.host) ? undefined : "teinc-local-node";
            const tlsOpts: tls.ConnectionOptions = { host: opts.node.host, port: opts.node.port, ca: TLS_MAT!.ca, cert: TLS_MAT!.cert, key: TLS_MAT!.key, rejectUnauthorized: false };
            if (serverName) tlsOpts.servername = serverName;
            const tlsSock = tls.connect(tlsOpts, () => resolve(tlsSock as tls.TLSSocket));
            tlsSock.once("error", reject);
            setTimeout(() => reject(new Error("tls timeout")), 4000);
          });
        } catch (e) {
          if (s) try { (s as net.Socket).destroy(); } catch {}
          s = null;
          try {
            s = await new Promise<net.Socket>((resolve, reject) => {
              const plain = new net.Socket();
              plain.once("error", reject);
              plain.connect(opts.node.port, opts.node.host, () => resolve(plain));
              setTimeout(() => reject(new Error("plain timeout")), 2000);
            });
          } catch { throw e; }
        }
      } else {
        s = await new Promise<net.Socket>((resolve, reject) => {
          const plain = new net.Socket();
          plain.once("error", reject);
          plain.connect(opts.node.port, opts.node.host, () => resolve(plain));
        });
      }
      sock = s;
      let helloId = "";
      const onData = async (chunk: string) => {
        buf += chunk;
        let nl: number;
        while ((nl = buf.indexOf("\n")) !== -1) {
          const line = buf.slice(0, nl).trim();
          buf = buf.slice(nl + 1);
          if (!line) continue;
          let msg: unknown;
          try { msg = JSON.parse(line); } catch { continue; }
          if (!isRustMsg(msg)) continue;
          const m = msg as RustMsg;
          console.log(`[NodeTransport client] recv type=${m.type} id=${m.id}`);
          if (m.type === "challenge") {
            const nonce = String((m.payload as { nonce?: unknown }).nonce ?? "");
            const proof = await computeProof(opts.secret, nonce);
            console.log(`[NodeTransport client] challenge nonce=${nonce.slice(0,8)} proof=${proof.slice(0,8)}`);
            rustSend(s!, "auth", { nonce, proof }, m.id);
          } else if (m.type === "auth_ok") {
            console.log(`[NodeTransport client] auth_ok -> register`);
            const callerId = (globalThis as unknown as { __teincDeviceId?: string }).__teincDeviceId ?? "unknown";
            const callerName = callerId;
            rustSend(s!, "register", { deviceId: callerId, deviceName: callerName, businessId: opts.businessId }, m.id);
            // Rust waits for register_ack, but we can mark connected after auth_ok (Rust does too)
            connected = true;
            opts.onConnected();
          } else if (m.type === "register_ack") {
            console.log(`[NodeTransport client] register_ack`);
          } else if (m.type === "auth_fail") {
            console.log(`[NodeTransport client] auth_fail ${JSON.stringify(m.payload)}`);
            opts.onError(new Error(`auth_fail ${JSON.stringify(m.payload)}`));
            try { s!.destroy(); } catch {}
          } else if (m.type === "event") {
            opts.onEvent(m.payload as unknown as DomainEvent);
          } else if (m.type === "command_response") {
            const cb = pendingCmd.get(m.id);
            if (cb) { pendingCmd.delete(m.id); cb((m.payload as unknown as DomainEvent[]) ?? []); }
          } else if (m.type === "reference_response") {
            const cb = pendingRef.get(m.id);
            if (cb) { pendingRef.delete(m.id); cb((m.payload as { data?: Record<string, unknown> }).data ?? {}); }
          } else if (m.type === "pong") {
            // keepalive
          }
        }
      };
      s.setEncoding("utf-8");
      s.on("data", onData as unknown as (d: Buffer) => void);
      s.on("close", () => { console.log(`[NodeTransport client] close`); connected = false; opts.onDisconnected(); });
      s.on("error", (e) => { console.log(`[NodeTransport client] error ${e}`); opts.onError(e); });
      // Rust hello: {type:"hello", id, payload:{deviceId, deviceName, businessId}}
      const callerId = (globalThis as unknown as { __teincDeviceId?: string }).__teincDeviceId ?? "unknown";
      helloId = `${Date.now()}`;
      console.log(`[NodeTransport client] hello device=${callerId} business=${opts.businessId}`);
      rustSend(s, "hello", { deviceId: callerId, deviceName: callerId, businessId: opts.businessId }, helloId);
    };

    return {
      connect: async () => { await doConnect(); },
      disconnect: () => { try { sock?.destroy(); } catch {} sock = null; connected = false; },
      isConnected: () => connected,
      execute: async (command: Command) => {
        if (!sock || !connected) throw new Error("not connected");
        return new Promise<DomainEvent[]>((resolve) => {
          const id = `${Date.now()}-${Math.random().toString(36).slice(2,6)}`;
          pendingCmd.set(id, resolve);
          rustSend(sock!, "command", command, id);
          setTimeout(() => { if (pendingCmd.has(id)) { pendingCmd.delete(id); resolve([]); } }, 10000);
        });
      },
      requestReferenceData: async (businessId, keys) => {
        if (!sock || !connected) throw new Error("not connected");
        const id = `${Date.now()}-${Math.random().toString(36).slice(2,6)}`;
        return new Promise((resolve) => {
          pendingRef.set(id, (data) => resolve({ data: data as unknown as Partial<Record<ReferenceDataKey, import("../../src/reference/types").ReferenceDataRecord | null>> }));
          rustSend(sock!, "reference_fetch", { businessId, keys }, id);
          setTimeout(() => { if (pendingRef.has(id)) { pendingRef.delete(id); resolve({ data: {} }); } }, 10000);
        });
      },
      publishEvent: (event: DomainEvent) => { if (sock && connected) rustSend(sock, "relay_event", event); },
    };
  }
}
