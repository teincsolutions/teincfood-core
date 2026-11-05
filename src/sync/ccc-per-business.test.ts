import { describe, it, expect, beforeEach } from "vitest";
import { generateOrderNumberForBusiness, resetCalloutForTests, parseOrderNumber } from "./order-number";
import { setItemSync, removeItemSync } from "../adapters/kv";

describe("DD-NNNN-MMM per business", () => {
  beforeEach(() => {
    removeItemSync("teinc_callout_seq");
    removeItemSync("teinc_callout_seq:biz-A");
    removeItemSync("teinc_callout_seq:biz-B");
    removeItemSync("teinc_device_number:biz-A");
    removeItemSync("teinc_device_number:biz-B");
    resetCalloutForTests("biz-A");
    resetCalloutForTests("biz-B");
    resetCalloutForTests();
    setItemSync("teinc_device_number:biz-A", "07");
    setItemSync("teinc_device_number:biz-B", "08");
  });

  it("biz-A and biz-B have independent sequences", () => {
    const a1 = generateOrderNumberForBusiness("biz-A");
    const a2 = generateOrderNumberForBusiness("biz-A");
    const b1 = generateOrderNumberForBusiness("biz-B");
    expect(a1).toBe("07-0001-001");
    expect(a2).toBe("07-0001-002");
    expect(b1).toBe("08-0001-001");
    expect(parseOrderNumber(a1)!.callout).toBe("001");
    expect(parseOrderNumber(a2)!.callout).toBe("002");
    expect(parseOrderNumber(b1)!.callout).toBe("001");
  });

  it("rolls over per business independently", () => {
    setItemSync("teinc_callout_seq:biz-A", 998);
    const a1 = generateOrderNumberForBusiness("biz-A");
    const a2 = generateOrderNumberForBusiness("biz-A");
    expect(a1).toBe("07-0001-999");
    expect(a2).toBe("07-0002-001");
    expect(parseOrderNumber(a1)!.callout).toBe("999");
    expect(parseOrderNumber(a2)!.callout).toBe("001");
    expect(parseOrderNumber(a2)!.block).toBe("0002");
    const b1 = generateOrderNumberForBusiness("biz-B");
    expect(b1).toBe("08-0001-001");
  });
});
