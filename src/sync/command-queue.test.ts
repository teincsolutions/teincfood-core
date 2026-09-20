import { describe, it, expect, beforeEach } from "vitest";
import { createMemoryDriver } from "../test-helpers/memory-driver";
import { setSqliteDriver } from "../adapters/sqlite";
import { openSyncDatabase, closeSyncDatabase } from "../db/connection";
import { setReferenceData } from "../reference/operations";
import { getPendingCommands } from "../db/operations";
import { setItemSync } from "../adapters/kv";
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

async function seedState(opts: { manuallyClosed?: boolean; hours?: unknown[] } = {}) {
  const db = await openSyncDatabase();
  const allDay = [0, 1, 2, 3, 4, 5, 6].map((day_of_week) => ({
    day_of_week,
    open_time: "00:00:00",
    close_time: "23:59:59",
    is_closed: false,
  }));
  await setReferenceData(db, BID, {
    key: "operating-hours",
    version: "v1",
    payload: { data: opts.hours ?? allDay },
    downloadedAt: new Date().toISOString(),
  });
  await setReferenceData(db, BID, {
    key: "business:profile",
    version: "v1",
    payload: { data: { manually_closed: opts.manuallyClosed ?? false } },
    downloadedAt: new Date().toISOString(),
  });
}

async function seedClosed() {
  return seedState({ manuallyClosed: true });
}

describe("command-queue enqueue hours gate", () => {
  beforeEach(async () => {
    setSqliteDriver(createMemoryDriver());
    try {
      await closeSyncDatabase();
    } catch {}
    await openSyncDatabase();
  });

  it("rejects order:create while outside operating hours and persists nothing", async () => {
    // Hours that never match: closed all day today.
    const today = (new Date().getUTCDay() + 6) % 7;
    await seedState({
      hours: [{ day_of_week: today, open_time: "00:00:00", close_time: "00:00:01", is_closed: true }],
    });
    await expect(commandQueueService.enqueue(orderCommand())).rejects.toMatchObject({
      code: "BUSINESS_CLOSED",
    });
    const db = await openSyncDatabase();
    expect(await getPendingCommands(db, 100)).toHaveLength(0);
  });

  it("rejects order:create with HOURS_NOT_SYNCED when no hours cached", async () => {
    await seedState({ hours: [] });
    await expect(commandQueueService.enqueue(orderCommand())).rejects.toMatchObject({
      code: "HOURS_NOT_SYNCED",
    });
  });

  it("allows POS order:create during temporary online shutdown (manual close)", async () => {
    // manually_closed stops online ordering only — queued order:create
    // commands are always POS and must still be accepted.
    await seedClosed();
    setItemSync(`teinc_device_number:${BID}`, "07");
    const event = await commandQueueService.enqueue(orderCommand());
    expect(event.event_type).toBeDefined();
    const db = await openSyncDatabase();
    expect(await getPendingCommands(db, 100)).toHaveLength(1);
  });

  it("still queues non-create commands (transitions) while closed", async () => {
    await seedClosed();
    const event = await commandQueueService.enqueue(transitionCommand());
    expect(event.event_type).toBeDefined();
    const db = await openSyncDatabase();
    expect(await getPendingCommands(db, 100)).toHaveLength(1);
  });
});
