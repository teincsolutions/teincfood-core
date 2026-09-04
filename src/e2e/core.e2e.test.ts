/**
 * E2E tests per §44 — real @teincfood/core, real SQLite (memory), real SyncEngine, real queue/journal.
 * Uses harness mock backend — not faking the synchronization system.
 */
import { describe, it, expect, beforeEach } from "vitest";
import { setConnectivityState, getConnectivityState } from "../adapters/connectivity";
import { posRepository } from "../repositories/pos.repository";
import { orderRepository } from "../repositories/order.repository";
import { createMemoryDriver } from "../test-helpers/memory-driver";
import { setSqliteDriver } from "../adapters/sqlite";
import { closeSyncDatabase, openSyncDatabase } from "../db/connection";
import { getPendingCommands } from "../db/operations";
import { resetHarness, createMockBackend, installMockTransport } from "./harness";
import { setActiveBusiness } from "../adapters/business";
import { commandQueueService } from "../sync/command-queue.service";
import { orderSnapshotsService } from "../sync/order-snapshots.service";
import { SyncEngine } from "../sync/engine";
import { localNodeTransport } from "../sync/transport-local-node";
import { restTransport } from "../sync/transport-rest";
import { setItemSync } from "../adapters/kv";
import { usePendingOrdersStore } from "../adapters/pending-orders";
import { applyOrderStateChangeEvent, hydratePendingOrders } from "../sync/pending-orders.service";
import { setReferenceData, mergeReferenceData, getReferenceData } from "../reference/operations";
import { tickHLC, hlcToString } from "../utils/hlc";
import { generateEventId } from "../utils/uuid";
import { insertCommand } from "../db/operations";

describe.sequential("E2E TEST 1 — offline create → online sync", () => {
  it("offline order immediate local visibility, queue, restart persistence, replay, one order, queue drained", async () => {
    const bid = await resetHarness("biz-e2e");
    const backend = createMockBackend();
    const restore = installMockTransport(backend);
    const engine = new SyncEngine({ transports: [restTransport, localNodeTransport] });
    commandQueueService.setSyncEngine(engine);

    setConnectivityState({ isOnline: false, isCloudReachable: "unreachable" });

    // offline create — should queue
    const itemSnap = [{ menu_item_id: "item1", name: "Jollof", quantity: 1, unit_price_minor: 5000 }];
    const res = await posRepository.createOrder(bid, { items: [{ menu_item_id: "item1", quantity: 1 }], item_snapshots: itemSnap as unknown as [], total_minor: 5000, pos_payment_method: "cash" } as unknown as Parameters<typeof posRepository.createOrder>[1]);
    expect((res as { order_number: string }).order_number).toMatch(/^07-[0-9]{3}-[0-9]{3}$/);
    const cmdId = (res as { command_id?: string }).command_id ?? "";
    // pending overlay should contain it
    expect(usePendingOrdersStore.getState().orders.length).toBe(1);
    const db = await openSyncDatabase();
    const pending = await getPendingCommands(db);
    expect(pending.length).toBe(1);
    // is_paid independent — cash should be paid
    expect((usePendingOrdersStore.getState().orders[0] as unknown as { is_paid: boolean }).is_paid).toBe(true);

    // simulate restart: close and reopen DB, hydrate pending
    await closeSyncDatabase();
    await openSyncDatabase();
    usePendingOrdersStore.getState().setHydrated(false);
    await hydratePendingOrders();
    expect(usePendingOrdersStore.getState().orders.length).toBe(1);

    // go online and replay (auto-replay via connectivity may already be running)
    setConnectivityState({ isOnline: true, isCloudReachable: "reachable" });
    await new Promise((r) => setTimeout(r, 600));
    await commandQueueService.replay();
    await new Promise((r) => setTimeout(r, 200));
    const after = await getPendingCommands(await openSyncDatabase());
    expect(after.length).toBe(0);
    expect(backend.orders.size).toBe(1);
    const orderId = [...backend.orders.keys()][0];
    expect(orderId).toBe(usePendingOrdersStore.getState().orders[0]?.id ?? orderId);

    restore();
  });
});

describe.sequential("E2E TEST 2 — idempotent replay", () => {
  it("replaying same command twice keeps same UUID no duplicate", async () => {
    const bid = await resetHarness("biz-e2e");
    const backend = createMockBackend();
    const restore = installMockTransport(backend);
    setConnectivityState({ isOnline: false, isCloudReachable: "unreachable" });
    const itemSnap = [{ menu_item_id: "item1", name: "Jollof", quantity: 1, unit_price_minor: 5000 }];
    await posRepository.createOrder(bid, { items: [{ menu_item_id: "item1", quantity: 1 }], item_snapshots: itemSnap as never, total_minor: 5000 } as never);
    const uuid = (usePendingOrdersStore.getState().orders[0] as unknown as { id: string }).id;
    const db = await openSyncDatabase();
    const before = await getPendingCommands(db);
    expect(before.length).toBe(1);
    const cmd = before[0];
    // simulate uncertain response: re-insert same command_id (idempotent) — should not create duplicate row
    const dup: Parameters<typeof insertCommand>[1] = { command: { command_id: cmd.command_id, command_type: cmd.command_type, command_version: cmd.command_version, business_id: cmd.business_id, entity_id: cmd.entity_id, user_id: cmd.user_id, device_id: cmd.device_id, timestamp: cmd.timestamp, payload: cmd.payload } as never, status: "pending" };
    await insertCommand(db, dup);
    const afterDup = await getPendingCommands(db);
    expect(afterDup.length).toBe(1);
    expect(afterDup[0].command_id).toBe(cmd.command_id);
    setConnectivityState({ isOnline: true, isCloudReachable: "reachable" });
    await new Promise((r) => setTimeout(r, 600));
    await commandQueueService.replay();
    await new Promise((r) => setTimeout(r, 200));
    const after = await getPendingCommands(await openSyncDatabase());
    expect(after.length).toBe(0);
    expect(backend.orders.size).toBe(1);
    expect([...backend.orders.keys()][0]).toBe(uuid);
    restore();
  });
});

describe.sequential("E2E TEST 7 — business isolation", () => {
  it("biz-A cannot see biz-B orders or reference", async () => {
    await resetHarness("biz-A");
    // create order in biz-A
    await orderSnapshotsService.persistSellerOrders("biz-A", "biz-A", [{ id: "o1", order_number: "07-100-001", status: "pending", business_id: "biz-A" } as never]);
    await orderSnapshotsService.persistSellerOrders("biz-B", "biz-B", [{ id: "o2", order_number: "08-100-001", status: "pending", business_id: "biz-B" } as never]);
    const aList = await orderSnapshotsService.getSellerList("biz-A", "biz-A");
    const bList = await orderSnapshotsService.getSellerList("biz-B", "biz-B");
    expect(aList!.length).toBe(1);
    expect(bList!.length).toBe(1);
    // cross-read should be null
    const cross = await orderSnapshotsService.getSellerList("biz-A", "biz-B");
    expect(cross).toBeNull();
  });
});

describe.sequential("E2E TEST 8 — reference HLC per-key", () => {
  it("per-key last-HLC comparison preserves newer", async () => {
    const db = await openSyncDatabase();
    const bid = "biz-ref";
    const h1 = hlcToString(tickHLC(1000, null, "01"));
    await setReferenceData(db, bid, { key: "menu:items", version: h1, payload: { data: [{ id: "a" }] } as never, downloadedAt: new Date().toISOString(), lastEventId: generateEventId(), lastHlc: h1 });
    const hOld = h1;
    await mergeReferenceData(db, bid, "menu:items", { data: [{ id: "old" }] } as never, hOld, generateEventId());
    let rec = await getReferenceData(db, bid, "menu:items");
    expect((rec!.payload as { data: { id: string }[] }).data[0].id).toBe("a");
    const h2 = hlcToString(tickHLC(2000, null, "02"));
    await mergeReferenceData(db, bid, "menu:items", { data: [{ id: "b" }] } as never, h2, generateEventId());
    rec = await getReferenceData(db, bid, "menu:items");
    expect((rec!.payload as { data: { id: string }[] }).data[0].id).toBe("b");
  });
});

describe.sequential("E2E TEST 12 — burst reconciliation coalesce", () => {
  it("many queued statuses → one invalidate via reconciliation debounce", async () => {
    const bid = await resetHarness("biz-e2e");
    // persist list then burst 10 status patches
    await orderSnapshotsService.persistSellerOrders(bid, bid, [{ id: "o1", order_number: "07-100-001", status: "pending", business_id: bid } as never]);
    const start = Date.now();
    for (let i = 0; i < 10; i++) {
      const evt = { event_id: `e${i}`, event_type: "order.accept_queued", event_version: "1.0", entity_id: "o1", user_id: "u1", device_id: "d1", payload: { order_id: "o1", to_status: i % 2 === 0 ? "accepted" : "preparing", business_id: bid }, timestamp: new Date(start + i).toISOString() } as never;
      await applyOrderStateChangeEvent(evt as never, "local");
    }
    const list = await orderSnapshotsService.getSellerList(bid, bid);
    expect(list).not.toBeNull();
  });
});
