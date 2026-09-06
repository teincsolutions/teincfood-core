import { describe, it, expect, beforeEach } from "vitest";
import { createMemoryDriver } from "../test-helpers/memory-driver";
import { setSqliteDriver } from "../adapters/sqlite";
import { openSyncDatabase, closeSyncDatabase } from "../db/connection";
import { setReferenceData } from "../reference/operations";
import {
  isBusinessOpenNow,
  assertBusinessOpenForCreate,
  BusinessHoursError,
} from "./business-hours";

const BID = "biz-hours-test";

function entry(day: number, open: string | null, close: string | null, closed = false) {
  return { day_of_week: day, open_time: open, close_time: close, is_closed: closed };
}

async function seedHours(entries: unknown[], profile?: unknown) {
  const db = await openSyncDatabase();
  await setReferenceData(db, BID, {
    key: "operating-hours",
    version: "v1",
    payload: { data: entries },
    downloadedAt: new Date().toISOString(),
  });
  if (profile !== undefined) {
    await setReferenceData(db, BID, {
      key: "business:profile",
      version: "v1",
      payload: { data: profile },
      downloadedAt: new Date().toISOString(),
    });
  }
}

describe("business-hours — backend is_open? parity", () => {
  beforeEach(async () => {
    setSqliteDriver(createMemoryDriver() as never);
    try { await closeSyncDatabase(); } catch {}
  });

  it("open inside hours (Mon 10:00 UTC, Mon 08:00-22:00)", async () => {
    await seedHours([entry(0, "08:00:00", "22:00:00")]);
    const s = await isBusinessOpenNow(BID, new Date("2026-09-07T10:00:00Z"));
    expect(s.open).toBe(true);
    expect(s.dayOfWeek).toBe(0);
  });

  it("open_time inclusive, close_time exclusive", async () => {
    await seedHours([entry(0, "08:00:00", "22:00:00")]);
    expect((await isBusinessOpenNow(BID, new Date("2026-09-07T08:00:00Z"))).open).toBe(true);
    const s = await isBusinessOpenNow(BID, new Date("2026-09-07T22:00:00Z"));
    expect(s.open).toBe(false);
    expect(s.reason).toBe("outside_hours");
  });

  it("Sunday maps to day 6", async () => {
    await seedHours([entry(6, "08:00:00", "22:00:00")]);
    const s = await isBusinessOpenNow(BID, new Date("2026-09-06T17:44:00Z"));
    expect(s.dayOfWeek).toBe(6);
    expect(s.open).toBe(true);
  });

  it("is_closed row never matches", async () => {
    await seedHours([entry(0, "08:00:00", "22:00:00", true)]);
    const s = await isBusinessOpenNow(BID, new Date("2026-09-07T10:00:00Z"));
    expect(s.open).toBe(false);
  });

  it("manually_closed profile blocks even inside hours", async () => {
    await seedHours([entry(0, "08:00:00", "22:00:00")], { manually_closed: true });
    const s = await isBusinessOpenNow(BID, new Date("2026-09-07T10:00:00Z"));
    expect(s.open).toBe(false);
    expect(s.reason).toBe("manually_closed");
  });

  it("no cached hours → no_hours_configured, assert throws HOURS_NOT_SYNCED", async () => {
    const s = await isBusinessOpenNow(BID, new Date("2026-09-07T10:00:00Z"));
    expect(s.open).toBe(false);
    expect(s.reason).toBe("no_hours_configured");
    await expect(assertBusinessOpenForCreate(BID, new Date("2026-09-07T10:00:00Z"))).rejects.toMatchObject({
      code: "HOURS_NOT_SYNCED",
    });
  });

  it("closed hours → assert throws BUSINESS_CLOSED, nothing else", async () => {
    await seedHours([entry(0, "08:00:00", "22:00:00")]);
    const err = await assertBusinessOpenForCreate(BID, new Date("2026-09-07T23:00:00Z")).catch((e) => e);
    expect(err).toBeInstanceOf(BusinessHoursError);
    expect(err.code).toBe("BUSINESS_CLOSED");
    expect(err.reason).toBe("outside_hours");
  });

  it("accepts bare-array payloads too", async () => {
    const db = await openSyncDatabase();
    await setReferenceData(db, BID, {
      key: "operating-hours",
      version: "v1",
      payload: [entry(0, "08:00:00", "22:00:00")],
      downloadedAt: new Date().toISOString(),
    });
    expect((await isBusinessOpenNow(BID, new Date("2026-09-07T10:00:00Z"))).open).toBe(true);
  });
});
