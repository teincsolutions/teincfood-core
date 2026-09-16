/**
 * SQLite operations for the business-scoped reference data cache.
 */

import type { SQLiteDatabase } from "../adapters/sqlite";
import type { ReferenceDataKey, ReferenceDataRecord } from "./types";
import { compareHLCString, hlcToString, tickHLC, hlcFromString } from "../utils/hlc";
import { generateUUID } from "../utils/uuid";
import { openSyncDatabase } from "../db/connection";
import type { OperatingHoursEntry } from "../types/api/business.api";
import { getAppInstanceId } from "../adapters/devices";
import { notifyDbChange } from "../db/operations";
import { isServerAuthoritativeKey } from "./entitlements";

export async function getReferenceData<T>(
  db: SQLiteDatabase,
  businessId: string,
  key: ReferenceDataKey,
): Promise<ReferenceDataRecord<T> | null> {
  const row = await db.getFirstAsync<{
    key: string;
    version: string;
    payload: string;
    downloaded_at: string;
    last_event_id?: string | null;
    last_hlc?: string | null;
  }>(
    "SELECT * FROM reference_data WHERE business_id = ? AND key = ?;",
    businessId,
    key,
  );

  if (!row) return null;

  return {
    key: row.key as ReferenceDataKey,
    version: row.version,
    payload: JSON.parse(row.payload) as T,
    downloadedAt: row.downloaded_at,
    lastEventId: row.last_event_id ?? null,
    lastHlc: row.last_hlc ?? null,
  };
}

export async function getReferenceVersion(
  db: SQLiteDatabase,
  businessId: string,
  key: ReferenceDataKey,
): Promise<string | null> {
  const row = await db.getFirstAsync<{ version: string }>(
    "SELECT version FROM reference_data WHERE business_id = ? AND key = ?;",
    businessId,
    key,
  );
  return row?.version ?? null;
}

export async function setReferenceData<T>(
  db: SQLiteDatabase,
  businessId: string,
  record: ReferenceDataRecord<T>,
): Promise<void> {
  await db.runAsync(
    `
      INSERT INTO reference_data (business_id, key, version, payload, downloaded_at, last_event_id, last_hlc)
      VALUES (?, ?, ?, ?, ?, ?, ?)
      ON CONFLICT(business_id, key) DO UPDATE SET
        version = excluded.version,
        payload = excluded.payload,
        downloaded_at = excluded.downloaded_at,
        last_event_id = excluded.last_event_id,
        last_hlc = excluded.last_hlc;
    `,
    businessId,
    record.key,
    record.version,
    JSON.stringify(record.payload),
    record.downloadedAt,
    record.lastEventId ?? null,
    record.lastHlc ?? null,
  );
  notifyDbChange(businessId, `reference_data:${record.key}`);
}

export async function mergeReferenceData<T extends Record<string, unknown>>(
  db: SQLiteDatabase,
  businessId: string,
  key: ReferenceDataKey,
  incoming: Record<string, unknown>,
  hlc: string,
  eventId: string,
): Promise<void> {
  // Server-authoritative keys (subscription:entitlements) never merge locally:
  // LWW poisoning via a forged future HLC would otherwise stick forever.
  // Use writeServerReferenceData() for the verified server path instead.
  if (isServerAuthoritativeKey(key)) return;
  const existing = await getReferenceData<T>(db, businessId, key);
  if (!existing) {
    await setReferenceData(db, businessId, {
      key,
      version: hlc,
      payload: incoming as T,
      downloadedAt: new Date().toISOString(),
      lastEventId: eventId,
      lastHlc: hlc,
    });
    return;
  }
  // If incoming HLC is older, keep existing (LWW per key)
  if (existing.lastHlc && compareHLCString(hlc, existing.lastHlc) <= 0) {
    // Still allow partial field merge if payload is LWWMap shaped
    return;
  }
  await setReferenceData(db, businessId, {
    key,
    version: hlc,
    payload: incoming as T,
    downloadedAt: new Date().toISOString(),
    lastEventId: eventId,
    lastHlc: hlc,
  });
}

/**
 * Server-authoritative write for verified payloads (subscription:entitlements).
 * Overwrites only when the incoming server version is newer — a stale or
 * replayed envelope can never rewind the cache. Local callers must never use
 * set/mergeReferenceData for these keys.
 */
export async function writeServerReferenceData<T>(
  db: SQLiteDatabase,
  businessId: string,
  key: ReferenceDataKey,
  payload: T,
  serverVersion: string,
): Promise<boolean> {
  const existing = await getReferenceData<T>(db, businessId, key);
  if (existing && compareHLCString(serverVersion, existing.version) <= 0) return false;
  await setReferenceData(db, businessId, {
    key,
    version: serverVersion,
    payload,
    downloadedAt: new Date().toISOString(),
    lastEventId: `server_${serverVersion}`,
    lastHlc: serverVersion,
  });
  return true;
}

export async function deleteReferenceData(
  db: SQLiteDatabase,
  businessId: string,
  key: ReferenceDataKey,
): Promise<void> {
  await db.runAsync(
    "DELETE FROM reference_data WHERE business_id = ? AND key = ?;",
    businessId,
    key,
  );
}

export async function deleteReferenceDataForBusiness(
  db: SQLiteDatabase,
  businessId: string,
): Promise<void> {
  await db.runAsync(
    "DELETE FROM reference_data WHERE business_id = ?;",
    businessId,
  );
}

export async function getAllReferenceDataKeys(
  db: SQLiteDatabase,
  businessId: string,
): Promise<ReferenceDataKey[]> {
  const rows = await db.getAllAsync<{ key: string }>(
    "SELECT key FROM reference_data WHERE business_id = ? ORDER BY key;",
    businessId,
  );
  return rows.map((r) => r.key as ReferenceDataKey);
}

async function enqueueReferenceSyncJob(
  businessId: string,
  key: import("./types").ReferenceDataKey,
  hlc: string,
): Promise<void> {
  try {
    const db = await openSyncDatabase();
    const id = generateUUID();
    const now = new Date().toISOString();
    await db.runAsync(
      `INSERT OR IGNORE INTO sync_jobs (id, business_id, command_type, entity_id, payload, status, created_at, updated_at, attempts, last_error) VALUES (?, ?, ?, ?, ?, 'pending', ?, ?, 0, NULL);`,
      id,
      businessId,
      "reference:sync",
      key,
      JSON.stringify({ key, hlc }),
      now,
      now,
    );
  } catch {}
}

export async function setOperatingHoursLocal(
  businessId: string,
  entries: OperatingHoursEntry[],
): Promise<void> {
  const db = await openSyncDatabase();
  const payload = { data: entries };
  const now = new Date().toISOString();
  // HLC ensures local edit wins over stale server pull via LWW
  const existing = await getReferenceData(db, businessId, "operating-hours");
  const lastHlc = existing?.lastHlc ? hlcFromString(existing.lastHlc) : null;
  const hlcStr = hlcToString(tickHLC(Date.now(), lastHlc, getAppInstanceId()));
  await mergeReferenceData(db, businessId, "operating-hours", payload as unknown as Record<string, unknown>, hlcStr, `evt_${hlcStr}`);
  await enqueueReferenceSyncJob(businessId, "operating-hours", hlcStr);
}

export async function setBusinessProfileLocal(
  businessId: string,
  profile: Record<string, unknown>,
): Promise<void> {
  const db = await openSyncDatabase();
  const payload = { data: profile };
  const existing = await getReferenceData(db, businessId, "business:profile");
  const lastHlc = existing?.lastHlc ? hlcFromString(existing.lastHlc) : null;
  const hlcStr = hlcToString(tickHLC(Date.now(), lastHlc, getAppInstanceId()));
  await mergeReferenceData(db, businessId, "business:profile", payload as unknown as Record<string, unknown>, hlcStr, `evt_${hlcStr}`);
  await enqueueReferenceSyncJob(businessId, "business:profile", hlcStr);
}
