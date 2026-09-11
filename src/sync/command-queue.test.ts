/**
 * Outbox survival — network/service failures must NOT consume retries.
 * Regression: processCommand marked every failure "failed" (+1 retry_count),
 * so 5 flaky replays dead-lettered the command mid-outage. Now only
 * definitive 4xx rejections consume retries; transport failures return the
 * row to pending untouched (replay stops to preserve ordering; next trigger
 * retries from the same row).
 */
import { describe, it, expect } from "vitest";
import { setConnectivityState } from "../adapters/connectivity";
import { syncEngine } from "./engine";
import { commandQueueService } from "./command-queue.service";
import { buildCommand } from "./command-builder";
import { resetHarness } from "../e2e/harness";
import { openSyncDatabase } from "../db/connection";
import { getPendingCommands } from "../db/operations";

describe("outbox survives transport failures", () => {
  it("repeated network failures keep the row pending with retry_count 0", async () => {
    await resetHarness("biz-outbox");
    // Online, cloud "reachable": strategy=cloud → restTransport menu path →
    // menuService.createMenuItem is NOT injected in tests → plain Error
    // (transport failure, not a 4xx rejection).
    setConnectivityState({ isOnline: true, isCloudReachable: "reachable" });
    const command = buildCommand({
      commandType: "menu:create_item",
      businessId: "biz-outbox",
      entityId: "mi-1",
      payload: { name: "Jollof" },
    });
    await syncEngine.execute(command);
    const db = await openSyncDatabase();
    const rows = await getPendingCommands(db, 10);
    expect(rows.length).toBe(1);
    expect(rows[0].retry_count).toBe(0);
    // Three more replay triggers (e.g. connectivity flaps): still pending,
    // still retry_count 0 — never dead-letters on transport failure.
    const dbx = await openSyncDatabase();
    const { getPendingCommands: gpc } = await import("../db/operations");
    await commandQueueService.replay();
    await commandQueueService.replay();
    await commandQueueService.replay();
    const after = await gpc(dbx, 10);
    expect(after.length).toBe(1);
    expect(after[0].retry_count).toBe(0);
    expect(after[0].status).toBe("pending");
  });
});
