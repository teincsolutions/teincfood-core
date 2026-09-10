# Node Mesh Harness — production-faithful two-process LAN proof for teincfood-core alone

Runs two separate Node processes on this Mac, each as its own app-id (deviceId assumed already set), **mesh via real mDNS + TLS** (same as production Desktop/Mobile), no Business/Desktop, no Expo/Tauri.

Each process:
- owns its `teinc_app_instance_id` / `deviceId` (passed via --id, stable at install via `setAppInstanceId`)
- enables `isLocalNodeEnabled` + `localNodePort` via core's `localNodeStore` (no `elected`, mesh)
- `initLocalNodeService` with Node-native Discovery + Transport:
  - **Discovery:** `bonjour-service` `_teincnode._tcp.local.` `publishService(name=deviceId, type=teincnode, protocol=tcp, port, txt:{deviceId,deviceName})` + `browser` `find({type:teincnode,protocol:tcp})` → `onNodeFound {deviceId,host,port}` (Rust `mdns-sd` `discovery.rs:9` same `SERVICE_TYPE`, same `192.168.x` / `*.local` handling)
  - **Transport:** `tls` with pinned `TeincFoodBusiness/assets/tls/server-cert.pem` + `server-key.pem` `SAN DNS:teinc-local-node,*.local,IP:127.0.0.1,IP:192.168.1.43-50` `servername teinc-local-node` (Rust `tls.rs:35` `server_config/client_config` `PinServer` byte-match), newline-delimited JSON `hello {nonce,proof=sha256(nonce:secret)}` where `secret=deriveLanSecret(business)` = `SHA256("teinc-lan:{businessId}:")` (owner segment permanently empty — full spec `docs/MESH.md`)
- CLI: type a line -> broadcast `chat:message` DomainEvent to all mesh peers; peer prints and echoes `echo: <text>` once. This is the same `broadcastToClients` / `onEvent` path product uses for `order:sync` / `reference_data.changed`.

Usage:
  # harness↔harness (both production-faithful mDNS+TLS, same as Desktop↔Mobile)
  npx tsx scripts/node-mesh/harness.ts --id device-A --port 44621 --business 0f0764da-53aa-48e4-ac40-3bfd8a52b0ec
  npx tsx scripts/node-mesh/harness.ts --id device-B --port 44622 --business 0f0764da-53aa-48e4-ac40-3bfd8a52b0ec
  # background (proof): echo "hello" > /tmp/mesh-device-A.cmd  → B prints `← message` + echoes, A prints `← echo`

Both connect over real LAN (two `*:44621/*:44622` `LISTEN` + `2×ESTABLISHED` `192.168.1.45`, TLS handshake, secret proof). Same code Desktop uses via `TauriDiscovery/TauriTransport`.

Assumes device id already set (--id). No elected node, mesh: every isLocalNodeEnabled is server+client (each syncs individually to cloud `UUIDv4`).

Install: `npm i -D tsx bonjour-service`; checks `npx tsc --noEmit` `0` `npm test` `101/101`.
Desktop↔harness: run one harness as second device, run Desktop `cargo tauri dev` with same `business` and `Enable Local Node` ON, expect `lsof *:44621/*:44622` `ESTABLISHED` and `chat:message` echo both ways.

