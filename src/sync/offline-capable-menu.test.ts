import { beforeEach, describe, expect, it, vi } from "vitest";
import { createMemoryDriver } from "../test-helpers/memory-driver";
import { setSqliteDriver } from "../adapters/sqlite";
import { closeSyncDatabase, openSyncDatabase } from "../db/connection";
import { setActiveBusiness } from "../adapters/business";
import { setConnectivityState } from "../adapters/connectivity";
import { getReferenceData } from "../reference/operations";
import { buildMenuItemEnvelope } from "../reference/menu-record";
import { commandQueueService } from "./command-queue.service";
import { runOfflineCapableMutation } from "./offline-capable";

const BID = "biz-menu-offline-test";

describe("offline-capable menu mutations", () => {
  beforeEach(async () => {
    setSqliteDriver(createMemoryDriver());
    try { await closeSyncDatabase(); } catch {}
    await openSyncDatabase();
    setActiveBusiness({ id: BID });
    setConnectivityState({ isOnline: false, isCloudReachable: "unreachable" });
  });

  it("returns immediately, applies the local cache, and queues the outbox row", async () => {
    const env = buildMenuItemEnvelope({
      businessId: BID,
      name: "Offline Jollof",
      priceMinor: 2500,
      categoryId: "cat-1",
    });

    const enqueueSpy = vi.spyOn(commandQueueService, "enqueue");
    const started = Date.now();
    await runOfflineCapableMutation({
      run: async () => {
        throw new Error("network must not be called while offline");
      },
      commandType: "menu:create_item",
      businessId: BID,
      entityId: env.cacheRecord.id,
      payload: { ...env.wire, cacheRecord: env.cacheRecord },
    });
    const elapsed = Date.now() - started;

    expect(elapsed).toBeLessThan(1_000);

    const db = await openSyncDatabase();
    const cached = await getReferenceData<{ data?: { id: string }[] }>(
      db,
      BID,
      "menu:items",
    );
    expect(cached?.payload?.data?.some((item) => item.id === env.cacheRecord.id)).toBe(true);

    expect(enqueueSpy).toHaveBeenCalledWith(
      expect.objectContaining({
        command_type: "menu:create_item",
        business_id: BID,
      }),
    );
  });
});
