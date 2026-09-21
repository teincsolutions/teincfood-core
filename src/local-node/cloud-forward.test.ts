import { describe, it, expect, beforeEach, vi } from "vitest";

const { executeMock } = vi.hoisted(() => ({ executeMock: vi.fn() }));

vi.mock("../sync/transport-rest", () => ({
  restTransport: { execute: executeMock, isAvailable: () => true },
}));

import { createMemoryDriver } from "../test-helpers/memory-driver";
import { setSqliteDriver } from "../adapters/sqlite";
import { openSyncDatabase, closeSyncDatabase } from "../db/connection";
import { getPendingCommands } from "../db/operations";
import {
  getConnectivityState,
  setConnectivityState,
} from "../adapters/connectivity";
import { localNodeService, initLocalNodeService } from "./service";
import type { Command } from "../sync/types";

const BID = "biz-forward-test";

function initService() {
  initLocalNodeService({
    getDeviceId: () => "device-forward-1",
    getDeviceName: () => "Forward 1",
    getBusiness: () => ({ id: BID }) as never,
    getAuth: () => ({ user: { id: "u1" }, accessToken: "tok" }),
    discovery: {} as never,
    transport: {} as never,
  } as never);
}

function inviteCommand(): Command {
  return {
    command_id: `cmd-${Math.random().toString(36).slice(2)}`,
    command_type: "member:invite",
    command_version: "1.0",
    business_id: BID,
    user_id: "u1",
    device_id: "d1",
    timestamp: new Date().toISOString(),
    payload: {},
  };
}

describe("local-node cloud forward reachability", () => {
  beforeEach(async () => {
    executeMock.mockReset();
    setSqliteDriver(createMemoryDriver() as never);
    try {
      await closeSyncDatabase();
    } catch {}
    await openSyncDatabase();
    setConnectivityState({ isCloudReachable: "unknown" });
    initService();
  });

  it("rethrows 4xx rejections without marking cloud unreachable or queueing", async () => {
    executeMock.mockRejectedValue({ status: 422, code: "VALIDATION" });
    await expect(localNodeService.handleNodeCommand(inviteCommand())).rejects.toMatchObject({
      status: 422,
    });
    expect(getConnectivityState().isCloudReachable).not.toBe("unreachable");
    const db = await openSyncDatabase();
    expect(await getPendingCommands(db, 100)).toHaveLength(0);
  });

  it("queues on network failure WITHOUT writing the reachability flag (probe owns it)", async () => {
    executeMock.mockRejectedValue(new Error("socket hang up"));
    await localNodeService.handleNodeCommand(inviteCommand());
    expect(getConnectivityState().isCloudReachable).toBe("unknown");
    const db = await openSyncDatabase();
    expect(await getPendingCommands(db, 100)).toHaveLength(1);
  });
});
