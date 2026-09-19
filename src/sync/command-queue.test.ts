import { describe, it, expect, beforeEach } from "vitest";
import { createMemoryDriver } from "../test-helpers/memory-driver";
import { setSqliteDriver } from "../adapters/sqlite";
import { openSyncDatabase, closeSyncDatabase } from "../db/connection";
import { setReferenceData } from "../reference/operations";
import { getPendingCommands } from "../db/operations";
import { commandQueueService } from "./command-queue.service";
import type { Command } from "./types";

const BID = "biz-queue-gate-test";

function orderCommand(): Command {
  return {
    command_id: `cmd-${Math.random().toString(36).slice(2)}`,
    command_type: "order:create",
    command_version: "1.0",
    business_id: BID,
    user_id: "u1",
    device_id: "d1",
    timestamp: new Date().toISOString(),
    payload: { items: [] },
  };
}

function transitionCommand(): Command {
  return { ...orderCommand(), command_id: `cmd-${Math.random().toString(36).slice(2)}`, command_type: "order:cancel" };
}

async function seedClosed() {
  const db = await openSyncDatabase();
  await setReferenceData(db, BID, {
    key: "operating-hours",
    version: "v1",
    payload: { data: [{ day_of_week: 0, open_time: "09:00:00", close_time: "21:00:00", is_closed: false }] },
    downloadedAt: new Date().toISOString(),
  });
  await setReferenceData(db, BID, {
    key: "business:profile",
    version: "v1",
    payload: { data: { manually_closed: true } },
    downloadedAt: new Date().toISOString(),
  });
}

describe("command-queue enqueue hours gate", () => {
  beforeEach(async () => {
    setSqliteDriver(createMemoryDriver());
    try {
      await closeSyncDatabase();
    } catch {}
    await openSyncDatabase();
  });

  it("rejects order:create while closed and persists nothing", async () => {
    await seedClosed();
    await expect(commandQueueService.enqueue(orderCommand())).rejects.toMatchObject({
      code: "BUSINESS_CLOSED",
    });
    const db = await openSyncDatabase();
    expect(await getPendingCommands(db, 100)).toHaveLength(0);
  });

  it("still queues non-create commands (transitions) while closed", async () => {
    await seedClosed();
    const event = await commandQueueService.enqueue(transitionCommand());
    expect(event.event_type).toBeDefined();
    const db = await openSyncDatabase();
    expect(await getPendingCommands(db, 100)).toHaveLength(1);
  });
});
