# Pre-Implementation Audit — @teincfood/core vs Offline-First Strategy

> Package: `@teincfood/core` `0.7.10` (`src/index.ts:1`). Never `@teinc/core`.

## A. Existing Architecture — CONFIRMED FROM EXISTING CODE
UI → Hooks (`hooks/orders.hooks.ts:97 usePOSOrdersQuery`) → Repository (`repositories/order.repository.ts:34`) → `SyncEngine {rest,localNode}` (`sync/engine.ts:47`) → `SQLite teincfood_sync.db` (`db/connection.ts:10`) + `useSyncReconciliation 400ms Set` (`sync/use-sync-reconciliation.ts:48`) + TanStack `offlineFirst`. Phoenix `business:{id}` (`events.ex:79`→`events_channel.ex:77`→`realtime/events.service.ts:17`) + `lastSequence` dedup (`realtime/events.service.ts:26`) + LAN `localNodeService` (`adapters/local-node.ts:37`).

## B. Existing @teincfood/core Responsibilities — CONFIRMED
`db/migrations` v1-v4, `db/operations` commands/events/snapshots/reference isolation, `sync/{engine,command-queue,pending-orders,order-snapshots,transport-rest/local-node,order-number,device-lease,hlc}`, `reference/{operations,service,api,events,capabilities}`, `repositories/{order,pos}`, `realtime/{phoenix-socket,events,order-events}`, `adapters/{sqlite,kv,connectivity,http,local-node,devices,auth,business,pending-orders,print,filesystem,image-cache}`, `pricing/engine`, `utils/order-transitions` (new single source 5 cancellable).

## C. Existing Business Integration — CONFIRMED
`TeincFoodBusiness/src/core/bootstrap.ts:11 createTeincCore` wires `mmkv` KV + `expo-sqlite` + `httpClient` + `fileSystem` + `print` + `business/connectivity` bridges. `hooks/seller.hooks:5` correct shim `export * from "@teincfood/core"`; `hooks/kiosk:1` duplicate 259 lines; `sync/*` 9 shims correct; `src/sync/use-sync-reconciliation.ts:42` local copy (no debounce) vs Desktop `App.tsx:121 from core` — gap.

## D. Existing Desktop Integration — CONFIRMED
`TeincFoodDesktop/src/core/bootstrap.ts:32` Tauri `Database.open` + `Store` KV + `invoke` print. `hooks/seller.hooks:1` 500 lines local mutations (bug `accept→preparing:380`), `kiosk:1` duplicate, `utils/order-actions:10` duplicate state machine. `phoenix-socket` reverse `subscribeConnectivity`.

## E. Existing SQLite Model — CONFIRMED
`commands(command_id UNIQUE,business_id,entity_id,status pending/in_flight/failed/completed,retry_count)` + `events(event_id UNIQUE,synced_to_cloud)` + `entity_snapshots(PK entity_type,entity_id,business_id+idx)` + `reference_data PK(business_id,key)+last_hlc` (`migrations.ts:1`). `getEntitySnapshotsByType` now filtered `WHERE business_id=?` (`operations.ts:342`), `CCC` per-business (`order-number.ts:23` `teinc_callout_seq:${businessId}`).

## F. Existing Synchronization Model — CONFIRMED
Engine `resolveStrategy:215` cloud if reachable+rest else local_node else queue; `withTimeout 2500`; `CAPABILITY_BY_COMMAND` pre-flight 403 (`engine:70`). Queue `MAX_RETRIES 5` (`command-queue:32`) + `409 RRR regen same UUID` (`command-queue:313`). Snapshots `applyQueuedStatusEvent`/`applyPaymentEvent` `is_paid` independent. Pending `hydratePendingOrders` (`pending-orders:69`). Reconciliation `400ms Set` broad `POS+SELLER+KIOSK+SELLER_ORDERS+BUSINESS_DELIVERIES+MENU`.

## G. KEEP / ADAPT / MOVE / REMOVE / MISSING — RECOMMENDATION
- KEEP: `db/*`, `sync/types,engine,hlc,uuid`, `adapters/*`, `realtime/phoenix-socket`, `reference/merge HLC`, `pricing`.
- ADAPT: `getEntitySnapshotsByType` filter (done), `CCC` per-business (done), `409` double-failed (done), hooks SQLite-first (pending), `generic useUpdateOrderStatusMutation` → explicit guard (done).
- MOVE: `nextActionFor etc` into `utils/order-transitions` (done).
- REMOVE: `Desktop seller/kiosk` duplicates, `Business use-sync-reconciliation` local copy — after SQLite-first migration.
- MISSING: `SQLite-first hooks` (no `if online fetch else cache`), `E2E TEST 1-12 harness`, `docs` 20 items sec51, `image offline` FS integration test, `backend 409 mapping`.

## H. Problems/Conflicts — CONFIRMED/RECOMMENDATION
1. Hooks `if offline getSellerList else fetch` violates §§4-5 SQLite is source — RECOMMENDATION rewrite to always read snapshot + background sync.
2. `CANCELLABLE` diverge 4 vs 5 — RECOMMENDATION 5 ready inclusive (buyer no-show) — CONFIRMED D1.
3. `isUnpaid` 2-field Desktop vs core 3-way — CONFIRMED fixed via single source.
4. `getEntitySnapshotsByType` leak — CONFIRMED fixed.
5. `pos_controller` 409 not mapped — OPEN QUESTION backend.

## I. Proposed Target Architecture — TARGET ARCHITECTURE
```
TeincFoodBusiness (Expo) + TeincFoodDesktop (Tauri)
  UI/Hooks (TanStack offlineFirst observes SQLite)
    ↓
  Repository (Food explicit verbs)
    ↓
  @teincfood/core
    ↓
  SQLite (commands/events/snapshots/reference/pending)
    ↓
  SyncEngine (rest|localNode) + Reconciliation 400ms Set → SQLite → UI
Adapters inject sqlite/kv/http/phoenix/localNode/fs/print/devices/connectivity.
```

## J. Proposed @teincfood/core Module Structure — TARGET ARCHITECTURE
```
src/
  adapters/         # sqlite, kv, http, realtime, lan, fs, print, devices, connectivity, business, auth, pending-orders, query-keys, image-cache
  db/               # connection, migrations, operations (SQLite source of truth)
  sync/
    commands/       # types, builder, queue (re-export from sync/* compat)
    events/         # journal (db/operations insertEvent ON CONFLICT), bus, dedup
    transports/     # rest, local-node, phoenix (realtime)
    reconciliation/ # use-sync-reconciliation 400ms Set
    snapshots/      # order-snapshots (entity snapshots), pending-orders
    hlc/            # hlc, lww (unused per strategy), order-number, device-lease
  domain/
    orders/         # order-transitions (5 cancellable, walk-in vs delivery, awaiting_payment null), lifecycle
    reference/      # reference operations/service/api/events/capabilities (per-key HLC)
    payments/       # payment:confirm_cash independent is_paid
    business/       # business profile, capabilities
  repositories/     # order, pos (thin)
  hooks/            # orders.hooks (SQLite-first: read snapshot, sync background) — stable usePOSOrdersQuery etc
  realtime/         # phoenix-socket, events.service (business:{id}), order-events
  pricing/          # server-parity
  utils/            # order-transitions (single source), hlc, uuid, etc
  image-cache/      # fs durable
  printer/          # Food receipt template + adapters
```
Physical files keep existing paths; new folders re-export for doc alignment (no break).

## K. Public Interfaces — TARGET ARCHITECTURE
`createTeincCore({sqliteDriver,kvDriver,httpClient,wsBaseUrl,apiBaseUrl})`, `usePOSOrdersQuery/useSellerOrdersQuery/useSellerOrderQuery` (stable), `orderRepository {create,accept,reject,startPreparing,markReady,completePickup,cancel,confirmHandover,assignRider,confirmCash}` explicit, `utils/order-transitions {isUnpaid,isCancellable,cancelLabelFor,isDeliveryOrder,isWalkInPickup,nextActionFor,canTransition,getAllowedActions,getCancelAction,isQueuedResult,CANCELLABLE_STATUSES}` single source.

## L. SQLite Model — TARGET ARCHITECTURE
`teincfood_sync.db`: `commands`, `events(event_id UNIQUE ON CONFLICT DO NOTHING)`, `entity_snapshots(business_id filtered)`, `reference_data PK(business_id,key)+last_hlc`, `pending derived from events` — no competing MMKV/TanStack stores.

## M. Command/Event Model — CONFIRMED
Commands `order.create/accept/reject/start_preparing/mark_ready/complete_pickup/cancel/delivery:* /payment:confirm_cash` (`command_type`, `command_id=UUIDv4`, `business_id,entity_id,device_id,user_id,created_at,payload`). Events `order.created/status_changed/payment.completed/reference_data.changed` (`event_id,event_type,event_version,business_id,device_id,entity_id,timestamp,origin,sequence`).

## N. Transaction Sync Flow — TARGET ARCHITECTURE
Offline create → `buildCommand` UUIDv4 DD-RRR-CCC → `SyncEngine queue` → `insertCommand pending + insertEvent local` → `pending addOrder + orderSnapshots` → `hydratePendingOrders` survives restart → `replay created_at ASC` → `POST {id:UUIDv4,local_order_number}` → `deleteCommand` → `markEventsSynced` → one `invalidateQueries` 400ms flush. 409 → regen RRR same UUID.

## O. Reference Sync Flow — CONFIRMED
`fetchReferenceVersions` → `fetchReferenceChanges` delta HLC `compareHLCString` or full fallback + `cacheReferenceImages` FS + `bump_version` `reference_data.changed {keys,version}` on `business:{id}` → `applyReferenceChangeEvent` → `referenceSyncService.sync` → invalidator.

## P. Phoenix Flow — CONFIRMED
`business:{id}` (`events.ex:79`) `join events:<userId> {business_id,last_sequence}` (`events_channel:77`) → `events.service onFrame sequence>lastSequence` → `orderSnapshots persist cloud` → `syncEngine.publish` → `useSyncReconciliation` Debounce 400ms Set → SQLite → UI. No per-screen hooks.

## Q. LAN/Local-Node Flow — CONFIRMED
Election `isLocalNode` (`adapters/local-node`), client `publishEvent` if not node, node `broadcastToClients` if is node, `business_id !== activeBusinessId` drop, `event_id` dedup `ON CONFLICT`, `origin local/lan/cloud` triples converge same UUID, no echo loop (`actor nil` business-capability fallback `events_channel:90`).

## R. Reconciliation Flow — CONFIRMED
Single `useSyncReconciliation` subscribes `syncEngine` + `reference changed` + `pending` invalidators, debounces 400ms `Set` coalesce broad `POS.all+SELLER.all+KIOSK.all+SELLER_ORDERS.all+BUSINESS_DELIVERIES.all+MENU.all+REFERENCE.all` (`use-sync-reconciliation:65`).

## S. Expo Adapter — TARGET ARCHITECTURE
`sqliteDriver: expo-sqlite`, `kvDriver: mmkvStorage`, `httpClient: axios`, `fileSystem: expo-file-system`, `print: tcp+mdns`, `connectivity: NetInfo`, `devices: expo DeviceId` → `set*Adapter` before `createTeincCore`.

## T. Tauri Adapter — TARGET ARCHITECTURE
`sqliteDriver: @tauri/plugin-sql`, `kvDriver: @tauri/plugin-store`, `httpClient: fetch`, `print: invoke`, `fs: @tauri/plugin-fs` — same `createTeincCore` signatures.

## U. E2E Architecture — TARGET ARCHITECTURE
Real `TeincFoodbackend` local Phoenix + Postgres + seed, real `@teincfood/core` SQLite memory driver + real `SyncEngine` + real `repositories` + real `commandQueue`; TEST 1-12 via two `createTeincCore` engines sharing memory backend mock + `phoenixSocket` in-proc + LAN `localNodeService`.

## V. Migration Phases — RECOMMENDATION
P1 Audit (this doc) → P2 Contracts (order-transitions) → P3 SQLite source (hooks) → P4 commands/events → P5 queue durable → P6 journal dedup → P7 transaction → P8 reference → P9 Phoenix → P10 LAN → P11 reconciliation → P12 Business → P13 Desktop → P14 E2E → P15 cleanup.

## W. Risks — OPEN QUESTION
- Hooks rewrite to SQLite-first may surface stale snapshot if `lastSequence` replay gap — mitigate snapshot fallback `getSellerList`.
- CCC per-business now independent — legacy global `teinc_callout_seq` still synced for compat.
- Backend 409 mapping missing may hide regen path in prod.

## X. Open Questions — OPEN QUESTION
1. `ready` 5 — locked use 5.
2. `awaiting_payment` pay first — locked awaiting_payment→null.
3. `walk-in never assign rider` — locked `isDeliveryOrder`.
