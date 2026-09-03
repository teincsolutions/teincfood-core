import { describe, it, expect } from "vitest";
import { lwwMerge, toLWWMap, fromLWWMap } from "./lww";

describe("LWW merge", () => {
  it("divergent fields both merge", () => {
    const a = toLWWMap({ price: 500 }, "1000-000000-01", "01");
    const b = toLWWMap({ name: "Spicy" }, "1001-000000-02", "02");
    const merged = lwwMerge(lwwMerge(null, a), b);
    expect(fromLWWMap(merged)).toEqual({ price: 500, name: "Spicy" });
  });
  it("same field last HLC wins", () => {
    const a = toLWWMap({ price: 500 }, "1000-000000-01", "01");
    const b = toLWWMap({ price: 600 }, "1001-000000-02", "02");
    const merged = lwwMerge(a, b);
    expect((merged.price as any).value).toBe(600);
    const merged2 = lwwMerge(b, a);
    expect((merged2.price as any).value).toBe(600);
  });
  it("idempotent", () => {
    const a = toLWWMap({ x: 1 }, "1000-000000-01", "01");
    const m1 = lwwMerge(a, a);
    expect(m1).toEqual(a);
  });
});
