/**
 * Standalone integration tests for 0.7.0
 * Covers: menu, categories, taxes, operating-hours, business:profile, orders
 * Modes: single node, multi-node (LAN), backend sync
 * No network, no fallback, pure memory driver.
 */
import { describe, it, expect, beforeEach } from "vitest";
import { createMemoryDriver } from "./test-helpers/memory-driver";
import { setSqliteDriver } from "./adapters/sqlite";
import { openSyncDatabase, closeSyncDatabase } from "./db/connection";
import { setReferenceData, getReferenceData, mergeReferenceData, getReferenceVersion } from "./reference/operations";
import type { ReferenceDataKey } from "./reference/types";
import { generateOrderNumber, resetCalloutForTests } from "./sync/order-number";
import { setItemSync, removeItemSync } from "./adapters/kv";
import { insertEvent, getUnsyncedEvents, markEventsSynced, upsertEntitySnapshot, getEntitySnapshot, getEntitySnapshotsByType } from "./db/operations";
import { generateEventId } from "./utils/uuid";
import { tickHLC, hlcToString, compareHLCString } from "./utils/hlc";

// helper to build reference payloads per key
function payloadForKey(key: ReferenceDataKey, suffix = ""): Record<string, unknown> {
  switch (key) {
    case "menu:items":
      return { data: [{ id: "item1", name: `Jollof${suffix}`, price: 5000 }] } as any;
    case "menu:categories":
      return { data: [{ id: "cat1", name: `Rice${suffix}` }] } as any;
    case "tax-rules":
      return { data: [{ id: "tax1", rate_basis_points: 500 }] } as any;
    case "operating-hours":
      return { data: [{ day_of_week: 1, open_time: "08:00", is_closed: false }] } as any;
    case "business:profile":
      return { data: { name: `Biz${suffix}`, business_number: "AB12C" } } as any;
    case "roles":
      return { data: [{ name: "owner" }] } as any;
    case "members":
      return { data: [{ user_id: "u1", role: "owner" }] } as any;
    case "capabilities":
      return { data: { capabilities: ["pos:create_order", "menu:manage"] } } as any;
    default:
      return { data: {} } as any;
  }
}

const ALL_KEYS: ReferenceDataKey[] = [
  "menu:items",
  "menu:categories",
  "tax-rules",
  "operating-hours",
  "business:profile",
  "roles",
  "members",
  "capabilities",
];

describe("standalone integration — single node", () => {
  beforeEach(async () => {
    const driver = createMemoryDriver();
    setSqliteDriver(driver);
    // ensure fresh connection resets initPromise
    // @ts-ignore
    // close and reopen to run migrations
    try { await closeSyncDatabase(); } catch {}
    removeItemSync("teinc_callout_seq");
    resetCalloutForTests();
  });

  it("single node can store and retrieve all reference keys", async () => {
    const db = await openSyncDatabase();
    const biz = "biz-single";
    for (const key of ALL_KEYS) {
      const payload = payloadForKey(key, "-v1");
      const hlc = hlcToString(tickHLC(Date.now(), null, "01"));
      await setReferenceData(db, biz, { key, version: hlc, payload, downloadedAt: new Date().toISOString(), lastHlc: hlc, lastEventId: generateEventId() });
    }
    for (const key of ALL_KEYS) {
      const rec = await getReferenceData(db, biz, key);
      expect(rec).not.toBeNull();
      expect(rec!.key).toBe(key);
    }
    // verify getReferenceVersion works for HLC
    const v = await getReferenceVersion(db, biz, "menu:items");
    expect(v).toMatch(/^[0-9]+-[0-9]+-01$/);
  });

  it("single device order DD-RRR-CCC generation and offline storage", async () => {
    setItemSync("teinc_device_number:biz-single", "07");
    const { orderNumber, callout } = generateOrderNumber("07");
    expect(orderNumber).toMatch(/^07-[0-9]{3}-[0-9]{3}$/);
    expect(callout).toBeGreaterThan(0);

    // persist as event (offline order)
    const db = await openSyncDatabase();
    const evt = {
      event_id: generateEventId(),
      event_type: "order.create_queued",
      event_version: "1.0",
      entity_id: "cmd-1",
      user_id: "u1",
      device_id: "dev-07",
      payload: { order_number: orderNumber, callout_number: callout },
      timestamp: new Date().toISOString(),
    };
    await insertEvent(db, { event: evt as any, origin: "local" });
    const unsynced = await getUnsyncedEvents(db, "local");
    expect(unsynced.length).toBe(1);
    expect((unsynced[0].payload as any).order_number).toBe(orderNumber);
  });

  it("callout wraps 999->001", async () => {
    setItemSync("teinc_callout_seq", 998);
    const a = generateOrderNumber("03");
    expect(a.callout).toBe(999);
    const b = generateOrderNumber("03");
    expect(b.callout).toBe(1);
    expect(b.orderNumber).not.toBe(a.orderNumber);
  });
});

describe("standalone integration — multi-node LAN", () => {
  beforeEach(async () => {
    const driver = createMemoryDriver();
    setSqliteDriver(driver);
    try { await closeSyncDatabase(); } catch {}
    removeItemSync("teinc_callout_seq");
    resetCalloutForTests();
  });

  it("two nodes editing same menu:items converge via HLC per-key", async () => {
    const db = await openSyncDatabase();
    const biz = "biz-multi";

    // Node A (device 01) writes price 500 at HLC wall 1000
    const hlcA = hlcToString(tickHLC(1000, null, "01"));
    await setReferenceData(db, biz, { key: "menu:items", version: hlcA, payload: payloadForKey("menu:items", "-A"), downloadedAt: new Date().toISOString(), lastHlc: hlcA, lastEventId: "evt_A" });

    // Node B (device 02) concurrently writes different payload at wall 1001 (later) — should win
    const hlcB = hlcToString(tickHLC(1001, null, "02"));
    await mergeReferenceData(db, biz, "menu:items", payloadForKey("menu:items", "-B") as any, hlcB, "evt_B");
    let rec = await getReferenceData(db, biz, "menu:items");
    expect((rec!.payload as any).data[0].name).toContain("-B");

    // Node A tries to replay older HLC (1000) — should be rejected (LWW)
    await mergeReferenceData(db, biz, "menu:items", payloadForKey("menu:items", "-A-old") as any, hlcA, "evt_A2");
    rec = await getReferenceData(db, biz, "menu:items");
    expect((rec!.payload as any).data[0].name).toContain("-B");
  });

  it("divergent fields via LWW-Map style: operating-hours + tax-rules both persist across nodes", async () => {
    const db = await openSyncDatabase();
    const biz = "biz-multi2";
    // Node A updates operating-hours, Node B updates tax-rules — no conflict, both keys coexist
    const hlcA = hlcToString(tickHLC(2000, null, "01"));
    const hlcB = hlcToString(tickHLC(2000, null, "02"));
    await setReferenceData(db, biz, { key: "operating-hours", version: hlcA, payload: payloadForKey("operating-hours"), downloadedAt: new Date().toISOString(), lastHlc: hlcA, lastEventId: "evt_oh" });
    await setReferenceData(db, biz, { key: "tax-rules", version: hlcB, payload: payloadForKey("tax-rules"), downloadedAt: new Date().toISOString(), lastHlc: hlcB, lastEventId: "evt_tax" });
    const oh = await getReferenceData(db, biz, "operating-hours");
    const tax = await getReferenceData(db, biz, "tax-rules");
    expect(oh).not.toBeNull();
    expect(tax).not.toBeNull();
  });

  it("orders: two LAN clients see each other's queued orders via events", async () => {
    const db = await openSyncDatabase();
    // Device 07 creates order
    setItemSync("teinc_device_number:biz-multi", "07");
    const o07 = generateOrderNumber("07");
    const evt07 = { event_id: generateEventId(), event_type: "order.create_queued", event_version: "1.0", entity_id: "cmd-07", user_id: "u07", device_id: "07", payload: { order_number: o07.orderNumber, callout_number: o07.callout }, timestamp: new Date().toISOString() };
    await insertEvent(db, { event: evt07 as any, origin: "local" });

    // Device 08 creates order (LAN peer) — inserted as lan origin on first device's DB (simulating broadcast)
    const o08 = generateOrderNumber("08");
    const evt08 = { event_id: generateEventId(), event_type: "order.create_queued", event_version: "1.0", entity_id: "cmd-08", user_id: "u08", device_id: "08", payload: { order_number: o08.orderNumber, callout_number: o08.callout }, timestamp: new Date().toISOString() };
    await insertEvent(db, { event: evt08 as any, origin: "lan" });

    const localUnsynced = await getUnsyncedEvents(db, "local");
    const lanUnsynced = await getUnsyncedEvents(db, "lan");
    expect(localUnsynced.length).toBe(1);
    expect(lanUnsynced.length).toBe(1);
    expect((localUnsynced[0].payload as any).order_number).toBe(o07.orderNumber);
    expect((lanUnsynced[0].payload as any).order_number).toBe(o08.orderNumber);

    // Also test entity_snapshots for order status via HLC
    const hlcStatus = hlcToString(tickHLC(Date.now(), null, "07"));
    await upsertEntitySnapshot(db, { entityType: "seller_orders", entityId: "list-main", businessId: "biz-multi", lastEventId: evt07.event_id, lastEventTimestamp: evt07.timestamp, payload: { data: [evt07.payload], savedAt: new Date().toISOString() } as any });
    const snap = await getEntitySnapshot(db, "seller_orders", "list-main");
    expect(snap).not.toBeNull();
    expect((snap!.payload as any).data[0].order_number).toBe(o07.orderNumber);

    // LAN peer updates same list with later timestamp — should win (LWW last_event_timestamp)
    const later = new Date(Date.now() + 1000).toISOString();
    await upsertEntitySnapshot(db, { entityType: "seller_orders", entityId: "list-main", businessId: "biz-multi", lastEventId: evt08.event_id, lastEventTimestamp: later, payload: { data: [evt07.payload, evt08.payload], savedAt: later } as any });
    const snap2 = await getEntitySnapshot(db, "seller_orders", "list-main");
    expect((snap2!.payload as any).data.length).toBe(2);
  });
});

describe("standalone integration — backend sync simulation", () => {
  beforeEach(async () => {
    const driver = createMemoryDriver();
    setSqliteDriver(driver);
    try { await closeSyncDatabase(); } catch {}
    removeItemSync("teinc_callout_seq");
    resetCalloutForTests();
  });

  it("backend adopt offline DD-RRR-CCC and mark synced (no re-number)", async () => {
    const db = await openSyncDatabase();
    setItemSync("teinc_device_number:biz-backend", "05");
    const { orderNumber } = generateOrderNumber("05");
    const evt = { event_id: generateEventId(), event_type: "order.create_queued", event_version: "1.0", entity_id: "cmd-05", user_id: "u05", device_id: "05", payload: { order_number: orderNumber, callout_number: parseInt(orderNumber.split("-")[2], 10) }, timestamp: new Date().toISOString() };
    await insertEvent(db, { event: evt as any, origin: "local" });

    // Simulate backend adopting same order_number (no change) and returning order.created with local_order_number echo
    const cloudEvt = { event_id: generateEventId(), event_type: "order.created", event_version: "1.0", entity_id: "cmd-05", user_id: "u05", device_id: "05", payload: { order_number: orderNumber, local_order_number: orderNumber, callout_number: parseInt(orderNumber.split("-")[2], 10) }, timestamp: new Date().toISOString() };
    // Mark local unsynced as synced after cloud ack
    let unsynced = await getUnsyncedEvents(db, "local");
    expect(unsynced.length).toBe(1);
    await markEventsSynced(db, [unsynced[0].event_id]);
    unsynced = await getUnsyncedEvents(db, "local");
    expect(unsynced.length).toBe(0);
    // Cloud event could be inserted as cloud origin
    await insertEvent(db, { event: cloudEvt as any, origin: "cloud", syncedToCloud: true } as any);
    const cloudUnsynced = await getUnsyncedEvents(db, "cloud" as any);
    expect(cloudUnsynced.length).toBe(0);
  });

  it("reference backend HLC bump: version grows monotonic", async () => {
    const db = await openSyncDatabase();
    const biz = "biz-backend";
    const h1 = hlcToString(tickHLC(3000, null, "backend"));
    await setReferenceData(db, biz, { key: "business:profile", version: h1, payload: payloadForKey("business:profile", "-v1"), downloadedAt: new Date().toISOString(), lastHlc: h1, lastEventId: "evt1" });
    const h2 = hlcToString(tickHLC(3001, { wallMs: 3000, counter: 0, deviceId: "backend" }, "backend"));
    await mergeReferenceData(db, biz, "business:profile", payloadForKey("business:profile", "-v2") as any, h2, "evt2");
    const rec = await getReferenceData(db, biz, "business:profile");
    expect(compareHLCString(rec!.lastHlc!, h1)).toBeGreaterThan(0);
    expect((rec!.payload as any).data.name).toContain("-v2");
  });

  it("categories + taxes sync independently via backend versions", async () => {
    const db = await openSyncDatabase();
    const biz = "biz-backend2";
    for (const key of ["menu:categories", "tax-rules", "operating-hours"] as ReferenceDataKey[]) {
      const hlc = hlcToString(tickHLC(Date.now(), null, "backend"));
      await setReferenceData(db, biz, { key, version: hlc, payload: payloadForKey(key), downloadedAt: new Date().toISOString(), lastHlc: hlc, lastEventId: generateEventId() });
    }
    for (const key of ["menu:categories", "tax-rules", "operating-hours"] as ReferenceDataKey[]) {
      const rec = await getReferenceData(db, biz, key);
      expect(rec).not.toBeNull();
    }
  });
});
