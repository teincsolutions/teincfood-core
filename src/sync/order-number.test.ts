import { describe, it, expect, beforeEach } from "vitest";
import { generateLocalOrderNumber, generateLocalCalloutNumber, isLocalOrderNumber } from "./order-number";
import { removeItemSync } from "../adapters/kv";

// Use in-memory KV for tests (default driver is memory)
describe("order-number", () => {
  beforeEach(() => {
    removeItemSync("local_order_sequence");
    removeItemSync("local_callout_sequence");
  });

  it("generates TFL order numbers with date and sequence", () => {
    const d = new Date("2026-08-24T10:00:00.000Z");
    const a = generateLocalOrderNumber(d);
    const b = generateLocalOrderNumber(d);
    expect(a).toBe("TFL-20260824-0001");
    expect(b).toBe("TFL-20260824-0002");
    expect(isLocalOrderNumber(a)).toBe(true);
    expect(isLocalOrderNumber("KF-260701-0042")).toBe(false);
  });

  it("generates incremental callout numbers per day", () => {
    const d = new Date("2026-08-24T10:00:00.000Z");
    expect(generateLocalCalloutNumber(d)).toBe(1);
    expect(generateLocalCalloutNumber(d)).toBe(2);
  });

  it("isolates sequences per day", () => {
    const d1 = new Date("2026-08-24T10:00:00.000Z");
    const d2 = new Date("2026-08-25T10:00:00.000Z");
    expect(generateLocalOrderNumber(d1)).toBe("TFL-20260824-0001");
    expect(generateLocalOrderNumber(d2)).toBe("TFL-20260825-0001");
  });
});
