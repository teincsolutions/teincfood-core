import { describe, it, expect, beforeEach } from "vitest";
import {
  generateOrderNumber,
  isLocalOrderNumber,
  isOfflineOrderNumber,
  parseOrderNumber,
  resetCalloutForTests,
} from "./order-number";
import { removeItemSync, setItemSync } from "../adapters/kv";

describe("order-number DD-NNNN-MMM", () => {
  beforeEach(() => {
    removeItemSync("teinc_callout_seq");
    resetCalloutForTests();
  });

  it("generates 11-char DD-NNNN-MMM starting at 0001-001", () => {
    const { orderNumber, callout, block } = generateOrderNumber("10");
    expect(orderNumber).toMatch(/^[0-9]{2}-[0-9]{4}-[0-9]{3}$/);
    expect(orderNumber.length).toBe(11);
    expect(block).toBe(1);
    expect(callout).toBe(1);
    expect(orderNumber).toBe("10-0001-001");
    expect(isLocalOrderNumber(orderNumber)).toBe(true);
    expect(isOfflineOrderNumber(orderNumber)).toBe(true);
    expect(parseOrderNumber(orderNumber)?.deviceNumber).toBe("10");
    expect(parseOrderNumber(orderNumber)?.block).toBe("0001");
  });

  it("rejects invalid DD 00 and 0a", () => {
    expect(() => generateOrderNumber("00")).toThrow();
    expect(() => generateOrderNumber("0a")).toThrow();
    expect(() => generateOrderNumber("100")).toThrow();
  });

  it("increments the callout sequentially without randomness", () => {
    const a = generateOrderNumber("01");
    const b = generateOrderNumber("01");
    const c = generateOrderNumber("01");
    expect(a.orderNumber).toBe("01-0001-001");
    expect(b.orderNumber).toBe("01-0001-002");
    expect(c.orderNumber).toBe("01-0001-003");
    expect(a.callout).toBe(1);
    expect(b.callout).toBe(2);
  });

  it("rolls 999 -> next block 0002-001", () => {
    setItemSync("teinc_callout_seq", 998);
    const a = generateOrderNumber("10");
    expect(a.orderNumber).toBe("10-0001-999");
    expect(a.callout).toBe(999);
    const b = generateOrderNumber("10");
    expect(b.orderNumber).toBe("10-0002-001");
    expect(b.callout).toBe(1);
    expect(b.block).toBe(2);
    expect(isLocalOrderNumber(b.orderNumber)).toBe(true);
  });

  it("still parses legacy DD-RRR-CCC rows", () => {
    expect(isLocalOrderNumber("07-014-042")).toBe(true);
    expect(parseOrderNumber("07-014-042")).toEqual({
      deviceNumber: "07",
      block: "0014",
      callout: "042",
    });
  });

  it("isLocalOrderNumber false for non-device numbers", () => {
    expect(isLocalOrderNumber("TFL-20260824-0001")).toBe(false);
    expect(isLocalOrderNumber("KF-260701-0042")).toBe(false);
  });
});
