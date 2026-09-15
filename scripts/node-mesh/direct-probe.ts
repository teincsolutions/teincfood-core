#!/usr/bin/env -S node -r tsx --no-warnings
/** Minimal probe: direct TLS + handshake to a peer, bypassing the service layer. */
import { NodeTransport } from "./drivers";
import { deriveLanSecret } from "../../src/local-node/security";

const host = process.argv[2] ?? "192.168.1.45";
const port = parseInt(process.argv[3] ?? "44621", 10);
const businessId = process.argv[4] ?? "0f0764da-53aa-48e4-ac40-3bfd8a52b0ec";
const deviceId = `probe-${Date.now().toString(36)}`;
(globalThis as unknown as { __teincDeviceId?: string }).__teincDeviceId = deviceId;

const secret = await deriveLanSecret({ id: businessId });
console.log(`probe ${deviceId} -> ${host}:${port} business=${businessId}`);

const transport = new NodeTransport();
const client = transport.createClient({
  node: { deviceId: "target", host, port },
  businessId,
  secret,
  onEvent: (e) => console.log("EVENT:", e.event_type),
  onConnected: () => {
    console.log("CONNECTED ✓");
    process.exit(0);
  },
  onDisconnected: () => console.log("disconnected"),
  onError: (e) => console.log("CLIENT ERROR:", String(e)),
});

setTimeout(() => { console.log("TIMEOUT: no onConnected in 12s"); process.exit(2); }, 12000).unref?.();
try {
  await client.connect();
  console.log("connect() resolved (waiting for onConnected...)");
} catch (e) {
  console.log("connect() THREW:", String(e));
  process.exit(1);
}
