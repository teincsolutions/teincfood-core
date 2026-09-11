import { describe, it, expect, beforeEach } from "vitest";
import { createMemoryDriver } from "../test-helpers/memory-driver";
import { setSqliteDriver } from "../adapters/sqlite";
import { openSyncDatabase, closeSyncDatabase } from "../db/connection";
import { setReferenceData, getReferenceData } from "./operations";
import { applyMenuCommandLocal } from "./menu-apply";

const BID = "biz-menu-test";

async function seedMenu() {
  const db = await openSyncDatabase();
  await setReferenceData(db, BID, {
    key: "menu:items",
    version: "v1",
    payload: { data: [{ id: "m1", name: "Jollof", available: true }] },
    downloadedAt: new Date().toISOString(),
  });
  await setReferenceData(db, BID, {
    key: "menu:categories",
    version: "v1",
    payload: { data: [{ id: "c1", name: "Mains" }] },
    downloadedAt: new Date().toISOString(),
  });
}

async function items(): Promise<Array<{ id: string; name?: string; available?: boolean }>> {
  const db = await openSyncDatabase();
  const rec = await getReferenceData<{ data: Array<{ id: string; name?: string; available?: boolean }> }>(db, BID, "menu:items");
  return (rec?.payload as { data?: Array<{ id: string }> })?.data ?? [];
}

async function categories(): Promise<Array<{ id: string; name?: string }>> {
  const db = await openSyncDatabase();
  const rec = await getReferenceData<{ data: Array<{ id: string }> }>(db, BID, "menu:categories");
  return (rec?.payload as { data?: Array<{ id: string }> })?.data ?? [];
}

const cmd = (command_type: string, payload: Record<string, unknown>, entity_id?: string) => ({
  command_type,
  entity_id,
  command_id: `cmd-${Math.random().toString(36).slice(2, 8)}`,
  payload,
});

describe("menu-apply — offline/LAN cache convergence", () => {
  beforeEach(async () => {
    setSqliteDriver(createMemoryDriver() as never);
    try { await closeSyncDatabase(); } catch {}
    await seedMenu();
  });

  it("create item upserts by id; re-apply converges (idempotent)", async () => {
    const c = cmd("menu:create_item", { id: "m2", name: "Banku", available: true }, "m2");
    const r1 = await applyMenuCommandLocal(BID, c);
    expect(r1.applied).toBe(true);
    expect(r1.keys).toEqual(["menu:items"]);
    expect((await items()).map((i) => i.id).sort()).toEqual(["m1", "m2"]);
    const r2 = await applyMenuCommandLocal(BID, c);
    expect(r2.applied).toBe(true);
    expect((await items()).length).toBe(2);
  });

  it("update item merges patch (availability toggle)", async () => {
    await applyMenuCommandLocal(BID, cmd("menu:update_item", { id: "m1", available: false }, "m1"));
    const found = (await items()).find((i) => i.id === "m1");
    expect(found?.available).toBe(false);
    expect(found?.name).toBe("Jollof");
  });

  it("delete item removes by id", async () => {
    await applyMenuCommandLocal(BID, cmd("menu:delete_item", { id: "m1" }, "m1"));
    expect(await items()).toEqual([]);
  });

  it("category create/update/delete converge", async () => {
    await applyMenuCommandLocal(BID, cmd("menu:create_category", { id: "c2", name: "Drinks" }, "c2"));
    expect((await categories()).map((c) => c.id).sort()).toEqual(["c1", "c2"]);
    await applyMenuCommandLocal(BID, cmd("menu:update_category", { id: "c2", name: "Beverages" }, "c2"));
    expect((await categories()).find((c) => c.id === "c2")?.name).toBe("Beverages");
    await applyMenuCommandLocal(BID, cmd("menu:delete_category", { id: "c1" }, "c1"));
    expect((await categories()).map((c) => c.id)).toEqual(["c2"]);
  });

  it("missing cache is a no-op (peer syncs via refetch instead)", async () => {
    const db = await openSyncDatabase();
    const { deleteReferenceData } = await import("./operations");
    await deleteReferenceData(db, BID, "menu:items");
    const r = await applyMenuCommandLocal(BID, cmd("menu:create_item", { id: "mx", name: "X" }, "mx"));
    expect(r.applied).toBe(false);
  });

  it("unknown command type is ignored", async () => {
    const r = await applyMenuCommandLocal(BID, cmd("order:create", {}, "o1"));
    expect(r.keys).toEqual([]);
  });
});
