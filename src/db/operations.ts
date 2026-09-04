/**
 * Low-level SQLite operations for the command outbox and event journal.
 */

import type { SQLiteDatabase, SQLiteRunResult } from "../adapters/sqlite";
import type { Command, DomainEvent, PersistedCommand } from "../sync/types";
import { syncLogger } from "../utils/sync-logger";

// ─────────────────────────────────────────────────────────────
// Commands
// ─────────────────────────────────────────────────────────────

export interface InsertCommandInput {
  command: Command;
  status?: PersistedCommand["status"];
}

export async function insertCommand(
  db: SQLiteDatabase,
  input: InsertCommandInput,
): Promise<PersistedCommand> {
  const { command, status = "pending" } = input;
  const now = new Date().toISOString();
  const payload = JSON.stringify(command.payload);

  const result = await db.runAsync(
    `
      INSERT INTO commands (
        command_id, command_type, command_version, business_id, entity_id,
        user_id, device_id, payload, status, retry_count, last_attempted_at,
        created_at, updated_at
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
      ON CONFLICT(command_id) DO UPDATE SET
        status = excluded.status,
        payload = excluded.payload,
        updated_at = excluded.updated_at;
    `,
    command.command_id,
    command.command_type,
    command.command_version,
    command.business_id,
    command.entity_id ?? null,
    command.user_id,
    command.device_id,
    payload,
    status,
    0,
    null,
    now,
    now,
  );

  const row = await db.getFirstAsync<PersistedCommandRow>(
    "SELECT * FROM commands WHERE id = ?;",
    result.lastInsertRowId,
  );

  if (!row) {
    throw new Error(`Failed to insert command ${command.command_id}`);
  }

  syncLogger.command(command, "queued");
  return rowToPersistedCommand(row);
}

export async function getPendingCommands(
  db: SQLiteDatabase,
  limit = 100,
): Promise<PersistedCommand[]> {
  const rows = await db.getAllAsync<PersistedCommandRow>(
    `
      SELECT * FROM commands
      WHERE status IN ('pending', 'failed')
      ORDER BY created_at ASC
      LIMIT ?;
    `,
    limit,
  );
  return rows.map(rowToPersistedCommand);
}

export async function updateCommandStatus(
  db: SQLiteDatabase,
  commandId: string,
  status: PersistedCommand["status"],
  error?: string,
): Promise<void> {
  const now = new Date().toISOString();
  if (status === "failed") {
    await db.runAsync(
      `
        UPDATE commands
        SET status = ?, error = ?, retry_count = retry_count + 1,
            last_attempted_at = ?, updated_at = ?
        WHERE command_id = ?;
      `,
      status,
      error ?? null,
      now,
      now,
      commandId,
    );
  } else if (status === "completed") {
    await db.runAsync(
      "UPDATE commands SET status = ?, error = NULL, updated_at = ? WHERE command_id = ?;",
      status,
      now,
      commandId,
    );
  } else {
    await db.runAsync(
      "UPDATE commands SET status = ?, error = ?, updated_at = ? WHERE command_id = ?;",
      status,
      error ?? null,
      now,
      commandId,
    );
  }

  syncLogger.debug("CommandOutbox", "Status updated", { commandId, status });
}

export async function markCommandInFlight(
  db: SQLiteDatabase,
  commandId: string,
): Promise<void> {
  const now = new Date().toISOString();
  await db.runAsync(
    `
      UPDATE commands
      SET status = 'in_flight', last_attempted_at = ?, updated_at = ?
      WHERE command_id = ?;
    `,
    now,
    now,
    commandId,
  );
}

export async function deleteCommand(
  db: SQLiteDatabase,
  commandId: string,
): Promise<void> {
  await db.runAsync("DELETE FROM commands WHERE command_id = ?;", commandId);
}

export async function clearCompletedCommands(
  db: SQLiteDatabase,
  olderThanHours = 24,
): Promise<void> {
  const cutoff = new Date(Date.now() - olderThanHours * 60 * 60 * 1000).toISOString();
  await db.runAsync(
    "DELETE FROM commands WHERE status = 'completed' AND updated_at < ?;",
    cutoff,
  );
}

// ─────────────────────────────────────────────────────────────
// Events
// ─────────────────────────────────────────────────────────────

export interface InsertEventInput {
  event: DomainEvent;
  origin: "local" | "cloud" | "lan";
  syncedToCloud?: boolean;
}

export async function insertEvent(
  db: SQLiteDatabase,
  input: InsertEventInput,
): Promise<void> {
  const { event, origin, syncedToCloud = false } = input;
  await db.runAsync(
    `
      INSERT INTO events (
        event_id, event_type, event_version, entity_id, user_id, device_id,
        payload, origin, synced_to_cloud, timestamp, persisted_at
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
      ON CONFLICT(event_id) DO NOTHING;
    `,
    event.event_id,
    event.event_type,
    event.event_version,
    event.entity_id,
    event.user_id,
    event.device_id,
    JSON.stringify(event.payload),
    origin,
    syncedToCloud ? 1 : 0,
    event.timestamp,
    new Date().toISOString(),
  );

  syncLogger.event(event, "persisted", { origin, syncedToCloud });
}

export async function getEventsForEntity(
  db: SQLiteDatabase,
  entityId: string,
  limit = 100,
): Promise<DomainEvent[]> {
  const rows = await db.getAllAsync<EventRow>(
    `
      SELECT * FROM events
      WHERE entity_id = ?
      ORDER BY timestamp ASC
      LIMIT ?;
    `,
    entityId,
    limit,
  );
  return rows.map(rowToDomainEvent);
}

export async function getUnsyncedEvents(
  db: SQLiteDatabase,
  origin: "local" | "lan" = "local",
  limit = 100,
): Promise<DomainEvent[]> {
  const rows = await db.getAllAsync<EventRow>(
    `
      SELECT * FROM events
      WHERE origin = ? AND synced_to_cloud = 0
      ORDER BY timestamp ASC
      LIMIT ?;
    `,
    origin,
    limit,
  );
  return rows.map(rowToDomainEvent);
}

export async function markEventsSynced(
  db: SQLiteDatabase,
  eventIds: string[],
): Promise<void> {
  if (eventIds.length === 0) return;
  const placeholders = eventIds.map(() => "?").join(",");
  await db.runAsync(
    `UPDATE events SET synced_to_cloud = 1 WHERE event_id IN (${placeholders});`,
    ...eventIds,
  );
}

// ─────────────────────────────────────────────────────────────
// Entity snapshots (local read model)
// ─────────────────────────────────────────────────────────────

export interface EntitySnapshot<T = unknown> {
  entity_type: string;
  entity_id: string;
  business_id: string | null;
  last_event_id: string;
  last_event_timestamp: string;
  payload: T;
}

interface EntitySnapshotRow {
  entity_type: string;
  entity_id: string;
  business_id: string | null;
  last_event_id: string;
  last_event_timestamp: string;
  payload: string;
}

function rowToEntitySnapshot<T>(row: EntitySnapshotRow): EntitySnapshot<T> {
  return {
    entity_type: row.entity_type,
    entity_id: row.entity_id,
    business_id: row.business_id,
    last_event_id: row.last_event_id,
    last_event_timestamp: row.last_event_timestamp,
    payload: JSON.parse(row.payload) as T,
  };
}

export interface UpsertEntitySnapshotInput<T = unknown> {
  entityType: string;
  entityId: string;
  businessId?: string | null;
  lastEventId: string;
  lastEventTimestamp: string;
  payload: T;
}

export async function upsertEntitySnapshot<T>(
  db: SQLiteDatabase,
  input: UpsertEntitySnapshotInput<T>,
): Promise<void> {
  const {
    entityType,
    entityId,
    businessId = null,
    lastEventId,
    lastEventTimestamp,
    payload,
  } = input;

  const existing = await db.getFirstAsync<EntitySnapshotRow>(
    "SELECT last_event_timestamp FROM entity_snapshots WHERE entity_type = ? AND entity_id = ?;",
    entityType,
    entityId,
  );

  if (existing && existing.last_event_timestamp > lastEventTimestamp) {
    return;
  }

  await db.runAsync(
    `
      INSERT INTO entity_snapshots (entity_type, entity_id, business_id, last_event_id, last_event_timestamp, payload)
      VALUES (?, ?, ?, ?, ?, ?)
      ON CONFLICT(entity_type, entity_id) DO UPDATE SET
        business_id = excluded.business_id,
        last_event_id = excluded.last_event_id,
        last_event_timestamp = excluded.last_event_timestamp,
        payload = excluded.payload;
    `,
    entityType,
    entityId,
    businessId,
    lastEventId,
    lastEventTimestamp,
    JSON.stringify(payload),
  );
}

export async function getEntitySnapshot<T>(
  db: SQLiteDatabase,
  entityType: string,
  entityId: string,
  businessId?: string | null,
): Promise<EntitySnapshot<T> | null> {
  if (businessId) {
    const row = await db.getFirstAsync<EntitySnapshotRow>(
      "SELECT * FROM entity_snapshots WHERE entity_type = ? AND entity_id = ? AND business_id = ?;",
      entityType,
      entityId,
      businessId,
    );
    if (row) return rowToEntitySnapshot<T>(row);
  }
  const row = await db.getFirstAsync<EntitySnapshotRow>(
    "SELECT * FROM entity_snapshots WHERE entity_type = ? AND entity_id = ?;",
    entityType,
    entityId,
  );
  return row ? rowToEntitySnapshot<T>(row) : null;
}

export async function getEntitySnapshotsByType<T>(
  db: SQLiteDatabase,
  entityType: string,
  businessId?: string | null,
): Promise<EntitySnapshot<T>[]> {
  if (businessId) {
    const rows = await db.getAllAsync<EntitySnapshotRow>(
      "SELECT * FROM entity_snapshots WHERE entity_type = ? AND business_id = ? ORDER BY last_event_timestamp DESC;",
      entityType,
      businessId,
    );
    return rows.map(rowToEntitySnapshot<T>);
  }
  const rows = await db.getAllAsync<EntitySnapshotRow>(
    "SELECT * FROM entity_snapshots WHERE entity_type = ? ORDER BY last_event_timestamp DESC;",
    entityType,
  );
  return rows.map(rowToEntitySnapshot<T>);
}

export async function deleteEntitySnapshot(
  db: SQLiteDatabase,
  entityType: string,
  entityId: string,
): Promise<void> {
  await db.runAsync(
    "DELETE FROM entity_snapshots WHERE entity_type = ? AND entity_id = ?;",
    entityType,
    entityId,
  );
}

export async function pruneEntitySnapshots(
  db: SQLiteDatabase,
  entityType: string,
  cutoffIso: string,
): Promise<void> {
  await db.runAsync(
    "DELETE FROM entity_snapshots WHERE entity_type = ? AND last_event_timestamp < ?;",
    entityType,
    cutoffIso,
  );
}

// ─────────────────────────────────────────────────────────────
// Row mappers
// ─────────────────────────────────────────────────────────────

interface PersistedCommandRow {
  id: number;
  command_id: string;
  command_type: string;
  command_version: string;
  business_id: string;
  entity_id: string | null;
  user_id: string;
  device_id: string;
  payload: string;
  status: PersistedCommand["status"];
  error: string | null;
  retry_count: number;
  last_attempted_at: string | null;
  timestamp: string;
  created_at: string;
  updated_at: string;
}

function rowToPersistedCommand(row: PersistedCommandRow): PersistedCommand {
  return {
    id: row.id,
    command_id: row.command_id,
    command_type: row.command_type,
    command_version: row.command_version,
    business_id: row.business_id,
    entity_id: row.entity_id ?? undefined,
    user_id: row.user_id,
    device_id: row.device_id,
    payload: JSON.parse(row.payload),
    status: row.status,
    error: row.error,
    retry_count: row.retry_count,
    last_attempted_at: row.last_attempted_at ?? undefined,
    timestamp: row.timestamp,
    created_at: row.created_at,
    updated_at: row.updated_at,
  };
}

interface EventRow {
  event_id: string;
  event_type: string;
  event_version: string;
  entity_id: string;
  user_id: string;
  device_id: string;
  payload: string;
  origin: "local" | "cloud" | "lan";
  synced_to_cloud: number;
  timestamp: string;
  persisted_at: string;
}

function rowToDomainEvent(row: EventRow): DomainEvent {
  return {
    event_id: row.event_id,
    event_type: row.event_type,
    event_version: row.event_version,
    entity_id: row.entity_id,
    user_id: row.user_id,
    device_id: row.device_id,
    payload: JSON.parse(row.payload),
    timestamp: row.timestamp,
  };
}

// ─────────────────────────────────────────────────────────────
// Maintenance — clear stale local data (used by Diagnostics)
// ─────────────────────────────────────────────────────────────

export async function clearAllSyncData(db: SQLiteDatabase): Promise<void> {
  await db.execAsync(`DELETE FROM commands;`);
  await db.execAsync(`DELETE FROM events;`);
  await db.execAsync(`DELETE FROM entity_snapshots;`);
  // Keep reference_data — it is business-scoped and expensive to re-fetch;
  // only order/command state is cleared. If full wipe needed, call
  // clearReferenceData below.
}

export async function clearReferenceData(db: SQLiteDatabase): Promise<void> {
  await db.execAsync(`DELETE FROM reference_data;`);
}

export async function clearCompletedCommandsAndOrphans(db: SQLiteDatabase): Promise<void> {
  await db.execAsync(`DELETE FROM commands WHERE status = 'completed';`);
  try {
    await db.execAsync(`DELETE FROM commands WHERE payload LIKE '%TFL-%';`);
  } catch {}
  try {
    await db.execAsync(`DELETE FROM events WHERE payload LIKE '%TFL-%';`);
  } catch {}
}
