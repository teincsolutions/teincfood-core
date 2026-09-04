# Offline-First Strategy — Single Source of Truth: Local SQLite

> `@teincfood/core` `0.7.x` is the single owner of sync. `TeincFoodBusiness` (Expo) and `TeincFoodDesktop` (Tauri) differ only by adapters (`sqliteDriver`, `kvDriver`, `httpClient`, `fileSystemAdapter`, `printAdapters`, `getDeviceId`, `subscribeConnectivity`). No app-local query keys, hooks, or invalidation. Business is the reference correct; Desktop converges to Business.

## 1. Core Concept

* **Device-partitioned orders.** Every device owns the `id:UUIDv4` it creates (global unique, `command-builder.ts:29`, `orders.ex:109` accepts client `id` verbatim) and the display `order_number:DD-RRR-CCC` (`order-number.ts:58` `DD 01-99` leased `device-lease.service.ts:39` + `CCC 001-999` callout). Other devices never create that `id`, they only **view/manage** its `status` lifecycle via events.
* **Local DB of `activeBusinessId` only.** Each device keeps a full SQLite mirror **for the current active business only**: ALL orders (`entity_snapshots type seller_orders` `order-snapshots.service.ts:157` + `pending-orders` `orders.hooks.ts:72` filter), menus / categories / members / tax-rules / operating-hours / business:profile / capabilities (`reference/service.ts:34` `DEFAULT_SYNC_KEYS`, `reference_data PK business_id,key` `migrations.ts:94`). `getEntitySnapshotsByType` is filtered `WHERE business_id=?` (`operations.ts:342`), reference ops always `business_id+key`.
* **After any success ask-for-all-data.** `useSyncReconciliation:65` broad `queryClient.invalidateQueries(POS.all + SELLER.all + KIOSK.all + SELLER_ORDERS.all + BUSINESS_DELIVERIES.all + MENU.all + REFERENCE.all)` with `RECONCILE_DEBOUNCE_MS 400` Set coalesce — one flush per burst, no per-screen `rootKey`.
* **Orders immutable except `status` (+ `is_paid` independent).** `orderRepository` only exposes `accept/reject/start_preparing/mark_ready/complete_pickup/cancel/confirmHandover + payment:confirm_cash` (`orderRepository.ts:77`, `transport-rest.ts:60`). No `order:update`. `applyOrderStatusToReadModelInternal:108` patches only `status`; `applyPaymentEvent:131` patches only `is_paid/paid_at/payment.is_paid` independently — `is_paid` does not imply `status`, used for `awaiting_payment` mobile-money vs cash.
* **Ref data LWW per-key last-HLC** (`reference/operations.ts:77` `compareHLCString`) — sufficient, per-field `lww.ts:10` `lwwMerge` stays unused. Orders never LWW, `HLC` wall-counter-backend `reference_data.ex:86` for versions only.

## 2. Three Lifecycles (UUIDv4 is Stable Across All)

### A. Offline-only on one client → online
```
Offline create: posRepository.createOrder → buildCommand("order:create", bid, entityId:UUIDv4, payload:{items, item_snapshots:{name,unit_price_minor}, tax, DD-RRR-CCC}) → SyncEngine strategy queue (!isOnline || isCloudReachable=unreachable) → commandQueue:193 insertCommand pending + insertEvent origin:local + buildOptimisticOrder(id:UUIDv4) → pending-orders:145 addOrder(upsert) + useSyncReconciliation pending schedule → mergePendingOrders renders in NewOrder/Today/InProgress.
Details: useSellerOrderQuery:322 pending-first id||order_number → same row, real names/prices from item_snapshots, Bill Details via local calculatePricing.
Transitions: same device order:accept etc → queue order.accept_queued {to_status, order_id:UUIDv4} → pending upsert status + snapshot patch → list moves.
Restart offline: hydratePendingOrders:69 replays order.create_queued + queued to_status/is_paid in created_at order → same row reappears as preparing/paid.
Go online (reachable): subscribeConnectivity → replay:327 getPendingCommands ordered created_at → markCommandInFlight → SyncEngine.execute parsedCommand → POST /businesses/:id/pos/orders {id:UUIDv4, local_order_number:DD-RRR-CCC} → Repo insert PK UUIDv4 → Events.emit order.created {business_id, order_number, ...is_paid, device_id:command_id} → deleteCommand → markEventsSynced. RRR dup → 409 ORDER_NUMBER_TAKEN → command-queue:278 regenerate RRR generateOrderNumber(DD) retry same UUID. Followers same UUID → POST /orders/:id/accept etc succeed without id rewrite.
```

### B. Online both on same `business:{id}` (PHX is source)
```
Both joined business:{id} via join events:<userId> {business_id} (events_channel.ex:77). Backend broadcast business:{id} (events.ex:79 replace events:orders) with business_id in payload.
A POST accept → update_status:466 validate_transition → Events.emit order.status_changed {business_id, order_number, to_status, from_status} (+ business_id for POS pickup:690) → PubSub business:{id} → EventsChannel.handle_info:48 user_authorized_for_event? payload.business_id has_business_capability?(:orders_read) → push(socket,"order.status_changed", with _sequence) to A and B.
Both events.service.ts:23 onFrame → order-events.service.ts:31 dispatch → persistOrderEvent cloud → syncEngine.publish → useSyncReconciliation single debounced invalidate → queryClient refetch POS/SELLER/KIOSK for that business_id.
Come online after miss: EventsService connect with {last_sequence} → EventsChannel join replay events_since:63 where authorized → same path + syncReferenceDataOnReconnect + snapshot fallback getSellerList.
If transition hit while B on Dashboard (no order screen): global useRealtimeInvalidation (core single hook at app/_layout.tsx:95 / Desktop App.tsx:121) still flushes — no per-screen rootKey needed.
```

### C. LAN mesh (>1 device, local-node, cloud may be unreachable)
```
Election: localNodeService.isLocalNode sync (store.electedNodeDeviceId===getAppInstanceId()) (Business sync, Desktop memoized getDeviceId).
B (client) creates offline → same as A 1 → local publish: if !isLocalNode() getClient().publishEvent(event) (use-sync-reconciliation:85-97 reference path) + order.* local insertEvent origin:local → node's onRelayEvent receive.
Relay: node A isLocalNode → broadcastToClients(event) → clients B/C applyPendingOrderEvent origin:lan + applyQueuedStatusEvent origin:lan + upsert pending + debounced invalidate, with business_id filter if payload.business_id !== activeBusinessId → drop (subnet shared by two businesses).
Online+LAN mixed: B queued, A online replay → business:{id} broadcast → LAN clients dedup by (type,_sequence) and event_id ON CONFLICT, one flush. B later online replay dedup by UUIDv4 PK idempotent.
Menu/tax LAN: bump_version reference_data.ex:86 → Events.emit reference_data.changed nil,business_id {keys:[k], version} on business:{id} → LAN peers applyReferenceChangeEvent → referenceSyncService.sync via fetcher: Desktop if isLocalNode getReferenceData(db) else client.requestReferenceData (bootstrap 340 vs Business 289 node-serve added).
Per-field LWW not used; per-key last-HLC via reference_versions version wall-counter-backend.
Filtering: both applyOrderStatusToReadModelInternal and getEntitySnapshotsByType are business_id strict, so device viewing B never sees A's orders even on shared subnet.
```

## 3. Real-Time Events — How, When, Where

| Source | Transport | Consumer | When |
|--------|-----------|----------|------|
| Offline queue / pending overlay | `commandQueue.enqueue + insertEvent origin:local` + `pending-orders addOrder` | `useSyncReconciliation` pending schedule | Immediately offline, same device — 400ms coalesce |
| Queued status/cash | `order.*_queued {to_status} / payment.completed_queued {is_paid}` | same + `applyQueuedStatusEvent / applyPaymentEvent` | Offline on same device + LAN peers after relay |
| Online other device | PHX `business:{id}` → `EventsChannel` → `events.service onFrame` → `orderSnapshots persistOrderEvent cloud` → `syncEngine.publish` | `useSyncReconciliation` global debounced invalidate | When cloud reachable, both devices online |
| Missed while offline/closed | `events_since last_sequence` replay on join + `hydratePendingOrders` + `getSellerList` snapshot | Same | On foreground/reconnect |
| Reference | `bump_version → Events.emit reference_data.changed` on `business:{id}` (+ local-node fetcher) | `applyReferenceChangeEvent → referenceSyncService.sync` | Menu/tax/category edit |

**No per-screen `useOrderRealtimeUpdates(POS_KEYS.all)`** — removed. One `useRealtimeInvalidation`/`useSyncReconciliation` at root covers every tab (Dashboard idle still refreshes).

## 4. Echo / Dedup — Three Paths, One Merge

A single order can arrive via **(1) local queue origin:local, (2) LAN origin:lan, (3) cloud origin:cloud / business:{id} PHX** — all converge on same `id:UUIDv4`.

* **insertEvent `ON CONFLICT(event_id) DO NOTHING`** dedup journal; **pending upsert** (`addOrder` by `order_number` replace) prevents duplicate rows; **snapshot upsert** `upsertEntitySnapshot` lastEventTimestamp check skips older.
* **PHX dedup** `events.service.ts:26 if (sequence <= lastSequence) return` + `lastSequence` reset to `0` on `onClose` (Business phoenix-socket) prevents skip after re-join.
* **`event_id` generation** `generateEventId()` for optimistic, server `_sequence` for PHX — both go through `syncEngine.publish(domainEvent)` then `useSyncReconciliation` single `Set` flush, so a Desktop burst `accepted→preparing→ready` deduped to one `invalidateQueries` per 400ms window.
* **LAN dedup** LAN events carry `origin:lan` and same `event_id`; node/client both `insertEvent` — second is noop.
* **Idempotent replay** `POST /businesses/:id/pos/orders {id:UUIDv4}` PK uniqueness → second replay returns existing `{:ok, existing}` via `find_pos_order_by_client_id` PK first (`orders.ex:137`), followers same id hit `update_status` idempotent.

No echo loop: node `broadcastToClients` does not echo back to origin (onRelay forward only), and `reference_data.changed actor_id=nil` uses `business_id` auth not `order_id` participant check (`events_channel.ex:90` business-capability fallback).

## 5. Permissions

`CAPABILITY_BY_COMMAND` (`capabilities.ts:87` + `businesses.ex:103` `has_business_capability?`) checked before routing (`engine.ts:70`, `offline-capable.ts:35`). `orders_create/accept/start_preparing/mark_ready/reject, deliveries_assign/all, menu_manage` roles blocked as `403` both offline (pre-flight) and online (backend `FallbackController 403`). `reference_data.capabilities` cached to `reference_data` key `capabilities` via `businessService.fetchMyBusinessMembership`.

## 6. Single Source for Hooks

Hooks talk only to offline SQLite via core: `usePOSOrdersQuery/useSellerOrdersQuery` `networkMode:offlineFirst` → if offline `getSellerList(businessId,businessId)` + `filterOrdersOffline/paginateOffline` else try `posRepository/sellerService` → `persistSellerOrders` on page1 → fallback snapshot on catch → `mergePendingOrders` sorts `inserted_at`; `useSellerOrderQuery` pending-first `id||order_number` → same row offline/online. Local DB (`pending-orders + entity_snapshots + reference_data + commands/events`) is always fresh; sync just propagates `DomainEvent`s to keep it same across devices/backend. Reference LWW per-key via `version wall-counter-backend`.

## 7. Verification

*Offline-only then online (one client)* airplane → POS create DD-RRR-CCC real items → detail shows (pending-first) → status `accept/preparing/ready` queued → cash `payment:confirm_cash` `is_paid:true` independent → restart offline detail still `preparing/paid` → `reachable` → `replay` same UUIDv4 `0`, server `order.created/status_changed` on `business:{id}`, one 400ms flush.
*Online both on business:{id}* A `accept` → both `EventsService received` → `OrderEventsService dispatching` → `useRealtimeInvalidation flush` even when B on Dashboard.
*LAN mesh* B offline create → A (node) `broadcastToClients business:{A}` → A/C lists show, B restart keeps, B online same UUID idempotent, other business on same subnet never sees.
* menu category offline via `runOfflineCapableMutation` queue → `business:{id} reference_data.changed` → LAN/desktop per-key last-HLC.
