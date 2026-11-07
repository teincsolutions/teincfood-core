/**
 * Delete tombstones for mutable reference collections.
 *
 * LWW alone is not enough for deletes: a stale full-array pull would simply
 * re-add a row that was removed on this device. A tombstone records the
 * deletion locally so every reference write filters it out until either:
 *
 *   - a newer record with the same id arrives (server clock wins), or
 *   - the user recreates the row locally (explicit local intent wins).
 *
 * Collections are keyed by reference-data key today. The same table will be
 * used by the per-record HLC migration for menu/category/settings data.
 */

import type { SQLiteDatabase } from "../adapters/sqlite";
import { getAppInstanceId } from "../adapters/devices";
import type { ReferenceDataKey } from "./types";

const TOMBSTONE_COLLECTIONS: Partial<Record<ReferenceDataKey, string>> = {
  "menu:items": "menu:items",
  "menu:categories": "menu:categories",
};

export function tombstoneCollectionFor(
  key: ReferenceDataKey,
): string | null {
  return TOMBSTONE_COLLECTIONS[key] ?? null;
}

export async function markRecordDeleted(
  db: SQLiteDatabase,
  businessId: string,
  key: ReferenceDataKey,
  entityId: string,
  deletedAt: string,
  deviceId = getAppInstanceId(),
): Promise<void> {
  const collection = tombstoneCollectionFor(key);
  if (!collection || !businessId || !entityId) return;
  await db.runAsync(
    `
      INSERT INTO record_tombstones (
        business_id, collection, entity_id, deleted_at, device_id
      ) VALUES (?, ?, ?, ?, ?)
      ON CONFLICT(business_id, collection, entity_id) DO UPDATE SET
        deleted_at = excluded.deleted_at,
        device_id = excluded.device_id
      WHERE excluded.deleted_at > record_tombstones.deleted_at;
    `,
    businessId,
    collection,
    String(entityId),
    deletedAt,
    deviceId,
  );
}

export async function clearRecordTombstone(
  db: SQLiteDatabase,
  businessId: string,
  key: ReferenceDataKey,
  entityId: string,
): Promise<void> {
  const collection = tombstoneCollectionFor(key);
  if (!collection || !businessId || !entityId) return;
  await db.runAsync(
    "DELETE FROM record_tombstones WHERE business_id = ? AND collection = ? AND entity_id = ?;",
    businessId,
    collection,
    String(entityId),
  );
}

interface TombstoneRow {
  entity_id: string;
  deleted_at: string;
}

function rowId(row: unknown): string | null {
  const id = (row as { id?: unknown } | null | undefined)?.id;
  return id == null ? null : String(id);
}

function rowStamp(row: unknown): number {
  const rec = row as
    | { updated_at?: unknown; inserted_at?: unknown }
    | null
    | undefined;
  const raw = rec?.updated_at ?? rec?.inserted_at;
  const parsed = typeof raw === "string" ? Date.parse(raw) : NaN;
  return Number.isNaN(parsed) ? 0 : parsed;
}

/**
 * Filter a reference payload against local delete tombstones.
 *
 * A row whose `updated_at` is newer than the tombstone is a real recreation
 * (for example, another device re-created the same id) and wins; its
 * tombstone is cleared. Everything else stays deleted locally.
 */
export async function applyTombstonesToPayload<T>(
  db: SQLiteDatabase,
  businessId: string,
  key: ReferenceDataKey,
  payload: T,
): Promise<T> {
  const collection = tombstoneCollectionFor(key);
  if (!collection || !businessId || payload == null) return payload;

  const tombstones = await db.getAllAsync<TombstoneRow>(
    "SELECT entity_id, deleted_at FROM record_tombstones WHERE business_id = ? AND collection = ?;",
    businessId,
    collection,
  );
  if (tombstones.length === 0) return payload;

  const deletedAt = new Map(
    tombstones.map((row) => [row.entity_id, row.deleted_at] as const),
  );
  const resurrected: string[] = [];

  const filterRows = (rows: unknown[]): unknown[] =>
    rows.filter((row) => {
      const id = rowId(row);
      if (!id) return true;
      const deleted = deletedAt.get(id);
      if (!deleted) return true;
      if (rowStamp(row) > Date.parse(deleted)) {
        resurrected.push(id);
        return true;
      }
      return false;
    });

  let next: T = payload;
  if (Array.isArray(payload)) {
    next = filterRows(payload) as T;
  } else if (typeof payload === "object") {
    const obj = payload as Record<string, unknown>;
    if (Array.isArray(obj.data)) {
      next = { ...obj, data: filterRows(obj.data) } as T;
    }
  }

  if (resurrected.length > 0) {
    for (const id of resurrected) {
      await clearRecordTombstone(db, businessId, key, id);
    }
  }

  return next;
}
