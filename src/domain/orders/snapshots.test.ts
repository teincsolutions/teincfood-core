import { describe, it, expect } from "vitest";
import { buildItemSnapshots, snapshotsToOrderLines } from "./snapshots";

describe("buildItemSnapshots", () => {
  it("normalizes thin cart lines (desktop shape) to the canonical snapshot", () => {
    const [s] = buildItemSnapshots([
      { menu_item: { id: "item-1", name: "Jollof" }, quantity: 2, unit_price_minor: 5000 },
    ]);
    expect(s).toEqual({
      menu_item_id: "item-1",
      name: "Jollof",
      quantity: 2,
      unit_price_minor: 5000,
      addons: [],
    });
  });

  it("carries variant and addons from rich cart lines (mobile shape)", () => {
    const [s] = buildItemSnapshots([
      {
        menu_item: { id: "item-1", name: "Bowl" },
        quantity: 1,
        unit_price_minor: 7000,
        selected_variant: { id: "v-1", name: "Large" },
        selected_addons: [{ addon_id: "a-1", name: "Egg", price_minor: 200 }],
      },
    ]);
    expect(s.variant_id).toBe("v-1");
    expect(s.variant_name).toBe("Large");
    expect(s.addons).toEqual([{ name: "Egg", price_minor: 200 }]);
  });

  it("is idempotent over already-built snapshots", () => {
    const snapshot = {
      menu_item_id: "item-1",
      name: "Bowl",
      quantity: 1,
      unit_price_minor: 7000,
      variant_id: "v-1",
      variant_name: "Large",
      addons: [{ name: "Egg", price_minor: 200 }],
    };
    expect(buildItemSnapshots([snapshot])).toEqual([snapshot]);
  });

  it("derives unit price from subtotal when only subtotal is present", () => {
    const [s] = buildItemSnapshots([
      { menu_item: { id: "item-1", name: "Bowl" }, quantity: 2, subtotal: 10000 } as never,
    ]);
    expect(s.unit_price_minor).toBe(5000);
  });

  it("returns [] for missing input", () => {
    expect(buildItemSnapshots(null)).toEqual([]);
    expect(buildItemSnapshots(undefined)).toEqual([]);
  });
});

describe("snapshotsToOrderLines", () => {
  it("embeds names once so lines never need the menu cache", () => {
    const [line] = snapshotsToOrderLines(
      [
        {
          menu_item_id: "item-1",
          name: "Bowl",
          quantity: 1,
          unit_price_minor: 7000,
          variant_id: "v-1",
          variant_name: "Large",
          addons: [{ name: "Egg", price_minor: 200 }],
        },
      ],
      "cmd-1",
    );
    expect(line.menu_item).toEqual({ id: "item-1", name: "Bowl" });
    expect(line.variant_name).toBe("Large");
    expect(line.variant).toEqual({ id: "v-1", name: "Large" });
    expect(line.addons).toEqual([{ name: "Egg", price_minor: 200 }]);
    expect(line.unit_price).toBe(7000);
    expect(line.subtotal).toBe(7000);
  });
});
