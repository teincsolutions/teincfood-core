# @teincfood/core — Architecture

> `@teincfood/core@0.7.31` Food-specific, platform-independent. Business/Desktop share sync semantics via adapters. LAN mesh spec: `docs/MESH.md` (this doc's §11 is a summary; MESH.md wins on conflict).

## 1. @teincfood/core Architecture
UI → Hooks (`hooks/orders.hooks`) → Repository (`repositories/order, pos`) → `@teincfood/core` → SQLite (`db/connection`, `db/operations`) → SyncEngine (`sync/engine`) → Cloud/LAN/Phoenix → Reconciliation (`sync/use-sync-reconciliation` 400ms Set) → SQLite → UI. See `docs/AUDIT.md:I`.

## 2. TeincFood Domain Responsibilities
Food concepts in core: orders, seller orders, POS orders, menus/categories/products/modifiers/taxes/payments/business capabilities/operating-hours/kitchen stations/printers/DD-RRR-CCC, Food order lifecycle, per-key HLC reference sync. Not generic Retail/Salon.

## 3. Platform Adapter Architecture
Core never imports Expo/Tauri directly. `createTeincCore({sqliteDriver,kvDriver,httpClient,fileSystemAdapter,printAdapters})` injects. Adapters: `adapters/sqlite, kv, http, local-node, connectivity, devices, auth, business, pending-orders, print, filesystem, image-cache`. Business (Expo: mmkv, expo-sqlite, expo-file-system, tcp) and Desktop (Tauri Store, Database, invoke) differ only by adapters. See `src/domain/*` vs `adapters/*`.

## 4. SQLite Local Source of Truth
`teincfood_sync.db` contains `commands`, `events`, `entity_snapshots`, `reference_data`, pending derived from events. Hooks read snapshot (`orderSnapshotsService.getSellerList`) + pending overlay, never cloud primary. SyncEngine writes to SQLite via `insertEvent ON CONFLICT DO NOTHING`, `upsertEntitySnapshot` timestamp check, `pending-orders` hydrate. No `if online fetch else cache` — connectivity controls sync, not source (§4-5). See `hooks/orders.hooks.ts:95` SQLite-first.

## 5. Command/Event Model
Commands (§13): `order.create/accept/reject/start_preparing/mark_ready/complete_pickup/cancel/delivery:* /payment:confirm_cash` with `command_id:UUIDv4`, `business_id,entity_id,device_id,user_id,created_at,payload`. Events (§14): `order.created/status_changed/payment.completed/reference_data.changed` with `event_id,event_type,event_version,business_id,device_id,entity_id,timestamp,origin,sequence`.

## 6. Order Lifecycle
Explicit `orderRepository` verbs (§19): `accept/reject/startPreparing/markReady/completePickup/cancel/confirmHandover/assignRider/confirmCash` — no `order.update`. Transitions via `utils/order-transitions` single source: `CANCELLABLE 5`, `isUnpaid` 3-way, `isDeliveryOrder` (`delivery`), `walk-in never assign`, `awaiting_payment→null`, `canTransition/getAllowedActions/nextActionFor`.

## 7. Payment Lifecycle
`is_paid/paid_at/payment.is_paid` independent (§19). `applyPaymentEvent:order-snapshots:131` patches only paid fields. POS-cash `is_paid:true` immediate; online `awaiting_payment` until `payment:confirm_cash` → `payment.completed` event. `isUnpaid` used for `Collect cash` gate.

## 8. Reference-Data Synchronization
Per-key last-HLC LWW (`reference/operations:77` `compareHLCString`), `reference_data PK(business_id,key)`, `reference/service:34` `DEFAULT_SYNC_KEYS` 8 keys, `reference/api` cloud→localNode fallback, `reference/events` `reference_data.changed {keys,version}` trigger, `lww.ts` unused.

## 9. Transaction Synchronization
Commands→events→queue→journal→retry→replay→idempotency→reconciliation. Orders never LWW. `command-queue:32` MAX_RETRIES 5, `buildOptimisticOrder` item_snapshots, `pending-orders` overlay, `order-snapshots` patch.

## 10. Phoenix Realtime
`business:{id}` (`events.ex:79`→`events_channel:77`→`realtime/events.service:17` `events:<userId> {business_id,last_sequence}`) with `lastSequence` dedup. Flow: Phoenix → Realtime adapter → core event handling → Event journal → SQLite → Reconciliation → UI. No per-screen hooks.

## 11. LAN / Local Node (mesh — full spec `docs/MESH.md`)
Mesh, no election: every `isLocalNodeEnabled` device runs a TLS server + dials peers.
`localNodeService.isLocalNode()` = mesh active + server listening. `handleNodeCommand`
executes `order:create`/transitions via lib guards and broadcasts `order:sync`;
`LocalNodeTransport` routes engine commands to it (self) or the first connected peer.
`broadcastToClients` fans out to all peers; `business_id` strict filter
(`use-sync-reconciliation:108`), no echo loop, origin preserved (`local/lan/cloud`).

## 12. Cloud + LAN Convergence
Same `id:UUIDv4` via 3 paths (local/lan/cloud). `event_id ON CONFLICT`, `entity UUID`, `Phoenix sequence`, `origin`, persistent journal, dedup, no echo loop (§31). `event_id` + `DD-RRR-CCC` RRR regen same UUID on 409.

## 13. Business Isolation
Every record `business_id`. `getEntitySnapshotsByType(...,businessId)` filtered, `reference_data (business_id,key)`, `event.business_id !== activeBusinessId` drop. Tested `db/business-isolation` + `e2e TEST 7`.

## 14. Device Identity
`adapters/devices` stable `core-device-id` via KV `teinc_app_instance_id`, separate from auth token (`adapters/auth`), business identity (`adapters/business`), capabilities.

## 15. Retry / Idempotency
`MAX_RETRIES 5`, `409 ORDER_NUMBER_TAKEN` regen RRR keep UUID (`command-queue:313`), `ON CONFLICT(command_id) DO UPDATE`, `ON CONFLICT(event_id) DO NOTHING`, same UUID survives offline/LAN/cloud/restart.

## 16. Reconciliation
Single global `useSyncReconciliation` 400ms Set coalesce broad `POS+SELLER+KIOSK+SELLER_ORDERS+BUSINESS_DELIVERIES+MENU+REFERENCE`. Dashboard idle still refreshes (§24).

## 17. TeincFoodBusiness Integration
`TeincFoodBusiness/src/core/bootstrap.ts:11` `createTeincCore` with Expo adapters. Hooks `export * from "@teincfood/core"` (seller correct), `pos` shim, `useEventsConnection` + `useSyncReconciliation` at `app/_layout`. See AUDIT C.

## 18. TeincFoodDesktop Integration
`TeincFoodDesktop/src/core/bootstrap.ts:32` Tauri adapters. Same core, Desktop converges to Business. See AUDIT D.

## 19. E2E Testing
Real SQLite memory driver + real SyncEngine + real queue/journal + mock backend (`src/e2e/harness`). Tests: `e2e/core.e2e.test` TEST1 offline→online, TEST2 idempotent, TEST7 isolation, TEST8 HLC, TEST12 burst. Full 12 per §44 via `TeincFoodbackend` local Phoenix for LAN/Phoenix when needed.

## 20. Local Backend Setup
Use existing `TeincFoodbackend` (Phoenix). Commands: `mix ecto.reset && mix run priv/repo/seeds.exs` (seed business, users, capabilities), `mix phx.server` (local API + realtime). E2E `npm test` uses memory harness; for full LAN/Phoenix run `TeincFoodbackend` via `mix`.

## Module Structure (aligned §6-7)
```
src/adapters/*, src/db/*, src/sync/{commands,events,transports,reconciliation,snapshots}, 
src/domain/{orders,reference,payments,business}, src/repositories/*, src/hooks/*, 
src/realtime/*, src/pricing/*, src/utils/order-transitions, src/image-cache/*, src/printer/*
```
New folders re-export canonical files for doc alignment, no breaking change.
