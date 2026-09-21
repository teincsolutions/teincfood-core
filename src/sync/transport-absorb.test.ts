import { describe, it, expect, beforeEach, vi } from "vitest";

const { transitionLocalOrderMock } = vi.hoisted(() => ({ transitionLocalOrderMock: vi.fn() }));
vi.mock("../domain/orders/service", () => ({
  createLocalOrder: vi.fn(),
  transitionLocalOrder: transitionLocalOrderMock,
}));

import { createMemoryDriver } from "../test-helpers/memory-driver";
import { setSqliteDriver } from "../adapters/sqlite";
import { openSyncDatabase, closeSyncDatabase } from "../db/connection";
import { insertOrder } from "../db/operations";
import { restTransport } from "./transport-rest";
import { TRANSITION_ERROR_CODES } from "./transition-errors";

const BID = "biz-absorb-test";
const ORDER_ID = "22222222-2222-4222-8222-222222222222";

function command() {
  return {
    command_id: `cmd-${Math.random().toString(36).slice(2)}`,
    command_type: "order:mark_ready",
    command_version: "1.0",
    business_id: BID,
    entity_id: ORDER_ID,
    user_id: "u1",
    device_id: "d1",
    timestamp: new Date().toISOString(),
    payload: {},
  };
}

describe("transport-rest already-applied absorb", () => {
  beforeEach(async () => {
    transitionLocalOrderMock.mockReset();
    setSqliteDriver(createMemoryDriver() as never);
    try { await closeSyncDatabase(); } catch {}
    await openSyncDatabase();
  });

  it("duplicate tap on an already-ready order succeeds without guards or network", async () => {
    const db = await openSyncDatabase();
    await insertOrder(db, {
      id: ORDER_ID,
      business_id: BID,
      order_number: "07-001-002",
      status: "ready",
    } as never);
    const events = await restTransport.execute(command() as never);
    expect(transitionLocalOrderMock).not.toHaveBeenCalled();
    expect(events).toHaveLength(1);
    expect((events[0].payload as Record<string, unknown>).status).toBe("ready");
  });

  it("genuinely invalid transition still throws INVALID_TRANSITION", async () => {
    const db = await openSyncDatabase();
    await insertOrder(db, {
      id: ORDER_ID,
      business_id: BID,
      order_number: "07-001-003",
      status: "accepted",
    } as never);
    transitionLocalOrderMock.mockRejectedValue(
      Object.assign(new Error("Cannot mark_ready from delivered"), { code: TRANSITION_ERROR_CODES.INVALID_TRANSITION }),
    );
    await expect(restTransport.execute(command() as never)).rejects.toMatchObject({
      code: TRANSITION_ERROR_CODES.INVALID_TRANSITION,
    });
    expect(transitionLocalOrderMock).toHaveBeenCalledTimes(1);
  });
});
