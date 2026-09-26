import { describe, it, expect, beforeEach, vi } from "vitest";

const h = vi.hoisted(() => {
  const calls: string[] = [];
  return {
    calls,
    syncMock: vi.fn(async () => { calls.push("reference"); }),
    drainMock: vi.fn(async () => { calls.push("drain"); }),
    pullMock: vi.fn(async () => { calls.push("pull"); }),
  };
});

vi.mock("../reference/service", () => ({ referenceSyncService: { sync: h.syncMock } }));
vi.mock("./sync-jobs.service", () => ({ drainPending: h.drainMock, pullRemoteOrders: h.pullMock }));
vi.mock("../adapters/connectivity", () => ({
  getConnectivityState: () => ({ isOnline: true, isCloudReachable: "reachable" }),
}));
vi.mock("../adapters/business", () => ({ getActiveBusiness: () => ({ id: "bid-full-sync" }) }));
vi.mock("./sync-guard", () => ({ canBusinessSync: () => true }));
vi.mock("../utils/sync-logger", () => ({
  syncLogger: {
    info: () => {},
    warn: () => {},
    debug: () => {},
    error: () => {},
    command: () => {},
    event: () => {},
  },
}));

import { performFullSync } from "./full-sync";

describe("performFullSync ordering", () => {
  beforeEach(() => {
    h.calls.length = 0;
    h.syncMock.mockClear().mockImplementation(async () => { h.calls.push("reference"); });
    h.drainMock.mockClear().mockImplementation(async () => { h.calls.push("drain"); });
    h.pullMock.mockClear().mockImplementation(async () => { h.calls.push("pull"); });
  });

  it("pulls reference first, then push → pull → push", async () => {
    await performFullSync("bid-full-sync");
    expect(h.calls).toEqual(["reference", "drain", "pull", "drain"]);
  });

  it("a reference failure does not block the order flush", async () => {
    h.syncMock.mockRejectedValueOnce(new Error("reference down"));
    await performFullSync("bid-full-sync");
    expect(h.calls).toEqual(["drain", "pull", "drain"]);
  });
});
