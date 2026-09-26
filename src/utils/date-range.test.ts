import { describe, it, expect } from "vitest";
import { resolveDateRange } from "./date-range";

function iso(d: Date): string {
  const y = d.getFullYear();
  const m = String(d.getMonth() + 1).padStart(2, "0");
  const day = String(d.getDate()).padStart(2, "0");
  return `${y}-${m}-${day}`;
}

describe("resolveDateRange", () => {
  it("returns nothing for all/undefined", () => {
    expect(resolveDateRange("all")).toEqual({});
    expect(resolveDateRange(undefined)).toEqual({});
  });

  it("today spans only today", () => {
    const today = iso(new Date());
    expect(resolveDateRange("today")).toEqual({ date_from: today, date_to: today });
  });

  it("last7 starts six days ago", () => {
    const end = new Date();
    const start = new Date();
    start.setDate(start.getDate() - 6);
    expect(resolveDateRange("last7")).toEqual({ date_from: iso(start), date_to: iso(end) });
  });

  it("custom passes through provided bounds only", () => {
    expect(resolveDateRange("custom", "2026-01-01", "2026-01-31")).toEqual({
      date_from: "2026-01-01",
      date_to: "2026-01-31",
    });
    expect(resolveDateRange("custom", "2026-01-01", "")).toEqual({ date_from: "2026-01-01" });
  });
});
