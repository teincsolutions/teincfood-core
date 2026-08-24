/**
 * SQLite operations for the business-scoped reference data cache.
 */

import type { SQLiteDatabase } from "../adapters/sqlite";
import type { ReferenceDataKey, ReferenceDataRecord } from "./types";

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
      INSERT INTO reference_data (business_id, key, version, payload, downloaded_at)
      VALUES (?, ?, ?, ?, ?)
      ON CONFLICT(business_id, key) DO UPDATE SET
        version = excluded.version,
        payload = excluded.payload,
        downloaded_at = excluded.downloaded_at;
    `,
    businessId,
    record.key,
    record.version,
    JSON.stringify(record.payload),
    record.downloadedAt,
  );
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
