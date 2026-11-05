import { describe, it, expect } from "vitest";
import { setKVDriver } from "../adapters/kv";
import { generateOrderNumber, parseOrderNumber } from "./order-number";

/**
 * Regression: desktop KV driver is async (Tauri store), so core sync readers
 * must use the driver's sync layer. Previously getItemSync fell back to the
 * ephemeral memory map and the callout restarted at 001 on every launch
 * (device 34 orders all showed *-001 while RRR kept changing).
 */
describe("order-number callout persistence (async driver + sync layer)", () => {
  const backing = new Map<string, string>();
  setKVDriver({
    getItem: (k: string) => Promise.resolve(backing.get(k) ?? null),
    setItem: (k: string, v: string) => {
      backing.set(k, v);
      return Promise.resolve();
    },
    removeItem: (k: string) => {
      backing.delete(k);
      return Promise.resolve();
    },
    getItemSync: (k: string) => backing.get(k) ?? null,
    setItemSync: (k: string, v: string) => {
      backing.set(k, v);
    },
    removeItemSync: (k: string) => {
      backing.delete(k);
    },
  });

  it("resumes the persisted sequence instead of restarting at 001", () => {
    // Simulate a previous session that reached 41 (persisted, memory empty).
    backing.set("teinc_callout_seq:biz-restart", JSON.stringify(41));
    const a = generateOrderNumber("34", "biz-restart");
    expect(a.callout).toBe(42);
    expect(a.block).toBe(1);
    expect(parseOrderNumber(a.orderNumber)?.callout).toBe("042");
    const b = generateOrderNumber("34", "biz-restart");
    expect(b.callout).toBe(43);
  });

  it("rolls 999 into block 0002 and persists through the driver", () => {
    backing.set("teinc_callout_seq:biz-wrap", JSON.stringify(999));
    const a = generateOrderNumber("34", "biz-wrap");
    expect(a.orderNumber).toBe("34-0002-001");
    expect(a.callout).toBe(1);
    expect(a.block).toBe(2);
    expect(backing.get("teinc_callout_seq:biz-wrap")).toBe("1000");
    const b = generateOrderNumber("34", "biz-wrap");
    expect(b.callout).toBe(2);
    expect(b.block).toBe(2);
  });

  it("starts at 0001-001 for a brand-new business", () => {
    const a = generateOrderNumber("34", "biz-fresh");
    expect(a.callout).toBe(1);
    expect(a.orderNumber).toBe("34-0001-001");
  });
});
