# @teincfood/core

TeincFood shared offline-first core — single source of truth for mobile (`TeincFoodBusiness`) and desktop (`TeincFoodDesktop`).

Current: `0.7.31`. UI → hooks → repositories → core → SQLite → SyncEngine (cloud → LAN mesh → queue) → reconciliation → UI.

## What lives here

- `types/api/*` — snake_case API contracts matching backend
- `utils/*` — currency, error, format, uuid, order-number (DD-RRR-CCC), order-transitions, etc.
- `sync/*` — engine, command-queue, transports (`rest`, `local_node`), pending-orders, order-snapshots, reconciliation
- `db/*` — migrations + operations (driver-agnostic, takes a `SqliteDriver`)
- `reference/*` — versioned reference-data cache (per-key HLC LWW)
- `repositories/*` — order/pos repositories (explicit verbs, no `order.update`)
- `local-node/*` — **LAN mesh**: lib-owned crypto/protocol/orchestration (`docs/MESH.md`)
- `adapters/*` — platform seams (KV, SQLite, HTTP, local-node, connectivity, devices, auth, business, …)

## Adapters

Apps supply platform adapters via `createTeincCore({ storage, db, http, ... })`:

- `KVStorage` — async `getItem/setItem/removeItem` (MMKV-wrapped on mobile, `plugin-store` on desktop)
- `SqliteDriver` — `execAsync/runAsync/getFirstAsync/getAllAsync/withTransactionAsync`
- `HttpClient` — axios/fetch instance with auth interceptors (token plumbing stays app-side)
- `LocalNodeDeps` — `transport {createServer, createClient}`, `discovery {startPublishing, startScanning, ...}`, `getAuth/getBusiness/getDeviceId`. Core derives the LAN secret and owns the mesh lifecycle; apps only provide sockets/mDNS/TLS primitives.

## LAN mesh

No election: every `isLocalNodeEnabled` device is server + client. Spec: `docs/MESH.md`.
Two-process harness (real mDNS + TLS, no apps): `scripts/node-mesh/README.md`.

## Docs

- `docs/MESH.md` — LAN mesh, single source of truth (crypto, wire protocol, lifecycle, order flow)
- `docs/OFFLINE_FIRST_STRATEGY.md` — offline-first lifecycles (offline→online, Phoenix, mesh)
- `docs/CORE_ARCHITECTURE.md` — module map and responsibilities
- `docs/AUDIT.md` — historical `0.7.10` pre-implementation snapshot (superseded where it conflicts with `MESH.md`)

## Checks

```bash
npx tsc --noEmit        # 0 errors
npm test                # 101/101 (mesh + security vectors + sync)
```

## Publishing

Apps consume the packed tarball (`teincfood-core-<version>.tgz` refreshed into
`TeincFoodBusiness`/`TeincFoodDesktop`) or `npm publish --access public`.
