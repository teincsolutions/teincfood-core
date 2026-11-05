import { describe, it, expect, beforeEach } from "vitest";
import { createMemoryDriver } from "../../test-helpers/memory-driver";
import { setSqliteDriver } from "../../adapters/sqlite";
import { openSyncDatabase, closeSyncDatabase } from "../../db/connection";
import { mergeReferenceData } from "../../reference/operations";
import {
  DEFAULT_ORDER_FLOW_MODE,
  getBusinessOrderFlowMode,
  initialPosOrderStatus,
  isDirectOrderFlow,
  normalizeOrderFlowMode,
  orderFlowModeFromProfile,
} from "./order-flow";

const BID = "biz-order-flow";

describe("order flow mode", () => {
  beforeEach(async () => {
    setSqliteDriver(createMemoryDriver() as never);
    try { await closeSyncDatabase(); } catch {}
    await openSyncDatabase();
  });

  it("defaults to the staged pipeline for unknown values", () => {
    expect(DEFAULT_ORDER_FLOW_MODE).toBe("staged");
    expect(normalizeOrderFlowMode("direct")).toBe("direct");
    expect(normalizeOrderFlowMode("staged")).toBe("staged");
    expect(normalizeOrderFlowMode(undefined)).toBe("staged");
    expect(normalizeOrderFlowMode("nonsense")).toBe("staged");
    expect(isDirectOrderFlow("direct")).toBe(true);
    expect(isDirectOrderFlow(null)).toBe(false);
  });

  it("reads the mode from either profile shape", () => {
    expect(orderFlowModeFromProfile({ data: { pos_order_flow: "direct" } })).toBe("direct");
    expect(orderFlowModeFromProfile({ pos_order_flow: "direct" })).toBe("direct");
    expect(orderFlowModeFromProfile({ data: { pos_order_flow: "staged" } })).toBe("staged");
    expect(orderFlowModeFromProfile(null)).toBe("staged");
  });

  it("reads the cached business profile (offline)", async () => {
    const db = await openSyncDatabase();
    expect(await getBusinessOrderFlowMode(BID, db)).toBe("staged");

    await mergeReferenceData(db, BID, "business:profile", { data: { pos_order_flow: "direct" } }, "hlc-1", "evt-hlc-1");
    expect(await getBusinessOrderFlowMode(BID, db)).toBe("direct");
  });

  it("born-completed only for cash walk-in sales in direct mode", () => {
    expect(initialPosOrderStatus("cash", "staged")).toBe("accepted");
    expect(initialPosOrderStatus("cash", "direct")).toBe("delivered");
    // Delivery orders always enter the rider pipeline, even in direct mode.
    expect(initialPosOrderStatus("cash", "direct", "delivery")).toBe("accepted");
    expect(initialPosOrderStatus("cash", "staged", "delivery")).toBe("accepted");
    // Money must land before the order can complete.
    expect(initialPosOrderStatus("mobile_money", "direct")).toBe("awaiting_payment");
    expect(initialPosOrderStatus("mobile_money", "direct", "delivery")).toBe("awaiting_payment");
    expect(initialPosOrderStatus("card", "staged")).toBe("awaiting_payment");
    expect(initialPosOrderStatus(undefined, "direct")).toBe("delivered");
    expect(initialPosOrderStatus(undefined, "direct", "delivery")).toBe("accepted");
  });
});
