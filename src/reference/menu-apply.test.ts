import { describe, it, expect, beforeEach } from "vitest";
import { createMemoryDriver } from "../test-helpers/memory-driver";
import { setSqliteDriver } from "../adapters/sqlite";
import { openSyncDatabase, closeSyncDatabase } from "../db/connection";
import { setReferenceData, getReferenceData } from "./operations";
import { applyMenuCommandLocal } from "./menu-apply";
import { buildMenuItemRecord, buildMenuCategoryRecord } from "./menu-record";

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

  it("create item caches the caller-built record verbatim; re-apply converges", async () => {
    const record = buildMenuItemRecord({ businessId: BID, name: "Banku", priceMinor: 1500, categoryId: "c1", categoryName: "Mains", available: true });
    const c = cmd("menu:create_item", { id: record.id, name: "Banku", price_minor: 1500, cacheRecord: record }, record.id);
    const r1 = await applyMenuCommandLocal(BID, c);
    expect(r1.applied).toBe(true);
    expect(r1.keys).toEqual(["menu:items"]);
    expect((await items()).map((i) => i.id).sort()).toEqual(["m1", record.id].sort());
    const cached = (await items()).find((i) => i.id === record.id) as unknown as Record<string, unknown>;
    expect(cached.basePrice).toEqual({ amountMinor: 1500, currencyCode: "GHS" });
    expect(cached.price_minor).toBeUndefined();
    const r2 = await applyMenuCommandLocal(BID, c);
    expect(r2.applied).toBe(true);
    expect((await items()).length).toBe(2);
  });

  it("create without cacheRecord writes nothing (no wire payload in cache)", async () => {
    const r = await applyMenuCommandLocal(BID, cmd("menu:create_item", { id: "m9", name: "Raw", price_minor: 500 }, "m9"));
    expect(r.applied).toBe(false);
    expect((await items()).find((i) => i.id === "m9")).toBeUndefined();
  });

  it("update item replaces with caller-built record", async () => {
    const record = buildMenuItemRecord({ id: "m1", businessId: BID, name: "Jollof", priceMinor: 2000, categoryId: "c1", categoryName: "Mains", available: false });
    await applyMenuCommandLocal(BID, cmd("menu:update_item", { id: "m1", available: false, cacheRecord: record }, "m1"));
    const found = (await items()).find((i) => i.id === "m1") as unknown as Record<string, unknown>;
    expect(found?.is_available).toBe(false);
    expect(found?.basePrice).toEqual({ amountMinor: 2000, currencyCode: "GHS" });
    expect(found?.name).toBe("Jollof");
  });

  it("delete item removes by id", async () => {
    await applyMenuCommandLocal(BID, cmd("menu:delete_item", { id: "m1" }, "m1"));
    expect(await items()).toEqual([]);
  });

  it("category create/update converge on caller-built records", async () => {
    const c2 = buildMenuCategoryRecord({ name: "Drinks" });
    await applyMenuCommandLocal(BID, cmd("menu:create_category", { id: c2.id, name: "Drinks", cacheRecord: c2 }, c2.id));
    expect((await categories()).map((c) => c.id).sort()).toEqual(["c1", c2.id].sort());
    const c2b = buildMenuCategoryRecord({ id: c2.id, name: "Beverages" });
    await applyMenuCommandLocal(BID, cmd("menu:update_category", { id: c2.id, name: "Beverages", cacheRecord: c2b }, c2.id));
    expect((await categories()).find((c) => c.id === c2.id)?.name).toBe("Beverages");
    await applyMenuCommandLocal(BID, cmd("menu:delete_category", { id: "c1" }, "c1"));
    expect((await categories()).map((c) => c.id)).toEqual([c2.id]);
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

  it("create with flat CatalogItemRequest payload normalizes to serializer shape", async () => {
    const record = buildMenuItemRecord({ businessId: BID, name: "Waakye", priceMinor: 2500, categoryId: "c1", categoryName: "Mains", available: true, dietaryTags: ["vegan"] });
    await applyMenuCommandLocal(
      BID,
      cmd("menu:create_item", { id: record.id, name: "Waakye", price_minor: 2500, currency_code: "GHS", cacheRecord: record }, record.id),
    );
    const m3 = (await items()).find((i) => i.id === record.id) as unknown as Record<string, unknown>;
    expect(m3.basePrice).toEqual({ amountMinor: 2500, currencyCode: "GHS" });
    expect(m3.is_available).toBe(true);
    expect(m3.dietary_tags).toEqual(["vegan"]);
  });

  it("update replaces the cached record without clobbering untouched fields", async () => {
    const created = buildMenuItemRecord({ businessId: BID, name: "Kenkey", priceMinor: 1000, categoryId: "c1", variants: [{ name: "Big", price: 1500 }] });
    await applyMenuCommandLocal(BID, cmd("menu:create_item", { id: created.id, cacheRecord: created }, created.id));
    const updated = buildMenuItemRecord({ id: created.id, businessId: BID, name: "Kenkey Special", priceMinor: 1500, categoryId: "c1", variants: [{ name: "Big", price: 1500 }] });
    await applyMenuCommandLocal(BID, cmd("menu:update_item", { id: created.id, name: "Kenkey Special", price_minor: 1500, cacheRecord: updated }, created.id));
    const m4 = (await items()).find((i) => i.id === created.id) as unknown as Record<string, unknown>;
    expect(m4.basePrice).toEqual({ amountMinor: 1500, currencyCode: "GHS" });
    expect((m4.variants as Array<Record<string, unknown>>).length).toBe(1);
  });
});