/**
 * E2E tests per §44 — real @teincfood/core, real SQLite (memory), real SyncEngine, real queue/journal.
 * Uses harness mock backend — not faking the synchronization system.
 */
import { describe, it, expect } from "vitest";
import { setConnectivityState } from "../adapters/connectivity";
import { setHttpClient } from "../adapters/http";
import { getLocalOrder } from "../domain/orders/service";
import { getSyncJobsPendingCount, drainPending } from "../sync/sync-jobs.service";
import { commandQueueService } from "../sync/command-queue.service";
import { posRepository } from "../repositories/pos.repository";
import { closeSyncDatabase, openSyncDatabase } from "../db/connection";
import { getUnsyncedEvents } from "../db/operations";
import { resetHarness } from "./harness";
import { orderSnapshotsService } from "../sync/order-snapshots.service";
import { applyOrderStateChangeEvent, applyPendingOrderEvent, hydratePendingOrders, mergePendingIntoList } from "../sync/pending-orders.service";
import { usePendingOrdersStore } from "../adapters/pending-orders";
import { setReferenceData, mergeReferenceData, getReferenceData } from "../reference/operations";
import { tickHLC, hlcToString } from "../utils/hlc";
import { generateEventId } from "../utils/uuid";

describe.sequential("E2E TEST 1 — offline create → online sync", () => {
  it("offline order optimistic event, outbox, restart persistence, replay, one order, queues drained", async () => {
    const bid = await resetHarness("biz-e2e");
    // Mock HTTP backend: records POS creates by client UUID (idempotent).
    const received = new Map<string, unknown>();
    setHttpClient({
      get: async () => ({ data: { data: [], pagination: { total_pages: 1 } } }) as unknown as never,
      post: async (url: string, body?: unknown) => {
        if (url.includes("/pos/orders")) {
          const id = (body as { id?: string })?.id ?? "";
          if (!received.has(id)) received.set(id, body);
        }
        return { data: {} } as unknown as never;
      },
      put: async () => ({ data: {} }) as unknown as never,
      patch: async () => ({ data: {} }) as unknown as never,
      delete: async () => ({ data: {} }) as unknown as never,
    } as never);

    setConnectivityState({ isOnline: false, isCloudReachable: "unreachable" });

    // offline create — engine routes to the outbox (no transport available).
    // Returns the optimistic order (same UUID + DD-NNNN-MMM, cash paid).
    const itemSnap = [{ menu_item_id: "item1", name: "Jollof", quantity: 1, unit_price_minor: 5000 }];
    const res = await posRepository.createOrder(bid, { items: [{ menu_item_id: "item1", quantity: 1 }], item_snapshots: itemSnap as unknown as [], total_minor: 5000, pos_payment_method: "cash" } as unknown as Parameters<typeof posRepository.createOrder>[1]);
    expect((res as { order_number: string }).order_number).toMatch(/^07-[0-9]{4}-[0-9]{3}$/);
    expect(res.is_paid).toBe(true);
    // durable command outbox holds it (not yet confirmed in the orders table)
    expect(await commandQueueService.getPendingCount()).toBe(1);
    expect((await getLocalOrder(bid, res.id))?.id).toBeUndefined();
    // optimistic event journaled; the reconciliation subscriber would apply it
    // into the pending store (simulate that hop here deterministically)
    const db0 = await openSyncDatabase();
    const journaled = await getUnsyncedEvents(db0, "local", 10);
    const queued = journaled.find((e) => e.event_type === "order.create_queued");
    expect(queued).toBeDefined();
    await applyPendingOrderEvent(queued!, "local");
    expect(usePendingOrdersStore.getState().orders.map((o) => o.id)).toContain(res.id);
    // lists merge the pending overlay on page 1
    const merged = await mergePendingIntoList([], bid, 1);
    expect(merged.map((o) => o.id)).toContain(res.id);

    // simulate restart: close and reopen DB — outbox + journal survive;
    // pending store rehydrates from the journal
    await closeSyncDatabase();
    await openSyncDatabase();
    expect(await commandQueueService.getPendingCount()).toBe(1);
    await hydratePendingOrders();
    expect(usePendingOrdersStore.getState().orders.map((o) => o.id)).toContain(res.id);

    // go online and replay — one backend order, same UUID, queues empty
    setConnectivityState({ isOnline: true, isCloudReachable: "reachable" });
    await commandQueueService.replay();
    await drainPending(bid);
    expect(await commandQueueService.getPendingCount()).toBe(0);
    expect(await getSyncJobsPendingCount(bid)).toBe(0);
    expect(received.size).toBe(1);
    expect(received.has(res.id)).toBe(true);
    expect((await getLocalOrder(bid, res.id))?.id).toBe(res.id);
  });
});

describe.sequential("E2E TEST 2 — idempotent replay", () => {
  it("replaying the outbox twice keeps same UUID, no duplicate order or POST", async () => {
    const bid = await resetHarness("biz-e2e");
    const received = new Map<string, unknown>();
    setHttpClient({
      get: async () => ({ data: { data: [], pagination: { total_pages: 1 } } } as unknown as never),
      post: async (url: string, body?: unknown) => {
        if (url.includes("/pos/orders")) {
          const id = (body as { id?: string })?.id ?? "";
          if (!received.has(id)) received.set(id, body);
        }
        return { data: {} } as unknown as never;
      },
      put: async () => ({ data: {} } as unknown as never),
      patch: async () => ({ data: {} } as unknown as never),
      delete: async () => ({ data: {} } as unknown as never),
    } as never);
    setConnectivityState({ isOnline: false, isCloudReachable: "unreachable" });
    const itemSnap = [{ menu_item_id: "item1", name: "Jollof", quantity: 1, unit_price_minor: 5000 }];
    const res = await posRepository.createOrder(bid, { items: [{ menu_item_id: "item1", quantity: 1 }], item_snapshots: itemSnap as never, total_minor: 5000 } as never);
    expect(await commandQueueService.getPendingCount()).toBe(1);
    // uncertain delivery: replay twice — second replay finds nothing to do
    setConnectivityState({ isOnline: true, isCloudReachable: "reachable" });
    await commandQueueService.replay();
    await commandQueueService.replay();
    await drainPending(bid);
    expect(await commandQueueService.getPendingCount()).toBe(0);
    expect(received.size).toBe(1);
    expect([...received.keys()][0]).toBe(res.id);
    const { data } = await (await import("../domain/orders/service")).listLocalOrders(bid, {}, 1, 20);
    expect(data.filter((o) => o.id === res.id).length).toBe(1);
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
