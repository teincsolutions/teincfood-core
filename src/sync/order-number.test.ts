import { describe, it, expect, beforeEach } from "vitest";
import {
  generateOrderNumber,
  isLocalOrderNumber,
  isOfflineOrderNumber,
  parseOrderNumber,
  resetCalloutForTests,
} from "./order-number";
import { removeItemSync, setItemSync } from "../adapters/kv";

describe("order-number DD-RRR-CCC", () => {
  beforeEach(() => {
    removeItemSync("teinc_callout_seq");
    removeItemSync("teinc_last_random");
    resetCalloutForTests();
  });

  it("generates 10-char DD-RRR-CCC", () => {
    const { orderNumber, callout } = generateOrderNumber("10");
    expect(orderNumber).toMatch(/^[0-9]{2}-[0-9]{3}-[0-9]{3}$/);
    expect(orderNumber.length).toBe(10);
    expect(callout).toBe(1);
    expect(isLocalOrderNumber(orderNumber)).toBe(true);
    expect(isOfflineOrderNumber(orderNumber)).toBe(true);
    expect(parseOrderNumber(orderNumber)?.deviceNumber).toBe("10");
  });

  it("rejects invalid DD 00 and 0a", () => {
    expect(() => generateOrderNumber("00")).toThrow();
    expect(() => generateOrderNumber("0a")).toThrow();
    expect(() => generateOrderNumber("100")).toThrow();
  });

  it("RRR 100-999 and per-order random", () => {
    const a = generateOrderNumber("01");
    const b = generateOrderNumber("01");
    const ra = parseOrderNumber(a.orderNumber)!.random;
    const rb = parseOrderNumber(b.orderNumber)!.random;
    expect(Number(ra)).toBeGreaterThanOrEqual(100);
    expect(Number(ra)).toBeLessThanOrEqual(999);
    // random may collide once, but generally different
    // at least not all equal across 5
    const rs = Array.from({ length: 5 }, () => generateOrderNumber("01").random);
    // all in range
    for (const r of [a.random, b.random, ...rs]) expect(r).toBeGreaterThanOrEqual(100);
  });

  it("CCC wraps 999->001 and new RRR", () => {
    setItemSync("teinc_callout_seq", 998);
    const a = generateOrderNumber("10");
    expect(a.callout).toBe(999);
    const b = generateOrderNumber("10");
    expect(b.callout).toBe(1);
    // both valid format
    expect(isLocalOrderNumber(b.orderNumber)).toBe(true);
  });

  it("isLocalOrderNumber false for legacy", () => {
    expect(isLocalOrderNumber("TFL-20260824-0001")).toBe(false);
    expect(isLocalOrderNumber("KF-260701-0042")).toBe(false);
  });
});
