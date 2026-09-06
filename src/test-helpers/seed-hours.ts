/**
 * Test helper — seeds 24/7 operating hours into SQLite reference_data.
 * Creation is fail-closed: without cached hours every create throws
 * HOURS_NOT_SYNCED, so tests that create orders must seed first.
 */
import { openSyncDatabase } from "../db/connection";
import { setReferenceData } from "../reference/operations";

export async function seedOpenHours(businessId: string): Promise<void> {
  const db = await openSyncDatabase();
  const entries = Array.from({ length: 7 }, (_, dayOfWeek) => ({
    day_of_week: dayOfWeek,
    // "24:00:00" close keeps string-compare open for the whole UTC day.
    open_time: "00:00:00",
    close_time: "24:00:00",
    is_closed: false,
  }));
  await setReferenceData(db, businessId, {
    key: "operating-hours",
    version: "test-open",
    payload: { data: entries },
    downloadedAt: new Date().toISOString(),
  });
}
