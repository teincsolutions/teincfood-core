/**
 * Preserve local menu intent while a reference pull is in flight.
 *
 * A full reference pull can arrive *after* a local edit but *before* the
 * outbox has replayed it. Without this guard the server's stale row would
 * briefly overwrite the local row (then flip back after replay), which is
 * exactly the "it reappeared" bug users see. The outbox is the source of
 * truth for unsynced intent, so its final operation per entity wins during a
 * merge:
 *
 *   - pending delete -> drop the server row
 *   - pending create/update -> keep the local row (or re-add a local create)
 *
 * Once the command is replayed it leaves the outbox and the next pull is
 * authoritative again.
 */

import type { SQLiteDatabase } from "../adapters/sqlite";
import type { ReferenceDataKey } from "./types";

interface CommandRow {
  command_type: string;
  entity_id: string | null;
  payload: string | null;
}

interface CollectionCommands {
  create: string;
  update: string;
  delete: string;
}

const COLLECTIONS: Partial<Record<ReferenceDataKey, CollectionCommands>> = {
  "menu:items": {
    create: "menu:create_item",
    update: "menu:update_item",
    delete: "menu:delete_item",
  },
  "menu:categories": {
    create: "menu:create_category",
    update: "menu:update_category",
    delete: "menu:delete_category",
  },
};

interface PendingOp {
  kind: "keep" | "delete";
  local?: unknown;
}

function rowId(row: unknown): string | null {
  const id = (row as { id?: unknown } | null | undefined)?.id;
  return id == null ? null : String(id);
}

function rowsOf(payload: unknown): unknown[] | null {
  if (Array.isArray(payload)) return payload;
  if (!payload || typeof payload !== "object") return null;
  const data = (payload as { data?: unknown }).data;
  return Array.isArray(data) ? data : null;
}

function withRows(payload: unknown, rows: unknown[]): unknown {
  if (Array.isArray(payload)) return rows;
  return { ...(payload as Record<string, unknown>), data: rows };
}

function cacheRecordFrom(row: CommandRow): unknown {
  if (!row.payload) return undefined;
  try {
    const parsed = JSON.parse(row.payload) as { cacheRecord?: unknown };
    return parsed?.cacheRecord;
  } catch {
    return undefined;
  }
}

export async function applyPendingLocalMenuChanges<T>(
  db: SQLiteDatabase,
  businessId: string,
  key: ReferenceDataKey,
  incoming: T,
  localPayload: unknown,
): Promise<T> {
  const spec = COLLECTIONS[key];
  if (!spec || !businessId) return incoming;

  const incomingRows = rowsOf(incoming);
  if (!incomingRows) return incoming;

  const commands = await db.getAllAsync<CommandRow>(
    `
      SELECT command_type, entity_id, payload
      FROM commands
      WHERE business_id = ?
        AND status IN ('pending', 'in_flight')
        AND command_type IN (?, ?, ?)
      ORDER BY created_at ASC, rowid ASC;
    `,
    businessId,
    spec.create,
    spec.update,
    spec.delete,
  );
  if (commands.length === 0) return incoming;

  // The last command per entity describes the current local intent.
  const ops = new Map<string, PendingOp>();
  for (const command of commands) {
    const id = command.entity_id;
    if (!id) continue;
    if (command.command_type === spec.delete) {
      ops.set(String(id), { kind: "delete" });
    } else {
      ops.set(String(id), {
        kind: "keep",
        local: cacheRecordFrom(command),
      });
    }
  }

  const localRows = rowsOf(localPayload);
  const localById = new Map<string, unknown>();
  for (const row of localRows ?? []) {
    const id = rowId(row);
    if (id) localById.set(id, row);
  }

  let rows = incomingRows.filter((row) => {
    const id = rowId(row);
    return !id || ops.get(id)?.kind !== "delete";
  });

  for (const [id, op] of ops) {
    if (op.kind !== "keep") continue;
    const local = localById.get(id) ?? op.local;
    if (!local) continue;
    const index = rows.findIndex((row) => rowId(row) === id);
    if (index >= 0) rows = rows.map((row, i) => (i === index ? local : row));
    else rows = [local, ...rows];
  }

  return withRows(incoming, rows) as T;
}
