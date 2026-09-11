# LAN Mesh — single source of truth

> `@teincfood/core@0.7.38`. This doc owns the mesh. Anything contradicting it
> (elected node, owner-derived secret, single-client, `rejectUnauthorized` bypass)
> is stale — see cleanup log at the bottom.

## 1. Model: mesh, no election

Every device with `isLocalNodeEnabled` is **both server and client**. There is no
elected node, no `electedNodeDeviceId`, no client-vs-node roles.

- `localNodeStore` (`src/local-node/store.ts`): `isLocalNodeEnabled`, `localNodePort`
  (default `44621`), `discoveredNodes[]`, `connectedClients[]`. Persisted to KV
  `teinc_local_node` (legacy `local_node_data` migrated).
- `localNodeService.isLocalNode()` (`src/local-node/service.ts:139`) means
  **mesh active and server listening** — not "I am the elected one".
- `getElectedNode()` / `getClient()` are compat shims (first peer / first connected
  peer). `getState()` keeps the old shape for UI compat.
- Lifecycle is serialized (`runLifecycle`); `initialize()` is idempotent and safe to
  re-call; `reconnectNow()` re-inits only if the server is down, else re-scans and
  re-dials missing peers without touching live sockets.

## 2. Ownership: lib owns logic, apps own primitives

| Layer | Owner | Files |
|---|---|---|
| Secret derivation, proof, SHA-256 fallback | core | `src/local-node/security.ts` |
| Mesh lifecycle, peer map, routing, `order:sync` apply | core | `src/local-node/service.ts`, `store.ts`, `adapters.ts`, `types.ts` |
| Engine strategy, queue, journal, dedup, reconciliation | core | `src/sync/*` |
| Sockets, mDNS publish/scan, TLS identity | app-provided `LocalNodeDeps` | Business `src/local-node/*`, Desktop `src-tauri/src/local_node/*` |
| Auth/business/device context | app-provided `LocalNodeDeps` | `getAuth/getBusiness/getDeviceId` |

`LocalNodeDeps` (`src/local-node/adapters.ts`): `transport {createServer, createClient}`,
`discovery {startPublishing, startScanning, stop, setOptions}`, `getAuth`, `getBusiness`
(`{id} | null`), `getDeviceId`, `getDeviceName?`, `keepAlive?`, `cloudCommandTimeoutMs?`.
**Transports forward the core-derived `secret` opaquely — apps never derive it.**

## 3. Crypto (lib-owned, single derivation point)

- `secret = SHA256("teinc-lan:{businessId}:")` — owner segment **permanently empty**
  (`security.ts:109`, salt `teinc-lan`). Sole derivation: `service.ts:93`.
- `proof = SHA256("{nonce}:{secret}")` (`computeProof`). Nonce 16 random bytes hex.
- Pure-JS FIPS SHA-256 fallback ships in core (Hermes has no ` subtle`/`createHash`;
  a placeholder hash once produced zero-padded proofs — conformance tests pin this).
- Conformance vectors (`security.test.ts`, mirrored in Rust `security.rs`):
  - `deriveLanSecret({id:"mesh-test-biz"})` → `31e0b7e7…7524d`
  - `biz-1/owner-1` legacy input → `c565b4b4…e9c28a33` (documents owner removal)
  - FIPS `""` → `e3b0c44…7852b855`, `"abc"` → `ba7816b…f20015ad`

## 4. Wire protocol (`src/local-node/types.ts`)

Newline-delimited JSON `{type, id, payload}` over TLS TCP. Sequence per connection:

```
hello {deviceId, deviceName?, businessId?}
  → challenge {nonce}
    → auth {nonce, proof}
      → auth_ok {} | auth_fail {reason?}   // bad proof: invalid_proof, socket closed
        → register {deviceId, deviceName?, businessId?, connectedAt}
          → register_ack {}
```

Steady-state messages: `command {Command}` → `command_response {DomainEvent[]}`,
`event` / `relay_event {DomainEvent}`, `reference_fetch {businessId, keys}` →
`reference_response {data}`, `ping/pong`.

## 5. Discovery + TLS identity

- mDNS `_teincnode._tcp.local.`, TXT `{deviceId, deviceName}`; dedup by `deviceId`;
  routable IPv4 only (skip self/`fe80`); flap guard — discovery loss **never** tears
  down a live socket, only governs (re)connect attempts (`service.ts:176`).
- TLS: pinned self-signed cert, `servername teinc-local-node`,
  SAN `DNS:teinc-local-node,localhost,*.local,IP:127.0.0.1,::1,IP:192.168.1.43-50`.
  **No client certs** (`with_no_client_auth`) — client-cert demand aborts iOS
  handshakes (`-9802`); the challenge proof is the auth.
- Assets: Business `assets/tls/{server-cert.pem,server-key.pem,server-keystore.p12}`
  (passwordless p12 — passworded p12 fails TLS context creation); Desktop embeds the
  same identity in Rust `tls.rs`. Metro `assetExts` includes `pem,p12`.

## 6. Lifecycle guard rails (learned from evidence)

- One client **per peer**, keyed by `deviceId`; `lan_disconnect` takes a `connId` so a
  stale attempt can never kill its replacement; TS releases the replaced attempt
  before dialling (`connectToPeer` stale-release).
- Server side: socket close/error drives teardown; `onRelayEvent` applies
  reference changes; per-peer emit (`lan-event`, `lan-relay-event`,
  `lan-client-connected/disconnected`, `lan-node-disconnected`).
- Reconnect: store subscription dials new discoveries; scan-cycle redial only for
  missing/failed peers; backoff via discovery cadence + bootstrap retry (2s×30).
  Dead (never-connected) entries never block redial — the subscription skips only
  actually-connected peers and `connectToPeer` stale-releases the rest (`0.7.32`,
  regression-tested: first dial refused → re-announce redials → connects).
- One dial per peer at a time (`dialInFlight` + 10s wedged-handshake reaper +
  15s peer sweep so quiet mDNS can't strand dead peers, `0.7.33`, all
  regression-tested). Discovery bursts used to spawn parallel dials that
  destroyed each other mid-handshake — a livelock where nothing completed.
  Rust mirrors this: one handshake per host:port (`connecting` set, fail fast).
- Foreign-business peers (test rigs, neighboring shops) back off 60s after a
  `business_mismatch` rejection instead of redialing every discovery event
  (`0.7.37`, regression-tested).
- Rust lock discipline: never hold the server `peers` guard across `.await`
  (tokio Mutex). A nested lock in the auth path silently stalled every
  same-business handshake after `auth ok`; `broadcast/respond` paths cloned
  senders first for the same reason. Server `send_to`/write-pump log drops.
- Vite HMR full-reload re-runs `initialize()` → handover shutdowns + redials are
  expected in dev, not a bug. Steady state: ~0 redials.

## 7. Order flow over mesh

Engine strategy (`sync/engine.ts`): cloud when reachable **or unknown** → `local_node`
when available → queue. `LocalNodeTransport.execute`: mesh-active device executes via
`handleNodeCommand` locally; otherwise forwards to the first connected peer.

`handleNodeCommand` (`service.ts:302`):
- `order:create` → `createLocalOrder` (lib guards: business hours/capability) →
  `order:sync` event with **full order payload** → `broadcastToClients`.
- `order:accept/reject/start_preparing/mark_ready/complete_pickup/cancel`,
  `payment:confirm_cash` → `transitionLocalOrder` → `order:sync {action, orderId}` →
  broadcast. Guard rejections (`BUSINESS_CLOSED/HOURS_NOT_SYNCED/FORBIDDEN`) throw,
  no queue fallback.
- Anything else: forward to cloud if reachable (else queue), broadcast result.

Peer `onEvent` (`service.ts:259`): full-order `order:sync` → `insertOrder`;
action variant → `transitionLocalOrder`; then `applyPendingOrderEvent`,
`applyReferenceChangeEvent`, `applyOrderStateChangeEvent` (all origin `lan`).
Reconciliation (`sync/use-sync-reconciliation.ts:108`): drops events whose
`payload.business_id` ≠ active business; mesh-active device rebroadcasts engine
events (e.g. replayed `order.created`); LAN reference changes re-sync keys locally.
Convergence: same `id:UUIDv4` on all paths; `event_id ON CONFLICT DO NOTHING`;
`409 ORDER_NUMBER_TAKEN` regenerates RRR keeping UUID.

Reference pull: `requestReferenceData(businessId, keys)` asks connected peers in
turn (`reference_fetch/response`); Desktop serves from SQLite, Business fetches.

## 8. Ports + device ids (field values, not code)

`44621` desktop default · `44622` harness-B · `44631/44632` harness-A/B ·
business `0f0764da-53aa-48e4-ac40-3bfd8a52b0ec` · desktop
`7b5bf8aa-58e4-4682-9e65-22a7faa88a6a` · harness `device-A/B/H`.

## 9. Testing

- Unit: `mesh.test.ts` (lifecycle, persistence, flap-does-not-kill-live,
  stale-release), `security.test.ts` (vectors) — `101/101` green, `tsc 0`.
- Rust: `cargo test local_node 8/8` (vectors, IPs, handshake unit).
- Harness (`scripts/node-mesh/`): two Node processes, real mDNS+TLS, same Rust
  protocol; `chat:message` echo proves the `broadcastToClients/onEvent` path.
  Hold bar: `2×LISTEN + 2×ESTABLISHED`, `0 closes/60s`, `proof ok` both ways.
- Order flow (`/order /prepare /ready /pickup /orders`, real `node:sqlite` DB,
  seeded DD lease + 24/7 hours, cloud forced unreachable — proven `0.7.32`):
  A→B `01-637-001` `accepted→preparing→ready` converged same UUID both sides;
  B→A `02-985-001` converged; single rows, no dupes.
  Design note: LAN has no order catch-up for devices offline during the event —
  a restarted/returning device converges via cloud replay (same UUID idempotent),
  reference pull covers reference keys only.
- Triangle (phone↔desktop↔harness): all cards `Connected`, echo both ways,
  redials ≈ 0 in steady state.

## 10. Cleanup log (docs aligned 2026-09-10)

- `README.md` rewritten (was frozen at `v0.1.0` + old `LanTransport` shape).
- `OFFLINE_FIRST_STRATEGY.md §C` rewritten (was election model).
- `AUDIT.md` bannered as `0.7.10` historical snapshot (§Q superseded here).
- `CORE_ARCHITECTURE.md §11` rewritten (was election); header version bumped.
- `scripts/node-mesh/README.md` secret formula fixed (owner segment empty).
- App `AGENTS.md` LAN sections annotated/extended (Phase 10 mesh).

## 11. Offline-first approach — backend must never block (0.7.34+, 2026-09-11)

Premise: as long as a device has a business, cached data, capabilities, a
leased device number, and is logged in, it offers the FULL experience with
the backend down. LAN exchange keeps terminals continuous; the cloud is a
best-effort fast path, never a gate.

**Single write path.** Every mutation — order create, every status
transition, cash, menu item/category CRUD, availability — builds a command
and runs `SyncEngine.execute` (cloud → LAN node → durable outbox). Direct
SQLite writes from UI flows are banned: they bypass sync and peers never
converge. The single exception is the LAN executor itself
(`handleNodeCommand`), which IS the local write for that leg.

**Orders are transitions, never updates.** No `order:update` exists.
`orderRepository` exposes only `create/accept/reject/start_preparing/
mark_ready/complete_pickup/cancel/confirm_cash/...`. Convergence is by
same-UUID upsert (HLC-guarded) and transition replay — never field merges.

**Reads are SQLite + optimistic overlay.** Lists read the `orders` table
(filtered by business) merged with the pending store (queued creations,
page 1) plus snapshot status overlay (queued transitions). Reactivity comes
from the pending-orders invalidator, which every apply path fires — engine
events, LAN `order:sync`, reference changes.

**Backend-down behavior.** Probes (`GET /api/health`, 4s) settle cloud
state at boot/regain/cooldown; confirmed-unreachable skips the cloud attempt
entirely (no per-command timeout burn). Guard rejections that ARE business
decisions (`BUSINESS_CLOSED/HOURS_NOT_SYNCED/FORBIDDEN`) stand and never
queue-fallback; everything else falls back to LAN then outbox.
`drainOne` joins in-flight drains and `replay()` joins in-flight replays —
no skip-on-busy races. Capabilities fail open when uncached; DD lease and
operating hours work from durable cache with clear "connect online once"
errors only when truly absent.

**Menu convergence.** Menu `menu:*` commands apply to the durable
`menu:items/menu:categories` cache locally (LAN executor and queued
optimistic alike, idempotent by id), fan out `reference_data.changed`,
and peers pull via `reference_fetch/response`. Versions stay backend-owned;
LAN never invents versions.

**No silent failures.** Global mutation error toasts in both apps; detail
screens read SQLite-first with explicit error states (never infinite
spinners); migration fidelity is pinned by a real-SQLite test so no future
migration can drop a table the sync system writes (v8 dropped
`commands/events` as "legacy" while the outbox/journal depended on them —
v9 recreates; that breakage made offline queue throw on fresh DBs).

**Long-outage backoff (0.7.38).** Sync retries share one curve —
`2s` doubling to a `5min` cap with ±20% jitter, attempts reset on any
success or regain. Probes stay a steady 60s heartbeat (cheap, stateless).
Regain (NetInfo online / browser online / foreground) clears backoff and
probes+drains immediately. Outbox rows never dead-letter on transport
failure (only definitive 4xx consumes retries); `replay()` and `drainOne()`
join in-flight work instead of skipping it, so concurrent triggers converge
instead of racing.
